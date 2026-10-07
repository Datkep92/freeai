/**
 * Migrations (database core).
 *
 * Two kinds of change, and they are not interchangeable:
 *
 *   Structural - a store or an index appears. IndexedDB can only do this inside
 *   its `onupgradeneeded` handler, and only when the version number goes up. So
 *   a new store is a schema entry plus a version bump here, and `createIdbSchema`
 *   applies it. Miss the bump and an existing browser keeps the old shape
 *   forever, with no error anywhere - which is exactly what happened when the
 *   `metrics` store was added without one.
 *
 *   Data - existing rows need rewriting. That runs after the upgrade, once per
 *   version, tracked in `settings/_schemaVersion`.
 *
 * A migration is written so that running it twice is harmless. Upgrades are
 * interrupted more often than anyone expects: a tab closed mid-upgrade, a phone
 * killed by the OS, a browser crash. Anything that is not idempotent turns that
 * into a corrupt registry.
 */

import { STORE_DEFS, SCHEMA_VERSION, stripInternalFields } from './schema.js';

export const VERSION_ROW = '_schemaVersion';

/**
 * Every migration, in order.
 *
 * `data` receives a flat view of storage (get/list/put) and runs once per
 * version. It must be safe to run again on an already-migrated database.
 */
export const MIGRATIONS = [
  {
    from: 1,
    to: 2,
    name: 'settings-shape',
    /**
     * `settings` was written two different ways: the priority module stored
     * `{ id, rotation, skipped, order }` directly on the row, while the
     * migration bookkeeping stored `{ id, value: {...} }`. The second shape is
     * the declared one, so anything that is not already wrapped is wrapped
     * here rather than leaving two conventions in one store.
     */
    async data(storage) {
      for (const row of await storage.list('settings')) {
        if (!row || row.value !== undefined || row.id === VERSION_ROW) continue;
        const { id, updatedAt, ...rest } = row;
        await storage.put('settings', { id, value: rest, updatedAt: updatedAt ?? null });
      }
    },
  },
  {
    from: 2,
    to: 3,
    name: 'drop-stale-row-fields',
    /**
     * `_schemaVersion` was stamped onto every row by an earlier version of the
     * migration system. Nothing reads it: the version that matters lives in one
     * place, `settings/_schemaVersion`. Carrying a per-row version that nothing
     * consults only means every future write has to decide whether to update
     * it, and a stale value on a row is indistinguishable from a current one.
     */
    async data(storage) {
      for (const store of storage._storeNames()) {
        for (const row of await storage.list(store)) {
          if (!('_schemaVersion' in row)) continue;
          await storage.put(store, stripInternalFields(row));
        }
      }
    },
  },
];

/**
 * Apply pending data migrations.
 *
 * @param {Object} storage - flat view: get/list/put/_storeNames
 * @param {number} [targetVersion]
 * @returns {Promise<{from:number,to:number,ran:string[]}>}
 */
export async function runDataMigrations(storage, targetVersion = SCHEMA_VERSION) {
  const row = (await storage.get('settings', VERSION_ROW)) ?? { id: VERSION_ROW, value: {} };
  const current = Number(row?.value?.version ?? 0);

  if (current >= targetVersion) return { from: current, to: current, ran: [] };

  const pending = MIGRATIONS
    .filter((m) => m.to > current && m.to <= targetVersion)
    .sort((a, b) => a.to - b.to);

  const ran = [];
  for (const migration of pending) {
    if (typeof migration.data === 'function') {
      await migration.data(storage);
    }
    // Written after each step, not once at the end. If the tab dies half way
    // through, the next run resumes from the last step that finished rather
    // than replaying all of them.
    await storage.put('settings', { id: VERSION_ROW, value: { version: migration.to } });
    ran.push(migration.name);
  }

  if (pending.length === 0) {
    await storage.put('settings', { id: VERSION_ROW, value: { version: targetVersion } });
  }
  return { from: current, to: targetVersion, ran };
}

/**
 * Create anything the schema declares that the database does not have yet.
 *
 * Called from `onupgradeneeded`, where the only operations IndexedDB permits are
 * the ones in this handler. Nothing else in the codebase may create a store or
 * an index: an index created at runtime would be missing for every user who
 * opened the app before that code shipped, with nothing to indicate it.
 *
 * Stores and indexes are only ever added, never dropped. Dropping a store is a
 * destructive operation that belongs in a migration with a name that says so,
 * not as a side effect of tidying up the schema.
 */
export function createIdbSchema(db, event) {
  const tx = event?.target?.transaction ?? db.transaction;

  for (const def of STORE_DEFS) {
    let store;
    if (!db.objectStoreNames.contains(def.store)) {
      store = db.createObjectStore(def.store, { keyPath: def.keyPath });
    } else if (tx) {
      store = tx.objectStore(def.store);
    } else {
      continue;
    }
    if (!store) continue;

    for (const index of def.indexes ?? []) {
      if (store.indexNames?.contains(index.name)) continue;
      const keyPath = index.fields.length === 1 ? index.fields[0] : index.fields;
      store.createIndex(index.name, keyPath, {
        unique: index.unique ?? false,
        multiEntry: index.multiEntry ?? false,
      });
    }
  }
}