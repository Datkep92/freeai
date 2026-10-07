/**
 * The one description of what is stored (database core).
 *
 * Every entity, field, default, index and relation is declared here once. The
 * memory driver, the IndexedDB driver, the migration system, the validator and
 * the test suite all read this file, so there is no second copy of the truth to
 * drift away from the first.
 *
 * Three rules this file exists to enforce:
 *
 *   1. A field the code writes is declared here. A field nobody writes is not.
 *      The previous schema listed metrics fields (`totalTokens`,
 *      `lastRecordedAt`) that no code has ever written, while the fields the
 *      code does write (`identity`, `totalMs`, `bestTtftMs`) were undeclared -
 *      so "the schema" described a database that did not exist.
 *
 *   2. An index is declared only when a query uses it, and only over fields
 *      whose values IndexedDB can actually use as a key. Booleans and nulls are
 *      not valid IndexedDB keys: an index over them is created without error and
 *      then silently contains nothing, which is why `by_enabled` is gone.
 *
 *   3. Identity is stated, not assumed. Every store that means "one row per X"
 *      says so with a unique index, and both drivers enforce it, so a duplicate
 *      fails the same way in a test and in a browser.
 *
 * Adding a store is one entry here. Adding a field is one line. Adding an index
 * is one entry, and a query that uses it needs nothing else.
 */

import { FREE } from '../free-detector.js';
import { STATUS } from '../statuses.js';
import { KEY_REQ } from '../key-requirement.js';
import { MODEL_SOURCE, MODEL_STATE } from '../model-registry.js';

/** Index direction. */
export const ASC = 'ASC';
export const DESC = 'DESC';

/**
 * Bump when a migration is added below. The IndexedDB version is tied to it:
 * IndexedDB only runs the upgrade handler when the version goes up, so a schema
 * change without this bump leaves an existing browser database without the new
 * stores and indexes, forever and silently.
 */
export const SCHEMA_VERSION = 3;

/** IDB version number for the onupgrade handler. */
export const IDB_VERSION = SCHEMA_VERSION;

/** Field value types the validator understands. */
export const TYPE = {
  STRING: 'string',
  NUMBER: 'number',
  BOOLEAN: 'boolean',
  OBJECT: 'object',
  STRING_ARRAY: 'string[]',
  ANY: 'any',
};

/**
 * @typedef {Object} FieldDef
 * @property {string} type - one of TYPE
 * @property {boolean} [required] - documented as always present
 * @property {*} [default] - filled in on write when the field is missing
 * @property {string[]} [enum] - the only accepted values
 * @property {number} [maxLength] - max string length
 * @property {boolean} [secret] - must never leave the device in an export
 */

/**
 * @typedef {Object} IndexDef
 * @property {string} name - unique within the store
 * @property {string[]} fields - ordered field list (compound)
 * @property {boolean} [unique] - one row per value combination
 * @property {boolean} [multiEntry] - index each element of an array field
 */

/**
 * @typedef {Object} RelationDef
 * @property {string} store - the store that points at this one
 * @property {string} field - the field holding the id
 * @property {'cascade'} [onDelete] - what happens to the child when the parent goes
 */

/**
 * @typedef {Object} StoreDef
 * @property {string} store - store name
 * @property {string} keyPath - primary key field
 * @property {Object<string, FieldDef>} fields - field definitions
 * @property {IndexDef[]} indexes - index list
 * @property {RelationDef[]} [relations] - stores that reference this one
 */

/** Provider lifecycle. A scan writes it; the drawer reads it. */
const PROVIDER_STATUS = ['NEW', 'OK', 'ERROR', 'TIMEOUT', 'DISABLED'];

