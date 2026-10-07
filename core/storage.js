/**
 * Storage: the name the rest of the app imports.
 *
 * Everything lives in core/db/ now - schema, query engine, drivers and
 * migrations. This file exists so the 11 modules that say
 * `import { ... } from './storage.js'` keep working, and so there is one obvious
 * place to look for "where is the database defined".
 *
 * New code should import from `./db/index.js` directly: the names here are the
 * old ones, kept because renaming a module across 11 files buys nothing and
 * risks the app booting differently for no visible gain.
 */

import { createStorage as createDb } from './db/index.js';

/** The in-process driver. Used by every test. */
export { MemoryDriver as MemoryStorage } from './db/index.js';

/** The browser driver. Degrades to memory when IndexedDB is unavailable. */
export { IdbDriver as IdbStorage } from './db/index.js';

export { STORES } from './db/index.js';
export { SCHEMA_VERSION } from './db/index.js';

export const createStorage = createDb;