/**
 * Database core (database core).
 *
 * One contract, two drivers, one schema. Everything above this directory talks
 * to `get / list / put / remove / find / findMany / count / tx` and never to a
 * database, so replacing IndexedDB with something server-side later is a new
 * driver rather than a rewrite of the app.
 *
 *   schema.js     what is stored: fields, defaults, enums, indexes, relations
 *   query.js      pure filter/sort/page, and the plan that picks an index
 *   memory.js     in-process driver with real indexes and real transactions
 *   idb.js        IndexedDB driver, index-aware reads, transaction-safe writes
 *   migrations.js structural upgrades and one-time data rewrites
 *   index.js      this file: pick a driver, re-export the contract
 *
 * The schema is the only description of the data. Adding a field is one line in
 * schema.js; adding a store is one entry; adding an index is one entry, and a
 * query can use it without another change anywhere.
 */

import { MemoryDriver } from './memory.js';
import { IdbDriver } from './idb.js';

export { MemoryDriver, IdbDriver };
export { UniqueConstraintError, MissingKeyError } from './memory.js';
export {
  STORE_DEFS, STORE_MAP, STORES, CHILDREN_OF, SCHEMA_VERSION, IDB_VERSION, TYPE,
  ASC, DESC, storeDef, fieldDef, secretFields, applyDefaults, validateRow,
  stripSecrets, stripInternalFields, isIndexableValue, indexKeyFor, usableIndexes,
} from './schema.js';
export { applyQuery, wherePredicate, sortComparator, planQuery, project } from './query.js';
export { MIGRATIONS, VERSION_ROW, runDataMigrations, createIdbSchema } from './migrations.js';

/**
 * Pick a driver for this runtime.
 *
 * `driver: 'memory'` is what the tests use. Anything else gets IndexedDB, which
 * falls back to memory on its own when the browser refuses it (Safari private
 * mode, a locked-down profile) so the app stays usable - and reports
 * `degraded` so the UI can say that the data will not survive a reload.
 */
export function createStorage(options = {}) {
  if (options.driver === 'memory') return new MemoryDriver();
  return new IdbDriver(options.namespace ?? 'free-model-hub');
}