/** @type {StoreDef[]} */
export const STORE_DEFS = [
  {
    store: 'providers',
    keyPath: 'id',
    fields: {
      id: { type: TYPE.STRING, required: true },
      // The preset this row was seeded from, or null for a URL the user added.
      builtinId: { type: TYPE.STRING },
      name: { type: TYPE.STRING, required: true, maxLength: 200 },
      type: { type: TYPE.STRING, required: true, enum: ['BUILT_IN', 'CUSTOM'], default: 'CUSTOM' },
      baseURL: { type: TYPE.STRING, required: true, maxLength: 1000 },
      websiteURL: { type: TYPE.STRING, maxLength: 1000 },
      protocol: { type: TYPE.STRING, default: 'openai-compatible' },
      modelsPath: { type: TYPE.STRING, default: '/models' },
      chatPath: { type: TYPE.STRING, default: '/chat/completions' },
      freeTier: { type: TYPE.STRING, enum: ['reported', 'none'], default: 'none' },
      note: { type: TYPE.STRING, default: '' },
      // The older static probe snapshot. `keyRequirement` is the live verdict
      // and takes precedence; both are kept because the drawer shows the first
      // and the drawer groups on the second.
      verified: { type: TYPE.STRING, enum: ['OPEN', 'NEEDS_KEY'] },
      verifiedAt: { type: TYPE.STRING },
      status: { type: TYPE.STRING, required: true, enum: PROVIDER_STATUS, default: 'NEW' },
      enabled: { type: TYPE.BOOLEAN, default: true },
      lastScanAt: { type: TYPE.STRING },
      lastError: { type: TYPE.STRING },
      lastScanMs: { type: TYPE.NUMBER },
      keyRequirement: { type: TYPE.STRING, enum: Object.values(KEY_REQ) },
      keyRequirementAt: { type: TYPE.STRING },
      // Circuit breaker state; see core/circuit.js.
      breaker: { type: TYPE.OBJECT },
      // Per-URL rotation overrides; see core/priority.js.
      priority: { type: TYPE.OBJECT },
      // Everything the provider published that has no column of its own.
      metadata: { type: TYPE.OBJECT, default: {} },
      tags: { type: TYPE.STRING_ARRAY, default: [] },
      createdAt: { type: TYPE.STRING, required: true },
      updatedAt: { type: TYPE.STRING, required: true },
    },
    indexes: [
      // The same gateway pasted with and without a trailing slash is one
      // provider, so the normalised URL is the identity.
      { name: 'by_baseURL', fields: ['baseURL'], unique: true },
      { name: 'by_type', fields: ['type'] },
      { name: 'by_keyRequirement', fields: ['keyRequirement'] },
      { name: 'by_status', fields: ['status'] },
    ],
  },
  {
    store: 'models',
    keyPath: 'id',
    fields: {
      id: { type: TYPE.STRING, required: true },
      providerId: { type: TYPE.STRING, required: true },
      // The provider's own name for the model. Two URLs can offer the same one.
      modelId: { type: TYPE.STRING, required: true },
      displayName: { type: TYPE.STRING, required: true },
      source: { type: TYPE.STRING, required: true, enum: Object.values(MODEL_SOURCE) },
      freeStatus: { type: TYPE.STRING, required: true, enum: Object.values(FREE) },
      // Why the verdict is what it is. Never dropped, only merged.
      evidence: { type: TYPE.ANY, default: [] },
      inputPrice: { type: TYPE.NUMBER },
      outputPrice: { type: TYPE.NUMBER },
      pricingSource: { type: TYPE.STRING },
      state: { type: TYPE.STRING, required: true, enum: Object.values(MODEL_STATE), default: MODEL_STATE.ACTIVE },
      // Scans that did not return this model. A model is never deleted.
      missCount: { type: TYPE.NUMBER, default: 0 },
      active: { type: TYPE.BOOLEAN, default: true },
      notes: { type: TYPE.STRING, default: '' },
      tags: { type: TYPE.STRING_ARRAY, default: [] },
      firstSeenAt: { type: TYPE.STRING, required: true },
      lastSeenAt: { type: TYPE.STRING, required: true },
      lastScanAt: { type: TYPE.STRING },
      metadata: { type: TYPE.OBJECT, default: {} },
      createdAt: { type: TYPE.STRING },
      updatedAt: { type: TYPE.STRING },
    },
    indexes: [
      { name: 'by_providerId', fields: ['providerId'] },
      // The identity of a model: one row per provider + model id, whatever id
      // the row itself was given. This is what makes a re-scan merge instead of
      // duplicate.
      { name: 'by_provider_model', fields: ['providerId', 'modelId'], unique: true },
      // The main list reads "this URL's models that are still on", so both
      // halves of that question are indexed together.
      { name: 'by_provider_state', fields: ['providerId', 'state'] },
      { name: 'by_freeStatus', fields: ['freeStatus'] },
      { name: 'by_pricingSource', fields: ['pricingSource'] },
    ],
    // Every model belongs to a URL. Deleting a URL has to take its models with
    // it: a model whose provider is gone appears in no list in the app, because
    // every list is grouped by URL.
    relations: [{ store: 'providers', field: 'providerId', onDelete: 'cascade' }],
  },
  {
    store: 'keys',
    keyPath: 'id',
    fields: {
      id: { type: TYPE.STRING, required: true },
      providerId: { type: TYPE.STRING, required: true },
      // SHA-256 of the secret. Identity and dedupe without the secret.
      fingerprint: { type: TYPE.STRING, required: true, maxLength: 64 },
      // What the UI shows; the secret is never rendered by accident.
      masked: { type: TYPE.STRING, required: true },
      secret: { type: TYPE.STRING, maxLength: 4000, secret: true },
      enabled: { type: TYPE.BOOLEAN, default: true },
      status: { type: TYPE.STRING, required: true, enum: Object.values(STATUS), default: STATUS.UNTESTED },
      verifiedModelId: { type: TYPE.STRING },
      lastCheckedAt: { type: TYPE.STRING },
      lastSuccessAt: { type: TYPE.STRING },
      lastFailureAt: { type: TYPE.STRING },
      lastError: { type: TYPE.STRING },
      notes: { type: TYPE.STRING, default: '' },
      createdAt: { type: TYPE.STRING, required: true },
      updatedAt: { type: TYPE.STRING, required: true },
    },
    indexes: [
      { name: 'by_providerId', fields: ['providerId'] },
      // The same key pasted twice is one key.
      { name: 'by_provider_fingerprint', fields: ['providerId', 'fingerprint'], unique: true },
      { name: 'by_provider_status', fields: ['providerId', 'status'] },
      { name: 'by_status', fields: ['status'] },
    ],
    relations: [{ store: 'providers', field: 'providerId', onDelete: 'cascade' }],
  },
  {
    store: 'mappings',
    keyPath: 'id',
    fields: {
      id: { type: TYPE.STRING, required: true },
      // providerId::modelId::keyId - the unit every verdict is about.
      identity: { type: TYPE.STRING, required: true },
      providerId: { type: TYPE.STRING, required: true },
      modelId: { type: TYPE.STRING, required: true },
      keyId: { type: TYPE.STRING, required: true },
      status: { type: TYPE.STRING, required: true, enum: Object.values(STATUS), default: STATUS.UNTESTED },
      verified: { type: TYPE.BOOLEAN, default: false },
      score: { type: TYPE.NUMBER, default: 0 },
      latencyMs: { type: TYPE.NUMBER },
      // Epoch ms, not a date string: the router compares it against Date.now()
      // on every candidate, and a parse per comparison is a parse per request.
      cooldownUntil: { type: TYPE.NUMBER },
      failureCount: { type: TYPE.NUMBER, default: 0 },
      lastTestAt: { type: TYPE.STRING },
      lastSuccessAt: { type: TYPE.STRING },
      lastFailureAt: { type: TYPE.STRING },
      lastErrorClass: { type: TYPE.STRING },
      lastErrorMessage: { type: TYPE.STRING },
      retryAfterMs: { type: TYPE.NUMBER },
      createdAt: { type: TYPE.STRING, required: true },
      updatedAt: { type: TYPE.STRING, required: true },
    },
    indexes: [
      { name: 'by_providerId', fields: ['providerId'] },
      // One verdict per triple. A second probe of the same triple updates the
      // same row instead of forking history.
      { name: 'by_identity', fields: ['identity'], unique: true },
      { name: 'by_keyId', fields: ['keyId'] },
      { name: 'by_provider_status', fields: ['providerId', 'status'] },
      { name: 'by_status', fields: ['status'] },
      { name: 'by_score', fields: ['score'] },
      { name: 'by_cooldownUntil', fields: ['cooldownUntil'] },
    ],
    // A mapping names a URL, a model and a key. Removing any one of the three
    // leaves a verdict about something that no longer exists, and those rows are
    // pure noise in the health list.
    relations: [
      { store: 'providers', field: 'providerId', onDelete: 'cascade' },
      { store: 'keys', field: 'keyId', onDelete: 'cascade' },
    ],
  },
  {
    store: 'metrics',
    keyPath: 'id',
    fields: {
      // providerId::modelId - two URLs offering one model are measured apart.
      id: { type: TYPE.STRING, required: true },
      identity: { type: TYPE.STRING, required: true },
      providerId: { type: TYPE.STRING, required: true },
      modelId: { type: TYPE.STRING, required: true },
      samples: { type: TYPE.NUMBER, default: 0 },
      ttftMs: { type: TYPE.NUMBER },
      tokensPerSec: { type: TYPE.NUMBER },
      totalMs: { type: TYPE.NUMBER },
      promptTokens: { type: TYPE.NUMBER },
      completionTokens: { type: TYPE.NUMBER },
      bestTtftMs: { type: TYPE.NUMBER },
      worstTtftMs: { type: TYPE.NUMBER },
      bestTokensPerSec: { type: TYPE.NUMBER },
      lastMeasuredAt: { type: TYPE.STRING },
    },
    indexes: [
      { name: 'by_providerId', fields: ['providerId'] },
      { name: 'by_provider_model', fields: ['providerId', 'modelId'], unique: true },
    ],
    // A measurement of a URL that no longer exists would keep the URL's name in
    // the speed ranking forever.
    relations: [{ store: 'providers', field: 'providerId', onDelete: 'cascade' }],
  },
  {
    // The activity log. Written by core/scanner.js (EventLog), read back by
    // `EventLog.recent`, capped by CONFIG.eventLogLimit.
    store: 'events',
    keyPath: 'id',
    fields: {
      id: { type: TYPE.STRING, required: true },
      // Closed set: a reader has to know what a kind means to render it, so an
      // undeclared kind would be a row nothing can display.
      kind: { type: TYPE.STRING, required: true, enum: ['scan'] },
      payload: { type: TYPE.OBJECT },
      // For a person. Millisecond resolution, so several events in the same
      // millisecond share it - which is why ordering uses `seq`.
      ts: { type: TYPE.STRING, required: true },
      // Strictly increasing, assigned by the writer. `ts` alone cannot order the
      // log: two scans inside one millisecond have the same timestamp, and a log
      // whose newest-first order is a coin flip makes "what happened last"
      // unanswerable - and the retention trim keeps the wrong end.
      seq: { type: TYPE.NUMBER, required: true },
      providerId: { type: TYPE.STRING },
      modelId: { type: TYPE.STRING },
    },
    indexes: [
      { name: 'by_kind', fields: ['kind'] },
      { name: 'by_seq', fields: ['seq'] },
      { name: 'by_ts', fields: ['ts'] },
      { name: 'by_providerId', fields: ['providerId'] },
    ],
  },
  {
    store: 'deletedKeys',
    keyPath: 'id',
    fields: {
      id: { type: TYPE.STRING, required: true },
      identity: { type: TYPE.STRING, required: true },
      providerId: { type: TYPE.STRING, required: true },
      fingerprint: { type: TYPE.STRING, required: true, maxLength: 64 },
      masked: { type: TYPE.STRING },
      deletedAt: { type: TYPE.STRING, required: true },
    },
    indexes: [
      // A deleted key stays deleted, so its fingerprint is remembered even
      // though the secret is not.
      { name: 'by_identity', fields: ['identity'], unique: true },
      { name: 'by_providerId', fields: ['providerId'] },
    ],
    // The tombstone goes with the URL. Keeping it would block a key on a URL
    // the user has to add again from scratch.
    relations: [{ store: 'providers', field: 'providerId', onDelete: 'cascade' }],
  },
  {
    store: 'unresolved',
    keyPath: 'id',
    fields: {
      id: { type: TYPE.STRING, required: true },
      kind: { type: TYPE.STRING, required: true },
      fingerprint: { type: TYPE.STRING },
      masked: { type: TYPE.STRING },
      // Parked here because the URL it belongs to is not known yet. It used to
      // be stored twice, as `secret` and as `raw`, which doubled the exposure
      // of a credential for no benefit.
      secret: { type: TYPE.STRING, maxLength: 4000, secret: true },
      hint: { type: TYPE.STRING },
      createdAt: { type: TYPE.STRING, required: true },
    },
    indexes: [
      { name: 'by_kind', fields: ['kind'] },
      { name: 'by_fingerprint', fields: ['fingerprint'] },
    ],
  },
  {
    // A key/value store. The row id is the setting name and `value` is the
    // payload, so a new setting needs no schema change at all.
    store: 'settings',
    keyPath: 'id',
    fields: {
      id: { type: TYPE.STRING, required: true },
      value: { type: TYPE.OBJECT, default: {} },
      updatedAt: { type: TYPE.STRING },
    },
    indexes: [],
  },
];

