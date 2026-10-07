/**
 * Query engine (database core).
 *
 * Pure functions over arrays. No storage access, no side effects, so the
 * memory driver, the IndexedDB driver and the tests all filter, sort and
 * paginate identically by construction rather than by convention.
 *
 * The one thing here that is not "pure array stuff" is `planQuery`. It looks at
 * a query and reports which index could answer it. The point is that the index
 * narrows the candidates and the ordinary predicate still decides, so a plan
 * that is wrong about an edge case costs speed and never correctness.
 */

import { isIndexableValue } from './schema.js';

/**
 * Operators a field clause may use.
 *
 * `$eq $ne $gt $gte $lt $lte $in $nin $exists` work on any value.
 * `$contains` works on a string (substring) or an array (element).
 * `$startsWith $endsWith $regex` work on strings.
 * An unrecognised operator matches, so a typo widens a query instead of
 * emptying it - a filter that silently returns nothing is far harder to notice.
 */
export const OPERATORS = [
  '$eq', '$ne', '$gt', '$gte', '$lt', '$lte', '$in', '$nin', '$exists',
  '$contains', '$startsWith', '$endsWith', '$regex', '$ne',
];

/** Build a predicate from a where clause. */
export function wherePredicate(where) {
  if (!where || typeof where !== 'object') return () => true;
  const checks = Object.entries(where).map(([field, clause]) => fieldPredicate(field, clause));
  if (checks.length === 0) return () => true;
  if (checks.length === 1) return checks[0];
  return (row) => checks.every((fn) => fn(row));
}

function fieldPredicate(field, clause) {
  if (field === '$or' && Array.isArray(clause)) {
    const subs = clause.map((cond) => wherePredicate(cond));
    return (row) => subs.some((fn) => fn(row));
  }
  if (field === '$and' && Array.isArray(clause)) {
    const subs = clause.map((cond) => wherePredicate(cond));
    return (row) => subs.every((fn) => fn(row));
  }
  if (field === '$not') {
    const inner = wherePredicate(clause);
    return (row) => !inner(row);
  }
  if (clause !== null && typeof clause === 'object' && !Array.isArray(clause)) {
    const ops = Object.entries(clause);
    return (row) => {
      const value = row[field];
      return ops.every(([op, target]) => matchOp(value, op, target));
    };
  }
  // A bare value: `null` is the one case that cannot go through `===`, because a
  // row missing the field is also absent and has to match `null` explicitly.
  if (clause === null) return (row) => row[field] === null || row[field] === undefined;
  return (row) => row[field] === clause;
}

/**
 * Apply one operator to one value.
 *
 * The null handling below is the whole reason this function is careful.
 *
 * A row whose compared field is `null` or missing is not in that field's index -
 * `null` is not a valid IndexedDB key. So if a range operator matched it, an
 * index-backed query and a scan would return different rows for the same
 * question, and the difference would only appear in a browser. Which means: a
 * range, and an equality against a non-null value, match only rows that carry a
 * comparable value. "No cooldown set" is not "cooldown of zero", and treating it
 * as one would put every never-probed mapping into the cooling set.
 *
 * `$ne`, `$nin` and `$exists` are the operators for "does not have this", and
 * they do match those rows.
 */
export function matchOp(value, op, target) {
  const absent = value === undefined || value === null;

  switch (op) {
    case '$eq':
      return absent ? target === null : value === target;
    case '$ne':
      return absent ? target !== null : value !== target;
    case '$gt': return !absent && value > target;
    case '$gte': return !absent && value >= target;
    case '$lt': return !absent && value < target;
    case '$lte': return !absent && value <= target;
    case '$in': return Array.isArray(target) && target.includes(value);
    case '$nin': return !Array.isArray(target) || !target.includes(value);
    case '$exists':
      return target ? !absent : absent;
    case '$contains':
      if (typeof target === 'string' && typeof value === 'string') return value.includes(target);
      if (Array.isArray(value)) return value.includes(target);
      return false;
    case '$startsWith':
      return typeof value === 'string' && typeof target === 'string' && value.startsWith(target);
    case '$endsWith':
      return typeof value === 'string' && typeof target === 'string' && value.endsWith(target);
    case '$regex':
      if (target instanceof RegExp) return target.test(String(value ?? ''));
      if (typeof target === 'string') {
        try { return new RegExp(target, 'i').test(String(value ?? '')); } catch { return false; }
      }
      return false;
    default:
      return true;
  }
}

/** Comparator for a sort clause. Nulls last, in both directions. */
export function sortComparator(sort) {
  if (!sort || typeof sort !== 'object') return null;
  const entries = Object.entries(sort);
  if (entries.length === 0) return null;

  return (a, b) => {
    for (const [field, dir] of entries) {
      const left = a[field];
      const right = b[field];
      if (left === right) continue;
      // A missing value is not "smallest": it is unknown, and unknown sorts to
      // the end so a measured row is never pushed behind an unmeasured one.
      if (left === undefined || left === null) return 1;
      if (right === undefined || right === null) return -1;
      const cmp = left < right ? -1 : 1;
      if (dir === 'DESC' || dir === 'desc') return -cmp;
      return cmp;
    }
    return 0;
  };
}

