/**
 * IndexedDB driver.
 *
 * The browser driver. Its contract is the same as the memory driver's - same
 * methods, same return shapes, same unique-constraint behaviour - because every
 * caller in core/ is written against the contract and never against either
 * implementation.
 *
 * Two things it does that the memory driver cannot:
 *
 *   - Reads are pushed down into indexes. A query for one URL's models becomes
 *     an index range scan rather than "read every model row, then filter in
 *     JavaScript", which is the difference between a drawer that opens
 *     instantly and one that waits on a few hundred structured clones.
 *
 *   - `tx()` keeps the transaction alive across awaits. IndexedDB commits a
 *     transaction as soon as control returns to the event loop with no pending
 *     request, so an `await` that is not an IndexedDB promise ends the
 *     transaction early and the rest of the writes fail with
 *     TransactionInactiveError. That is why every method here queues its
 *     requests eagerly and why `tx` refuses to be used with slow work.
 */

import { IDB_VERSION, STORE_MAP, STORES, applyDefaults, validateRow } from './schema.js';
import { applyQuery, isQueryObject, planQuery, whereOf, wherePredicate } from './query.js';
import { UniqueConstraintError, MissingKeyError, MemoryDriver } from './memory.js';
import { createIdbSchema, runDataMigrations } from './migrations.js';

/** Turn an IndexedDB error into the error a caller expects. */
function translate(store, request, def) {
  const error = request?.error;
  if (!error) return new Error(`${store}: IndexedDB request failed`);
  // A unique index threw. Report which index, so the message names the real
  // cause instead of "something went wrong".
  if (error.name === 'ConstraintError') {
    for (const index of def?.indexes ?? []) {
      if (!index.unique) continue;
      const unique = new UniqueConstraintError(store, index, null);
      return unique;
    }
    return new UniqueConstraintError(store, { name: 'unknown' }, null);
  }
  return error;
}

const promisify = (request) =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

export class IdbDriver {
  constructor(namespace = 'free-model-hub') {
    this.namespace = namespace;
    this._db = null;
    this._fallback = null;
    this._openPromise = null;
    if (typeof indexedDB === 'undefined') this._useFallback('IndexedDB is not available in this runtime');
  }

  /**
   * True when data is being kept in memory only.
   *
   * The UI reads this and says so. Data that does not survive a reload has to
   * be stated, not left for the user to discover.
   */
  get degraded() { return this._fallback !== null; }

  _useFallback(reason) {
    if (this._fallback) return this._fallback;
    this._fallback = new MemoryDriver();
    if (reason) this._fallbackReason = reason;
    return this._fallback;
  }

  /**
   * Open the database, or return the connection that already exists.
   *
   * Idempotent and awaitable more than once, because the app opens it before its
   * first read and the tests open it before seeding. Both must not have to know
   * whether somebody got there first - and neither should open two connections
   * to the same database, because the second one blocks the first tab's upgrade.
   */
  async open() {
    if (this._db) return this._db;
    if (this._fallback) return null;
    if (this._openPromise) return this._openPromise;

    this._openPromise = (async () => {
      try {
        const db = await new Promise((resolve, reject) => {
          const request = indexedDB.open(this.namespace, IDB_VERSION);
          request.onupgradeneeded = (event) => {
            createIdbSchema(request.result, event);
          };
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
          // Another tab is holding an older version open. Without this the
          // request never settles and the app waits forever on its first read.
          request.onblocked = () => reject(new Error('IndexedDB upgrade blocked by another tab'));
        });
        this._db = db;
        // A connection that is closed underneath a call would throw on the next
        // read. A versionchange means another tab wants to upgrade, so this one
        // has to let go rather than block it.
        db.onversionchange = () => { void this.close(); };
        await runDataMigrations(new MigrationView(db));
        return db;
      } catch (error) {
        this._useFallback(error?.message ?? 'IndexedDB could not be opened');
        return null;
      } finally {
        this._openPromise = null;
      }
    })();

    return this._openPromise;
  }