/** Store name -> StoreDef */
export const STORE_MAP = Object.fromEntries(STORE_DEFS.map((d) => [d.store, d]));

/** The official store list, parents before children. */
export const STORES = STORE_DEFS.map((d) => d.store);

/** Store -> its child stores, so a delete knows what to take with it. */
export const CHILDREN_OF = Object.fromEntries(
  STORE_DEFS.map((d) => [
    d.store,
    STORE_DEFS.flatMap((child) =>
      (child.relations ?? [])
        .filter((rel) => rel.store === d.store)
        .map((rel) => ({ store: child.store, field: rel.field, onDelete: rel.onDelete }))
    ),
  ])
);

/** Look one store up, or null. */
export function storeDef(store) {
  return STORE_MAP[store] ?? null;
}

/** Look one field up, or null. */
export function fieldDef(store, field) {
  return STORE_MAP[store]?.fields?.[field] ?? null;
}

/** Fields on a store that must never be written to a file. */
export function secretFields(store) {
  const def = STORE_MAP[store];
  if (!def) return [];
  return Object.entries(def.fields)
    .filter(([, f]) => f.secret)
    .map(([name]) => name);
}

/**
 * Copy a default so two rows can never share one mutable object.
 *
 * `default: {}` on a shared reference is a live bug waiting for the first
 * `row.metadata.x = 1`: every other row of that store would see it.
 */