/**
 * Filter, sort, page and project a result set.
 *
 * @param {Array} rows
 * @param {Object} [query] - { where, sort, limit, offset, select }
 */
export function applyQuery(rows, query = {}) {
  let out = rows;

  if (query.where) out = out.filter(wherePredicate(query.where));

  if (query.sort) {
    const cmp = sortComparator(query.sort);
    if (cmp) out = [...out].sort(cmp);
  }

  const offset = query.offset ?? 0;
  if (query.limit !== undefined) out = out.slice(offset, offset + query.limit);
  else if (offset > 0) out = out.slice(offset);

  if (query.select) out = out.map((row) => project(row, query.select));
  return out;
}

/**
 * Query option keys.
 *
 * `count` accepts either a bare where clause or a whole query object, and this
 * is how the two are told apart. It is unambiguous because a field name cannot
 * be one of these: every store's columns are declared in schema.js and none is
 * called `where`, `sort` or `limit`.
 */
export const QUERY_KEYS = ['where', 'sort', 'limit', 'offset', 'select', '_forceScan'];

/** Is this argument a whole query rather than a bare where clause? */
export function isQueryObject(value) {
  return Boolean(value) && typeof value === 'object' && QUERY_KEYS.some((key) => key in value);
}

/** The where clause of an argument that may be either shape. */
export function whereOf(value) {
  if (!value) return null;
  return isQueryObject(value) ? (value.where ?? null) : value;
}

/** Keep only the named fields, always including the primary key. */
export function project(row, select) {
  const fields = Array.isArray(select) ? select : [select];
  const out = {};
  for (const field of fields) {
    if (field in row) out[field] = row[field];
  }
  return out;
}

/**
 * Which index could narrow this query, and how.
 *
 * Returns `{ index, kind, keys }` where `kind` is:
 *   'point' - every field of the index is pinned by equality; `keys` is the
 *             list of key values to look up (more than one for `$in`)
 *   'range' - the index's single field is bounded; `keys` is the raw clause
 *   null    - no index applies, so the whole store has to be scanned
 *
 * The caller still applies the full predicate to whatever comes back. That
 * redundancy is deliberate: it means a plan can only ever make a query faster,
 * never change its answer.
 *
 * `_forceScan: true` in the query suppresses the index. It exists so a caller -
 * and the test suite - can ask the same question the slow way and compare. A
 * test that only ever sees the indexed answer is not checking the index.
 */
export function planQuery(storeDef, query = {}) {
  if (query?._forceScan) return { index: null, kind: null, keys: null };

  const where = query.where ?? null;
  const indexes = storeDef?.indexes ?? [];
  if (!where) return { index: null, kind: null, keys: null };

  let best = null;

  for (const index of indexes) {
    const plan = planForIndex(index, where);
    if (!plan) continue;
    // A point lookup beats a range, and among equals the narrower key wins.
    const rank = (plan.kind === 'point' ? 2 : 1) * 100 + index.fields.length;
    if (!best || rank > best.rank) best = { ...plan, index, rank };
  }

  if (!best) return { index: null, kind: null, keys: null };
  const { rank, ...rest } = best;
  return rest;
}

function planForIndex(index, where) {
  const values = index.fields.map((field) => equalityFor(where, field));
  if (values.every((v) => v !== undefined)) {
    if (index.fields.length === 1) {
      // `$in` becomes several lookups; the driver merges what they return.
      const one = values[0];
      const keys = Array.isArray(one) ? [...one] : [one];
      // A value IndexedDB cannot use as a key is in no index at all, so looking
      // it up would answer "nothing" while a scan answers "the rows that have
      // it". `{ cooldownUntil: null }` is the case that matters: exactly those
      // rows are the ones an index cannot see.
      if (keys.some((key) => !isIndexableValue(key))) return null;
      return { kind: 'point', keys };
    }
    // Compound: one lookup, keyed by the array of field values.
    const key = values.map((v) => (Array.isArray(v) ? v[0] : v));
    if (key.some((part) => !isIndexableValue(part))) return null;
    return { kind: 'point', keys: [key] };
  }

  if (index.fields.length !== 1) return null;

  const clause = where[index.fields[0]];
  if (!clause || typeof clause !== 'object' || Array.isArray(clause)) return null;
  if (!['$gt', '$gte', '$lt', '$lte'].some((op) => op in clause)) return null;
  return { kind: 'range', keys: clause };
}

/**
 * The value a field is pinned to, or undefined when it is not pinned.
 * `undefined` doubles as "not pinned" and "pinned to undefined", which is fine:
 * a row that does not carry a field is not in that index either.
 */
function equalityFor(where, field) {
  const clause = where[field];
  if (clause === undefined) return undefined;
  if (clause === null || typeof clause !== 'object' || Array.isArray(clause)) return clause;
  if ('$eq' in clause) return clause.$eq;
  if ('$in' in clause && Array.isArray(clause.$in)) return clause.$in;
  return undefined;
}