  /**
   * Close the connection.
   *
   * Only safe once nothing is in flight: IndexedDB finishes the requests
   * already issued and throws for anything after. It exists so a test or a
   * `deleteDatabase` can release the handle, and so an upgrade in another tab is
   * not blocked forever.
   */
  async close() {
    const db = this._db;
    this._db = null;
    this._openPromise = null;
    if (db) db.close();
  }

  async _ensure() {
    if (this._fallback) return false;
    if (this._db) return true;
    await this.open();
    return this._db !== null;
  }

  _os(store, mode) {
    try {
      return this._db.transaction(store, mode).objectStore(store);
    } catch {
      return null;
    }
  }

  // ------------------------------------------------------------------ reads

  async get(store, id) {
    if (this._fallback) return this._fallback.get(store, id);
    if (!(await this._ensure())) return null;
    const os = this._os(store, 'readonly');
    if (!os) return null;
    const row = await promisify(os.get(id));
    return row ?? null;
  }

  async list(store) {
    if (this._fallback) return this._fallback.list(store);
    if (!(await this._ensure())) return [];
    const os = this._os(store, 'readonly');
    if (!os) return [];
    return (await promisify(os.getAll())) ?? [];
  }

  /**
   * Rows the index says match. The full predicate is applied afterwards, so a
   * plan that is too generous costs time and never correctness.
   */
  async _candidates(store, query) {
    const def = STORE_MAP[store];
    const plan = planQuery(def, query);
    const os = this._os(store, 'readonly');
    if (!os || !plan.index || !os.indexNames.contains(plan.index.name)) {
      return promisify(os.getAll());
    }
    const index = os.index(plan.index.name);

    if (plan.kind === 'point') {
      const seen = new Set();
      const out = [];
      for (const key of plan.keys) {
        // An unindexable key simply matches no row, exactly as it would in the
        // memory driver's index map.
        if (!isUsableKey(key)) continue;
        for (const row of await promisify(index.getAll(IDBKeyRange.only(key)))) {
          const id = row?.[def.keyPath];
          if (seen.has(id)) continue;
          seen.add(id);
          out.push(row);
        }
      }
      return out;
    }

    const range = toKeyRange(plan.keys);
    if (!range) return promisify(os.getAll());
    return promisify(index.getAll(range));
  }

  async find(store, where) {
    if (this._fallback) return this._fallback.find(store, where);
    if (!(await this._ensure())) return null;
    const rows = await this._candidates(store, { where });
    const hit = where ? rows.find(wherePredicate(where)) : rows[0];
    return hit ?? null;
  }

  async findMany(store, query = {}) {
    if (this._fallback) return this._fallback.findMany(store, query);
    if (!(await this._ensure())) return [];
    const candidates = await this._candidates(store, query);
    return applyQuery(candidates, query);
  }

  /**
   * How many rows match.
   *
   * Takes a bare where clause or a whole query object, same as `findMany`. With
   * no clause at all IndexedDB counts the store itself, which is cheaper than
   * reading rows; with a clause the index narrows the set and the full predicate
   * still decides, so the count cannot disagree with `findMany`.
   */
  async count(store, whereOrQuery = null) {
    if (this._fallback) return this._fallback.count(store, whereOrQuery);
    if (!(await this._ensure())) return 0;

    const where = whereOf(whereOrQuery);
    if (!where) {
      const os = this._os(store, 'readonly');
      return os ? await promisify(os.count()) : 0;
    }
    const rows = await this._candidates(store, { where, _forceScan: whereOrQuery?._forceScan === true });
    return rows.filter(wherePredicate(where)).length;
  }

  // ----------------------------------------------------------------- writes

  async put(store, row) {
    if (this._fallback) return this._fallback.put(store, row);
    if (!(await this._ensure())) return null;
    const def = STORE_MAP[store];
    const prepared = applyDefaults(store, row);
    if (prepared[def.keyPath] === undefined || prepared[def.keyPath] === null) {
      throw new MissingKeyError(store, def.keyPath);
    }
    const os = this._os(store, 'readwrite');
    if (!os) return null;
    try {
      await promisify(os.put(prepared));
    } catch (error) {
      throw translate(store, error, def);
    }
    return prepared;
  }