function cloneDefault(value) {
  if (Array.isArray(value)) return value.map(cloneDefault);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, cloneDefault(v)]));
  }
  return value;
}

/**
 * Fill in declared defaults for fields the row does not have.
 *
 * An explicit `null` is left alone: `null` is a real value here (a model with no
 * published price has `inputPrice: null`, and `0` means something quite
 * different - a published price of zero, which is the whole point of the app).
 * Only a *missing* field takes the default.
 */
export function applyDefaults(store, row) {
  const def = STORE_MAP[store];
  if (!def || !row || typeof row !== 'object') return row;
  const out = { ...row };
  for (const [name, field] of Object.entries(def.fields)) {
    if (field.default === undefined) continue;
    if (out[name] === undefined) out[name] = cloneDefault(field.default);
  }
  return out;
}

/**
 * Check a row against its store definition.
 *
 * Returns every problem rather than the first, because a caller fixing a
 * malformed import wants the whole list in one pass.
 *
 * `required` is reported but does not block a write on its own: a row written by
 * hand in a test, or a partially filled import, is a legitimate thing to store
 * and the reader copes with a missing optional field. What *does* block a write
 * is a type or enum violation, because those mean the row would be read back as
 * something the writer never meant.
 */
export function validateRow(store, row) {
  const def = STORE_MAP[store];
  if (!def) return { ok: true, errors: [] };
  if (!row || typeof row !== 'object') return { ok: false, errors: [`${store}: row must be an object`] };

  const errors = [];
  for (const [name, field] of Object.entries(def.fields)) {
    const value = row[name];

    if (value === undefined || value === null) {
      // A field that declares a default cannot really be missing: every write
      // goes through applyDefaults first, so the stored row always has it.
      // Reporting it as required would flag a correct row as broken.
      if (field.required && field.default === undefined) {
        errors.push(`${store}.${name} is required`);
      }
      continue;
    }
    if (field.enum && !field.enum.includes(value)) {
      errors.push(`${store}.${name} must be one of ${field.enum.join('|')}, got ${JSON.stringify(value)}`);
    }
    if (field.maxLength && typeof value === 'string' && value.length > field.maxLength) {
      errors.push(`${store}.${name} exceeds max length ${field.maxLength}`);
    }
    const actual = Array.isArray(value) ? TYPE.STRING_ARRAY : typeof value;
    const mismatch = field.type !== TYPE.ANY && actual !== field.type && !(field.type === TYPE.OBJECT && actual === 'object');
    if (mismatch) {
      errors.push(`${store}.${name} should be ${field.type}, got ${actual}`);
    }
  }
  return { ok: errors.length === 0, errors };
}

