/**
 * Memory driver.
 *
 * Used by the tests, and by any runtime where IndexedDB is unavailable. It is
 * not a toy: it keeps real secondary indexes and enforces the same unique
 * constraints as IndexedDB, so a duplicate that a test lets through here would
 * also be a duplicate in a browser. A driver that is easier than the real one
 * is a driver that hides bugs.
 *
 * Rows are cloned on the way in and on the way out. Callers mutate what they
 * read (`{ ...row, status: 'OK' }` is the pattern everywhere in core/), and a
 * store that handed out live references would apply those edits whether or not
 * anyone called `put`.
 */

import { STORE_MAP, STORES, applyDefaults, indexKeyFor, indexKeyToken, validateRow } from './schema.js';
import { applyQuery, isQueryObject, planQuery, whereOf, wherePredicate } from './query.js';

/** A unique-index violation, shaped like the IndexedDB error it stands in for. */
export class UniqueConstraintError extends Error {
  constructor(store, index, key) {
    super(`Unique constraint failed: ${store}.${index.name} = ${JSON.stringify(key)}`);
    this.name = 'UniqueConstraintError';
    this.store = store;
    this.index = index.name;
    this.key = key;
  }
}

/** Thrown when a write would leave a row without its key. */
export class MissingKeyError extends Error {
  constructor(store, keyPath) {
    super(`${store}: row has no ${keyPath}`);
    this.name = 'MissingKeyError';
    this.store = store;
  }
}

export class MemoryDriver {
  constructor(seed = {}) {
    /** store -> Map<id, row> */
    this._data = new Map();
    /** store -> indexName -> Map<token, Set<id>> */
    this._indexes = new Map();
    for (const name of STORES) {
      this._data.set(name, new Map());
      this._indexes.set(name, new Map());
    }
    this._opened = false;
    // Snapshot stack for nested transactions; the outermost one owns rollback.
    this._txDepth = 0;

    for (const [store, rows] of Object.entries(seed)) this._seedSync(store, rows);
  }

  /** Never true here. Present so callers can ask either driver the same way. */
  get degraded() { return false; }

  /**
   * Read the store or open it.
   *
   * Idempotent, and safe to await more than once: the app calls it before its
   * first read, the tests call it before seeding, and neither should have to
   * know whether somebody got there first.
   */
  async open() {
    if (this._opened) return this;
    this._opened = true;
    return this;
  }

  /** Drop everything. There is no connection to close in memory. */
  async close() {
    return undefined;
  }

  _store(name) {
    if (!this._data.has(name)) {
      this._data.set(name, new Map());
      this._indexes.set(name, new Map());
    }
    return this._data.get(name);
  }

  _indexStore(name) {
    if (!this._indexes.has(name)) this._indexes.set(name, new Map());
    return this._indexes.get(name);
  }

  _def(name) {
    return STORE_MAP[name] ?? null;
  }

  _storeNames() { return STORES; }

  // ------------------------------------------------------------------ reads

  async get(store, id) {
    const row = this._store(store).get(id);
    return row === undefined ? null : structuredClone(row);
  }

  async list(store) {
    return [...this._store(store).values()].map((row) => structuredClone(row));
  }

  /**
   * Rows an index says match, without the full predicate applied.
   *
   * The caller still filters with the complete `where`, so this is a narrowing
   * step and not the answer.
   */
  _candidates(store, query) {
    const def = this._def(store);
    const plan = planQuery(def, query);
    if (!plan.index) return [...this._store(store).values()];

    const rows = this._store(store);
    if (plan.kind === 'point') {
      const seen = new Set();
      const out = [];
      for (const key of plan.keys) {
        const ids = this._lookup(store, plan.index, key);
        if (!ids) continue;
        for (const id of ids) {
          if (seen.has(id)) continue;
          seen.add(id);
          const row = rows.get(id);
          if (row !== undefined) out.push(row);
        }
      }
      return out;
    }
    // A range on a single field: the index map is ordered by token, which is
    // not numeric order, so the range is evaluated over the matching ids.
    const out = [];
    const seen = new Set();
    for (const ids of this._indexStore(store).get(plan.index.name)?.values() ?? []) {
      for (const id of ids) {
        if (seen.has(id)) continue;
        seen.add(id);
        const row = rows.get(id);
        if (row !== undefined && rangeMatches(row[plan.index.fields[0]], plan.keys)) out.push(row);
      }
    }
    return out;
  }

