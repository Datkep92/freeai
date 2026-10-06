/**
 * Storage abstraction (plan 26).
 *
 * Everything above this file talks to `put/list/remove/clear`, never to a
 * concrete database. Swapping IndexedDB for Cloudflare D1/KV/DO later is a
 * driver change, not a rewrite of the core.
 *
 * localStorage is deliberately not used: the registry is too large for it, and
 * it is synchronous, which blocks the UI thread on every read.
 */

import { CONFIG } from './config.js';

const DB_NAME = CONFIG.storageName ?? 'free-model-hub';
// Bumped when STORES grows. IndexedDB only runs the upgrade handler - which is
// what creates missing stores - when the version number goes UP. Leaving this at
// 1 after adding 'metrics' meant a browser that already had the database kept
// the old store set, and every speed measurement was written into a store that
// did not exist and silently lost.
const DB_VERSION = 2;

/** Stores, each a simple id -> record map. */
export const STORES = [
  'providers',
  'models',
  'keys',
  'mappings',
  'metrics',
  'events',
  'deletedKeys',
  'unresolved',
  'settings',
];

export class MemoryStorage {
  constructor(seed = {}) {
    this._data = new Map(STORES.map((name) => [name, new Map()]));
    for (const [store, rows] of Object.entries(seed)) {
      if (!this._data.has(store)) this._data.set(store, new Map());
      for (const row of rows) this._data.get(store).set(row.id, row);
    }
  }

  async get(store, id) {
    const row = this._data.get(store)?.get(id) ?? null;
    return row ? structuredClone(row) : null;
  }

  async list(store) {
    return [...(this._data.get(store)?.values() ?? [])].map((r) => structuredClone(r));
  }

  async put(store, row) {
    this._data.get(store).set(row.id, structuredClone(row));
    return row;
  }

  async remove(store, id) {
    this._data.get(store)?.delete(id);
  }

  async clear(store) {
    this._data.get(store)?.clear();
  }

  async clearAll() {
    for (const name of STORES) this._data.get(name).clear();
  }
}

/**
 * IndexedDB driver.
 *
 * Falls back to memory when IndexedDB is unavailable (private mode on some
 * Safari versions, or a non-browser runtime). The app stays usable; the data
 * simply does not survive a reload, and the UI says so.
 */
export class IdbStorage {
  constructor(namespace = DB_NAME) {
    this.namespace = namespace;
    this._db = null;
    this._fallback = null;
  }

  get degraded() {
    return this._fallback !== null;
  }

  async open() {
    if (this._db) return this._db;
    if (this._fallback) return null;
    if (typeof indexedDB === 'undefined') {
      this._fallback = new MemoryStorage();
      return null;
    }

    try {
      this._db = await new Promise((resolve, reject) => {
        const request = indexedDB.open(this.namespace, DB_VERSION);
        request.onupgradeneeded = () => {
          const db = request.result;
          for (const name of STORES) {
            if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: 'id' });
          }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      return this._db;
    } catch {
      this._fallback = new MemoryStorage();
      return null;
    }
  }

  async _tx(store, mode) {
    const db = await this.open();
    if (!db) return null;
    return db.transaction(store, mode).objectStore(store);
  }

  async get(store, id) {
    const os = await this._tx(store, 'readonly');
    if (!os) return this._fallback.get(store, id);
    return new Promise((resolve, reject) => {
      const request = os.get(id);
      request.onsuccess = () => resolve(request.result ?? null);
      request.onerror = () => reject(request.error);
    });
  }

  async list(store) {
    const os = await this._tx(store, 'readonly');
    if (!os) return this._fallback.list(store);
    return new Promise((resolve, reject) => {
      const request = os.getAll();
      request.onsuccess = () => resolve(request.result ?? []);
      request.onerror = () => reject(request.error);
    });
  }

  async put(store, row) {
    const os = await this._tx(store, 'readwrite');
    if (!os) return this._fallback.put(store, row);
    return new Promise((resolve, reject) => {
      const request = os.put(row);
      request.onsuccess = () => resolve(row);
      request.onerror = () => reject(request.error);
    });
  }

  async remove(store, id) {
    const os = await this._tx(store, 'readwrite');
    if (!os) return this._fallback.remove(store, id);
    return new Promise((resolve, reject) => {
      const request = os.delete(id);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  async clear(store) {
    const os = await this._tx(store, 'readwrite');
    if (!os) return this._fallback.clear(store);
    return new Promise((resolve, reject) => {
      const request = os.clear();
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  async clearAll() {
    for (const name of STORES) await this.clear(name);
  }
}

/** Pick the best available driver for this runtime. */
export function createStorage(options = {}) {
  if (options.driver === 'memory') return new MemoryStorage();
  return new IdbStorage(options.namespace ?? DB_NAME);
}