/** Every field the schema marks as a secret, for one row. */
export function stripSecrets(store, row) {
  if (!row || typeof row !== 'object') return row;
  const out = { ...row };
  let removed = false;
  for (const field of secretFields(store)) {
    if (out[field] === undefined) continue;
    delete out[field];
    removed = true;
  }
  return removed ? out : row;
}

/**
 * Drop internal bookkeeping before a row leaves the device.
 *
 * `_schemaVersion` was stamped onto every row by an older migration. It is not
 * read anywhere, so it is stripped rather than migrated forward.
 */
export function stripInternalFields(row) {
  if (!row || typeof row !== 'object') return row;
  if (!('_schemaVersion' in row)) return row;
  const { _schemaVersion, ...rest } = row;
  return rest;
}

// ---------------------------------------------------------------------------
// Index keys
// ---------------------------------------------------------------------------

/**
 * Can this value be an IndexedDB key?
 *
 * Numbers, strings, dates, arrays and ArrayBuffers can. Booleans and null
 * cannot: a record whose index key is not a valid key is simply left out of the
 * index, with no error anywhere. That is why an index over a boolean column is
 * not a slow index, it is an empty one.
 */
export function isIndexableValue(value) {
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'string' || value instanceof Date) return true;
  if (Array.isArray(value)) return value.every(isIndexableValue);
  return false;
}