  _lookup(store, index, key) {
    const map = this._indexStore(store).get(index.name);
    if (!map) return null;
    const ids = map.get(indexKeyToken(key));
    return ids ? [...ids] : null;
  }

  async find(store, where) {
    const rows = this._candidates(store, { where });
    const hit = where ? rows.find(wherePredicate(where)) : rows[0];
    return hit === undefined ? null : structuredClone(hit);
  }

  async findMany(store, query = {}) {
    const rows = this._candidates(store, query);
    return applyQuery(rows, query).map((row) => structuredClone(row));
  }

  /**
   * How many rows match.
   *
   * Takes a bare where clause or a whole query object. It has to: `summary()`
   * on the provider card wants a plain `{ providerId }`, and the test suite
   * wants the same count computed through an index and through a forced scan -
   * which is the only way to notice an index that quietly disagrees with the
   * rows it is supposed to describe.
   */
  async count(store, whereOrQuery = null) {
    const where = whereOf(whereOrQuery);
    if (!where && !isQueryObject(whereOrQuery)) return this._store(store).size;
    const rows = this._candidates(store, { where, _forceScan: whereOrQuery?._forceScan === true });
    return rows.filter(wherePredicate(where)).length;
  }

  // ----------------------------------------------------------------- writes

  /**
   * Insert or replace one row.
   *
   * Declared defaults are filled in first, so a caller that omits `enabled`
   * gets `true` rather than `undefined` - which is what makes "enabled" readable
   * at all. An explicit `null` is preserved: `inputPrice: null` means the
   * provider published no price, and `0` means it published a price of zero.
   */
  async put(store, row) {
    const def = this._def(store);
    if (!def) throw new Error(`Unknown store '${store}'`);
    const prepared = applyDefaults(store, row);
    if (prepared[def.keyPath] === undefined || prepared[def.keyPath] === null) {
      throw new MissingKeyError(store, def.keyPath);
    }
    const id = prepared[def.keyPath];
    const rows = this._store(store);
    const previous = rows.get(id);
    if (previous) this._unindex(store, previous);

    this._assertUnique(store, def, prepared, id);
    rows.set(id, structuredClone(prepared));
    this._index(store, def, prepared);
    return structuredClone(prepared);
  }

  /**
   * Fail on a unique-index collision before anything is written.
   *
   * Checked first so a rejected write leaves the store exactly as it was. The
   * row being replaced by its own id is never a collision, which is what lets
   * `put` be an update as well as an insert.
   */
  _assertUnique(store, def, row, id) {
    for (const index of def.indexes ?? []) {
      if (!index.unique) continue;
      const key = indexKeyFor(index, row);
      if (key.kind === 'none') continue;
      const ids = this._indexStore(store).get(index.name)?.get(indexKeyToken(key.value));
      if (!ids) continue;
      for (const other of ids) {
        if (other !== id) throw new UniqueConstraintError(store, index, key.value);
      }
    }
  }

  _index(store, def, row) {
    const maps = this._indexStore(store);
    for (const index of def.indexes ?? []) {
      const key = indexKeyFor(index, row);
      if (key.kind === 'none') continue;
      if (!maps.has(index.name)) maps.set(index.name, new Map());
      const map = maps.get(index.name);
      const tokens = key.kind === 'multi' ? key.values : [key.value];
      for (const token of tokens) {
        const bucket = map.get(indexKeyToken(token));
        if (bucket) bucket.add(row[def.keyPath]);
        else map.set(indexKeyToken(token), new Set([row[def.keyPath]]));
      }
    }
  }