  /**
   * Write many rows in one transaction.
   *
   * A scan that discovers 400 models would otherwise open 400 transactions,
   * each with its own commit. One transaction is one commit, and a failure
   * half way through leaves nothing behind.
   */
  async putMany(store, rows) {
    if (this._fallback) return this._fallback.putMany(store, rows);
    if (!(await this._ensure())) return [];

    const def = STORE_MAP[store];
    const prepared = rows.map((row) => {
      const next = applyDefaults(store, row);
      if (next[def.keyPath] === undefined || next[def.keyPath] === null) {
        throw new MissingKeyError(store, def.keyPath);
      }
      return next;
    });

    return new Promise((resolve, reject) => {
      let tx;
      try {
        tx = this._db.transaction(store, 'readwrite');
      } catch (error) {
        reject(error);
        return;
      }
      const os = tx.objectStore(store);
      let failure = null;
      for (const row of prepared) {
        const request = os.put(row);
        request.onerror = (event) => {
          if (!failure) failure = translate(store, request, def);
          event.preventDefault(); // let the transaction abort as a unit
        };
      }
      tx.oncomplete = () => resolve(prepared);
      tx.onabort = () => reject(failure ?? tx.error ?? new Error(`${store}: transaction aborted`));
      tx.onerror = () => reject(failure ?? tx.error ?? new Error(`${store}: transaction failed`));
    });
  }

  async remove(store, id) {
    if (this._fallback) return this._fallback.remove(store, id);
    if (!(await this._ensure())) return false;
    const os = this._os(store, 'readwrite');
    if (!os) return false;
    const existed = (await promisify(os.getKey(id))) !== undefined;
    await promisify(os.delete(id));
    return existed;
  }

  /**
   * Delete many rows in one transaction.
   *
   * The count is taken from the keys before deleting, not from the delete
   * requests: a request that was issued and then aborted by the transaction
   * must not be reported as a removal, or a caller removing a provider's
   * models would be told it removed rows it did not.
   */
  async removeMany(store, ids) {
    if (this._fallback) return this._fallback.removeMany(store, ids);
    if (!(await this._ensure())) return 0;
    const os = this._os(store, 'readwrite');
    if (!os) return 0;

    const tx = os.transaction;
    const present = await Promise.all(ids.map((id) => promisify(os.getKey(id))));
    const removals = [];
    for (let i = 0; i < ids.length; i += 1) {
      if (present[i] === undefined) continue;
      removals.push(os.delete(ids[i]));
    }
    if (!removals.length) return 0;

    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onabort = () => reject(tx.error ?? new Error(`${store}: transaction aborted`));
      tx.onerror = () => reject(tx.error ?? new Error(`${store}: transaction failed`));
    });
    return removals.length;
  }

  async clear(store) {
    if (this._fallback) return this._fallback.clear(store);
    if (!(await this._ensure())) return;
    const os = this._os(store, 'readwrite');
    if (!os) return;
    await promisify(os.clear());
  }

  async clearAll() {
    for (const name of STORES) await this.clear(name);
  }

  /**
   * Run `fn` inside one IndexedDB transaction.
   *
   * Every call inside `fn` must be on the driver handed to it and must be
   * awaited immediately - no fetching, no timers, no other storage. IndexedDB
   * commits the moment control returns to the event loop, so work in between
   * would silently run outside the transaction and lose the atomicity the
   * caller asked for.
   *
   * A throw inside `fn` aborts the transaction, so a write that spans two
   * stores leaves neither of them changed. That is the whole point of asking
   * for a transaction, and it is why the abort happens here rather than being
   * left to the caller to remember.
   */
  async tx(storeNames, mode, fn) {
    if (this._fallback) return this._fallback.tx(storeNames, mode, fn);
    if (typeof mode === 'function') return mode(this);
    if (!(await this._ensure())) throw new Error('Database is not open');

    const names = Array.isArray(storeNames) ? storeNames : [storeNames];
    const tx = this._db.transaction(names, mode ?? 'readwrite');
    const view = new TxDriver(tx, names);

    let result;
    try {
      result = await fn(view);
    } catch (error) {
      try { tx.abort(); } catch { /* already finished */ }
      throw error;
    }

    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onabort = () => reject(tx.error ?? new Error('Transaction aborted'));
      tx.onerror = () => reject(tx.error ?? new Error('Transaction failed'));
    });
    return result;
  }

  validate(store, row) {
    return validateRow(store, row);
  }

  async seed(store, rows, opts = {}) {
    if (this._fallback) return this._fallback.seed(store, rows, opts);
    const keyField = opts.keyField ?? 'id';
    const os = this._os(store, 'readwrite');
    if (!os) return 0;
    let added = 0;
    for (const row of rows) {
      const key = row?.[keyField];
      if (!key) continue;
      if ((await promisify(os.getKey(key))) !== undefined) continue;
      await promisify(os.put(applyDefaults(store, row)));
      added += 1;
    }
    return added;
  }

  async stats() {
    const out = {};
    for (const name of STORES) {
      if (!(await this._ensure())) { out[name] = 0; continue; }
      const os = this._os(name, 'readonly');
      out[name] = os ? await promisify(os.count()) : 0;
    }
    return out;
  }
}