/**
 * The key an index takes for one row.
 *
 * Returns `{ kind: 'none' }` when any part of the key is not indexable, which
 * is what both drivers treat as "this row is not in this index" - the same
 * behaviour IndexedDB has, so a query answered from an index and the same query
 * answered by a scan return the same rows.
 *
 * @returns {{kind:'none'}|{kind:'key',value:*}|{kind:'multi',values:*[]}}
 */
export function indexKeyFor(index, row) {
  const values = index.fields.map((field) => row?.[field]);
  if (values.some((value) => !isIndexableValue(value))) return { kind: 'none' };
  if (index.multiEntry) {
    const list = values[0];
    const items = (Array.isArray(list) ? list : [list]).filter(isIndexableValue);
    return items.length ? { kind: 'multi', values: items } : { kind: 'none' };
  }
  return { kind: 'key', value: values.length === 1 ? values[0] : values };
}

/**
 * A stable string form of an index key, for the memory driver's maps.
 *
 * The type is part of the key: `1` and `'1'` are different values to a query,
 * and a map keyed on the string alone would collapse them into one bucket.
 */
export function indexKeyToken(value) {
  if (Array.isArray(value)) return `[${value.map(indexKeyToken).join(',')}]`;
  if (value instanceof Date) return `d:${value.getTime()}`;
  return `${typeof value}:${String(value)}`;
}

/**
 * Indexes on a store, optionally narrowed to those whose *whole* key is
 * constrained by the query.
 *
 * @param {string} store
 * @param {Object} [where] - the query's where clause
 */
export function usableIndexes(store, where = null) {
  const def = STORE_MAP[store];
  if (!def) return [];
  const indexes = def.indexes ?? [];
  if (!where) return indexes;

  return indexes.filter((index) => {
    // A compound key is only usable when every part is pinned, because a
    // partial prefix would need a range over a nested array and buys nothing
    // over a scan at this data size.
    if (index.fields.length > 1) return index.fields.every((field) => hasEquality(where, field));
    return hasEquality(where, index.fields[0]) || hasRange(where, index.fields[0]);
  });
}

/** Is there an equality or `$in` constraint on this field? */
export function hasEquality(where, field) {
  const clause = where?.[field];
  if (clause === undefined) return false;
  if (clause === null || typeof clause !== 'object' || Array.isArray(clause)) return true;
  return '$eq' in clause || '$in' in clause;
}

/** Is there a range constraint on this field? */
export function hasRange(where, field) {
  const clause = where?.[field];
  if (!clause || typeof clause !== 'object' || Array.isArray(clause)) return false;
  return ['$gt', '$gte', '$lt', '$lte'].some((op) => op in clause);
}