  _unindex(store, row) {
    const def = this._def(store);
    if (!def) return;
    const maps = this._indexStore(store);
    for (const index of def.indexes ?? []) {
      const key = indexKeyFor(index, row);
      if (key.kind === 'none') continue;
      const map = maps.get(index.name);
      if (!map) continue;
      const tokens = key.kind === 'multi' ? key.values : [key.value];
      for (const token of tokens) {
        const bucket = map.get(indexKeyToken(token));
        if (!bucket) continue;
        bucket.delete(row[def.keyPath]);
        if (bucket.size === 0) map.delete(indexKeyToken(token));
      }
    }
  }

  /**
   * Write many rows in one transaction, so a bad row in the batch rolls all back.
   *
   * Routed through `tx` rather than looping over `put`, because a batch that
   * only fails on its last row has to leave nothing behind: half a catalog is
   * worse than no catalog, because the missing half looks like it does not exist.
   */
  async putMany(store, rows) {
    return this.tx([store], 'readwrite', async (tx) => {
      const out = [];
      for (const row of rows) out.push(await tx.put(store, row));
      return out;
    });
  }

  async remove(store, id) {
    const rows = this._store(store);
    const row = rows.get(id);
    if (row === undefined) return false;
    this._unindex(store, row);
    rows.delete(id);
    return true;
  }

  async removeMany(store, ids) {
    let removed = 0;
    for (const id of ids) if (await this.remove(store, id)) removed += 1;
    return removed;
  }

  async clear(store) {
    this._store(store).clear();
    this._indexStore(store).clear();
  }

  async clearAll() {
    for (const name of STORES) await this.clear(name);
  }

  // ----------------------------------------------------------- transactions

  /**
   * Run `fn` against a driver, rolling back on any error.
   *
   * Real rollback, not a comment about rollback: the stores touched are copied
   * before the first write and restored if `fn` throws. `putMany` depends on
   * it - a scan writing 400 models must not leave 200 behind because model 201
   * was malformed.
   *
   * Nested calls join the outer transaction rather than taking a second
   * snapshot, so an inner rollback cannot undo an outer commit.
   */
  async tx(storeNames, mode, fn) {
    if (typeof mode === 'function') return mode(this);

    if (this._txDepth > 0) return fn(this);

    const names = (Array.isArray(storeNames) ? storeNames : [storeNames]).filter((n) => this._data.has(n));
    const snapshot = new Map(names.map((name) => [name, new Map(this._store(name))]));
    const indexSnapshot = new Map(names.map((name) => [name, new Map(
      [...this._indexStore(name)].map(([key, map]) => [key, new Map(map)])
    )]));

    this._txDepth += 1;
    try {
      return await fn(this);
    } catch (error) {
      for (const name of names) {
        this._data.set(name, snapshot.get(name));
        this._indexes.set(name, indexSnapshot.get(name));
      }
      throw error;
    } finally {
      this._txDepth -= 1;
    }
  }

  /** Validate a row without writing it. */
  validate(store, row) {
    return validateRow(store, row);
  }

  /** Insert rows that are not there yet. Returns how many were added. */
  async seed(store, rows, { keyField = 'id' } = {}) {
    const existing = this._store(store);
    let added = 0;
    for (const row of rows) {
      const key = row?.[keyField];
      if (!key || existing.has(key)) continue;
      await this.put(store, row);
      added += 1;
    }
    return added;
  }

  /** Bulk insert used by the constructor, where `put` is not available yet. */
  _seedSync(store, rows) {
    const def = this._def(store);
    if (!def) return;
    const list = Array.isArray(rows) ? rows : [];
    for (const raw of list) {
      if (!raw || typeof raw !== 'object') continue;
      const row = applyDefaults(store, raw);
      const id = row[def.keyPath];
      if (id === undefined || id === null) continue;
      this._store(store).set(id, structuredClone(row));
      this._index(store, def, row);
    }
  }

  /** Row count per store. Used by the tests to assert what a run wrote. */
  async stats() {
    const out = {};
    for (const name of STORES) out[name] = this._store(name).size;
    return out;
  }
}

function rangeMatches(value, clause) {
  for (const [op, target] of Object.entries(clause)) {
    if (op === '$gt' && !(value > target)) return false;
    if (op === '$gte' && !(value >= target)) return false;
    if (op === '$lt' && !(value < target)) return false;
    if (op === '$lte' && !(value <= target)) return false;
  }
  return true;
}