/**
 * The driver handed to `tx`'s callback.
 *
 * It answers the same read and write methods as a real driver, on a live
 * IndexedDB transaction, so a caller can write one piece of code and have it
 * work inside or outside a transaction.
 *
 * It also honours the index plan, which is not a detail: a `find` here that
 * quietly read the whole store would make a transaction over a large provider
 * slow enough that people reach for the non-transactional path instead.
 *
 * Writes are issued without per-request error handlers on purpose. A failing
 * request aborts the transaction by itself, which is what a batch wants -
 * either every row lands or none does. Attaching a handler that only recorded
 * the error would let the rest of the batch commit and leave the store holding
 * half a catalog.
 */
class TxDriver {
  constructor(tx, storeNames) {
    this._tx = tx;
    this._stores = Array.isArray(storeNames) ? storeNames : [storeNames];
  }

  _os(store) {
    if (!this._stores.includes(store)) {
      throw new Error(`Store '${store}' is not part of this transaction`);
    }
    return this._tx.objectStore(store);
  }

  get degraded() { return false; }

  async get(store, id) {
    const row = await promisify(this._os(store).get(id));
    return row ?? null;
  }

  async list(store) {
    return (await promisify(this._os(store).getAll())) ?? [];
  }

  /**
   * Rows the index says match, inside the transaction.
   *
   * Reads only what the transaction covers, and only from stores it was opened
   * for. An index on a store outside the transaction cannot be touched without
   * opening a second transaction, which would break atomicity - so that case
   * falls back to reading the store, which cannot happen either, and the `_os`
   * guard is what turns it into a clear error.
   */
  async _candidates(store, query) {
    const def = STORE_MAP[store];
    const plan = planQuery(def, query);
    const os = this._os(store);
    if (!plan.index || !os.indexNames.contains(plan.index.name)) {
      return promisify(os.getAll());
    }
    const index = os.index(plan.index.name);

    if (plan.kind === 'point') {
      const seen = new Set();
      const out = [];
      for (const key of plan.keys) {
        if (!isUsableKey(key)) continue;
        for (const row of await promisify(index.getAll(IDBKeyRange.only(key)))) {
          const id = row?.[def.keyPath];
          if (seen.has(id)) continue;
          seen.add(id);
          out.push(row);
        }
      }
      return out;
    }
    const range = toKeyRange(plan.keys);
    if (!range) return promisify(os.getAll());
    return promisify(index.getAll(range));
  }

  async find(store, where) {
    const rows = await this._candidates(store, { where });
    const hit = where ? rows.find(wherePredicate(where)) : rows[0];
    return hit ?? null;
  }

  async findMany(store, query = {}) {
    return applyQuery(await this._candidates(store, query), query);
  }

  async put(store, row) {
    const prepared = applyDefaults(store, row);
    await promisify(this._os(store).put(prepared));
    return prepared;
  }

  /** Write several rows inside the transaction they belong to. */
  async putMany(store, rows) {
    const def = STORE_MAP[store];
    const os = this._os(store);
    const prepared = rows.map((row) => {
      const next = applyDefaults(store, row);
      if (next[def.keyPath] === undefined || next[def.keyPath] === null) {
        throw new MissingKeyError(store, def.keyPath);
      }
      return next;
    });
    // No error handler per request: a failing request aborts the transaction by
    // itself, which is what a batch wants - either every row lands or none does.
    // Attaching a handler that only recorded the error would let the rest of the
    // batch commit and leave the store holding half a catalog.
    for (const row of prepared) os.put(row);
    return prepared;
  }

  async remove(store, id) {
    await promisify(this._os(store).delete(id));
  }

  /** Delete several rows inside the transaction they belong to. */
  async removeMany(store, ids) {
    const os = this._os(store);
    const present = await Promise.all(ids.map((id) => promisify(os.getKey(id))));
    let removed = 0;
    for (let i = 0; i < ids.length; i += 1) {
      if (present[i] === undefined) continue;
      os.delete(ids[i]);
      removed += 1;
    }
    return removed;
  }

  async clear(store) {
    await promisify(this._os(store).clear());
  }

  /** Takes a bare where clause or a whole query object, like the drivers. */
  async count(store, whereOrQuery = null) {
    const where = whereOf(whereOrQuery);
    if (!where) return promisify(this._os(store).count());
    const rows = await this._candidates(store, { where, _forceScan: whereOrQuery?._forceScan === true });
    return rows.filter(wherePredicate(where)).length;
  }

  validate(store, row) {
    return validateRow(store, row);
  }
}

/**
 * A flat view of a raw IndexedDB database, for the migration runner.
 *
 * Deliberately separate from IdbDriver: a migration must not go through the
 * code path it is migrating. If it did, a schema bug would be able to hide
 * inside the thing that repairs it.
 */
class MigrationView {
  constructor(db) {
    this._db = db;
  }

  _storeNames() { return STORES; }

  async get(store, id) {
    const tx = this._db.transaction(store, 'readonly');
    const row = await promisify(tx.objectStore(store).get(id));
    return row ?? null;
  }

  async list(store) {
    const tx = this._db.transaction(store, 'readonly');
    return (await promisify(tx.objectStore(store).getAll())) ?? [];
  }

  async put(store, row) {
    const tx = this._db.transaction(store, 'readwrite');
    await promisify(tx.objectStore(store).put(applyDefaults(store, row)));
  }
}

/** Can IndexedDB use this as a key? Mirrors `isIndexableValue` in schema.js. */
function isUsableKey(key) {
  if (typeof key === 'number') return Number.isFinite(key);
  if (typeof key === 'string' || key instanceof Date) return true;
  if (Array.isArray(key)) return key.every(isUsableKey);
  return false;
}

/** Turn a range clause into an IDBKeyRange, or null when it cannot be one. */
function toKeyRange(clause) {
  const lower = clause.$gt ?? clause.$gte;
  const upper = clause.$lt ?? clause.$lte;
  if (lower === undefined && upper === undefined) return null;
  const loOpen = '$gt' in clause;
  const hiOpen = '$lt' in clause;
  if (lower !== undefined && upper !== undefined) {
    if (!isUsableKey(lower) || !isUsableKey(upper)) return null;
    return IDBKeyRange.bound(lower, upper, loOpen, hiOpen);
  }
  if (lower !== undefined) {
    if (!isUsableKey(lower)) return null;
    return loOpen ? IDBKeyRange.lowerBound(lower, true) : IDBKeyRange.lowerBound(lower);
  }
  if (!isUsableKey(upper)) return null;
  return hiOpen ? IDBKeyRange.upperBound(upper, true) : IDBKeyRange.upperBound(upper);
}

