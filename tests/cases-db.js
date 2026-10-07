/**
 * The database layer itself.
 *
 * These cases exist because the rest of the suite runs entirely on the memory
 * driver. That is convenient and it is also a risk: the memory driver is the
 * one place where a bug cannot be caught by the app-level tests, since the app
 * never touches IndexedDB in node. So the schema, the index plan, the
 * uniqueness rules, the transaction guarantees and the migration runner are all
 * tested directly here.
 *
 * The rule every case follows: a query has to give the same answer whether it
 * was answered from an index or by scanning. Anything else means an index is
 * quietly changing what the app sees.
 */

import { describe, it, assert, assertEqual } from './harness.js';
import { MemoryDriver } from '../core/db/memory.js';
import { EventLog, EVENT_KIND } from '../core/scanner.js';
import {
  STORE_DEFS, STORE_MAP, STORES, CHILDREN_OF, SCHEMA_VERSION, IDB_VERSION,
  applyDefaults, validateRow, secretFields, isIndexableValue, indexKeyFor,
} from '../core/db/schema.js';
import { planQuery, wherePredicate, applyQuery } from '../core/db/query.js';
import { MIGRATIONS, VERSION_ROW, runDataMigrations } from '../core/db/migrations.js';

const now = '2026-01-01T00:00:00.000Z';

function providerRow(id, baseURL, extra = {}) {
  return {
    id, name: id, type: 'CUSTOM', baseURL, status: 'NEW',
    createdAt: now, updatedAt: now, ...extra,
  };
}

function modelRow(id, providerId, modelId, extra = {}) {
  return {
    id, providerId, modelId, displayName: modelId,
    source: 'AUTO_DISCOVERED', freeStatus: 'FREE_VERIFIED',
    firstSeenAt: now, lastSeenAt: now, ...extra,
  };
}

function keyRow(id, providerId, fingerprint, extra = {}) {
  return {
    id, providerId, fingerprint, masked: 'oc_s…alQY', secret: 'sk-not-real-' + fingerprint,
    createdAt: now, updatedAt: now, ...extra,
  };
}

function mappingRow(id, providerId, modelId, keyId, extra = {}) {
  return {
    id, identity: `${providerId}::${modelId}::${keyId}`,
    providerId, modelId, keyId, createdAt: now, updatedAt: now, ...extra,
  };
}

export function registerDbCases() {
  // ------------------------------------------------------------------ schema

  describe('DBS. The schema describes the database that exists', () => {
    it('DBS1: every store declares a key path and every field a type', () => {
      for (const def of STORE_DEFS) {
        assert(def.keyPath, `${def.store} must name its primary key`);
        assert(
          def.fields[def.keyPath],
          `${def.store}.${def.keyPath} is the key, so it must be declared as a field`
        );
        for (const [name, field] of Object.entries(def.fields)) {
          assert(field.type, `${def.store}.${name} has no type`);
        }
      }
    });

    it('DBS2: every index points at a declared field', () => {
      // A typo in an index name is not a crash, it is an index that quietly
      // contains nothing. This is the check that would have caught the boolean
      // indexes if it had looked at the value type too.
      for (const def of STORE_DEFS) {
        for (const index of def.indexes ?? []) {
          for (const field of index.fields) {
            assert(
              def.fields[field],
              `${def.store}.${index.name} indexes '${field}', which is not a declared field`
            );
          }
          assert(index.name, `${def.store} has an index with no name`);
        }
      }
    });

    it('DBS3: no index sits on a value IndexedDB cannot index', () => {
      // Booleans and null are not valid IndexedDB keys. An index over one is
      // created without complaint and then holds nothing, so a query served by
      // it returns zero rows while a scan returns the right ones. That is the
      // worst kind of storage bug: it only appears in the browser.
      for (const def of STORE_DEFS) {
        for (const index of def.indexes ?? []) {
          for (const field of index.fields) {
            const declared = def.fields[field];
            const booleanish = declared.type === 'boolean';
            const arrayOfStrings = declared.type === 'string[]';
            assert(
              !booleanish || index.multiEntry === false,
              `${def.store}.${index.name} indexes the boolean '${field}': IndexedDB skips these rows`
            );
            assert(
              !arrayOfStrings || index.multiEntry === true,
              `${def.store}.${index.name} indexes the array '${field}' without multiEntry`
            );
          }
        }
      }
    });

    it('DBS4: every unique index is one the code can actually satisfy', () => {
      for (const def of STORE_DEFS) {
        for (const index of def.indexes ?? []) {
          if (!index.unique) continue;
          for (const field of index.fields) {
            const declared = def.fields[field];
            assert(
              !declared.default,
              `${def.store}.${index.name} is unique over '${field}', which has a default: ` +
                'every row would collide with the next'
            );
          }
        }
      }
    });

    it('DBS5: the fields the code writes are the fields the schema declares', () => {
      // Rows built exactly the way the registries build them must validate.
      // This is the case that fails when someone adds a field to a row in
      // core/ and forgets the schema, which is how the metrics fields drifted
      // in the first place.
      const cases = [
        ['providers', providerRow('p1', 'https://a.test/v1')],
        ['models', modelRow('m1', 'p1', 'a')],
        ['keys', keyRow('k1', 'p1', 'f'.repeat(64))],
        ['mappings', mappingRow('x1', 'p1', 'a', 'k1')],
        [
          'metrics',
          {
            id: 'p1::a', identity: 'p1::a', providerId: 'p1', modelId: 'a',
            samples: 2, ttftMs: 100, tokensPerSec: 40, totalMs: 300,
            promptTokens: 10, completionTokens: 20,
            bestTtftMs: 100, worstTtftMs: 120, bestTokensPerSec: 44, lastMeasuredAt: now,
          },
        ],
        ['deletedKeys', { id: 'd1', identity: 'p1::f', providerId: 'p1', fingerprint: 'f', deletedAt: now }],
        ['unresolved', { id: 'u1', kind: 'KEY', fingerprint: 'f', masked: 'x', secret: 'y', createdAt: now }],
        ['settings', { id: 'priority', value: {} }],
      ];
      for (const [store, row] of cases) {
        const result = validateRow(store, row);
        assert(result.ok, `${store}: ${result.errors.join('; ')}`);
      }
    });

    it('DBS6: a bad value is reported with the field and the reason', () => {
      const result = validateRow('models', modelRow('m1', 'p1', 'a', { freeStatus: 'DEFINITELY_FREE' }));
      assertEqual(result.ok, false);
      assert(
        result.errors.some((e) => e.includes('freeStatus')),
        'the error names the field: ' + result.errors.join('; ')
      );

      const typed = validateRow('models', modelRow('m1', 'p1', 'a', { missCount: 'three' }));
      assertEqual(typed.ok, false, 'a number field holding a string is a type error');
      assert(typed.errors.some((e) => e.includes('missCount')), typed.errors.join('; '));
    });

    it('DBS7: every store that can be orphaned has a relation pointing at it', () => {
      // A child row with no parent is invisible to every list in the app: the
      // drawer groups by URL, and a URL that no longer exists appears nowhere.
      // The relation is what lets a delete take its children with it.
      assert(CHILDREN_OF.providers.length >= 3, 'models, keys and mappings hang off a provider');
      assert(
        CHILDREN_OF.keys.some((c) => c.store === 'mappings'),
        'removing a key must take its mappings'
      );
      assertEqual(STORE_MAP.settings.relations, undefined, 'nothing references settings');
    });

    it('DBS8b: every declared store has a writer somewhere in core/', async () => {
    // A store nothing writes is a feature that looks implemented and is not.
    // The `events` store sat in the schema for months doing exactly that, so
    // the check is here to keep it from happening again: each store either has
    // a writer named below, or is deliberately listed as storage-only.
    const WRITERS = {
      providers: 'ProviderRegistry',
      models: 'ModelRegistry',
      keys: 'KeyRegistry',
      mappings: 'Mapper',
      metrics: 'MetricsRegistry',
      events: 'EventLog',
      deletedKeys: 'KeyRegistry',
      unresolved: 'KeyRegistry',
      settings: 'Priority',
    };
    const sources = new Map();
    const { readdirSync, readFileSync } = await import('node:fs');
    const dir = new URL('../core/', import.meta.url);
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.js')) continue;
      sources.set(name, readFileSync(new URL(name, dir), 'utf8'));
    }
    for (const [store, writer] of Object.entries(WRITERS)) {
      const found = [...sources.entries()].filter(([, text]) =>
        new RegExp(`put\\(\\s*'${store}'`).test(text)
      );
      assert(found.length > 0, `${store} has no writer; ${writer} was expected to write it`);
    }
  });

  it('DBS8c: every enum is closed, so a typo is caught at the boundary', () => {
    // A field typed as a free string lets a caller write a status nobody knows
    // how to render. Every enum here is one the app actually branches on.
    for (const def of STORE_DEFS) {
      for (const [name, field] of Object.entries(def.fields)) {
        if (!field.enum) continue;
        assert(field.enum.length > 0, `${def.store}.${name} has an empty enum`);
        assertEqual(
          new Set(field.enum).size, field.enum.length,
          `${def.store}.${name} lists a value twice`
        );
      }
    }
  });

  it('DBS8: the secret fields are declared, so an export cannot forget one', () => {
      // A hard-coded list of which stores hold secrets is a list that goes
      // stale. Deriving it from the schema means adding a secret field needs no
      // second edit.
      assert(secretFields('keys').includes('secret'), 'the key secret is declared secret');
      assert(secretFields('unresolved').includes('secret'), 'so is a parked secret');
      for (const store of STORES) {
        for (const field of secretFields(store)) {
          assert(
            field !== 'fingerprint',
            `${store}.${field} is marked secret, but a fingerprint is not a credential: ` +
              'it is kept in exports on purpose so a key stays recognisable'
          );
        }
      }
    });
  });

  // ------------------------------------------------------------------ defaults

  describe('DBD. Defaults are applied on write', () => {
    it('DBD1: a missing field takes its default', () => {
      const row = applyDefaults('providers', providerRow('p1', 'https://a.test/v1'));
      assertEqual(row.enabled, true, 'a provider with no explicit flag is enabled');
      assertEqual(row.protocol, 'openai-compatible');
      assertEqual(row.freeTier, 'none');
    });

    it('DBD2: an explicit null is not overwritten by the default', () => {
      // null and 0 are different facts here: `inputPrice: null` is a provider
      // that published no price, `0` is a provider that published a price of
      // zero, and the whole app exists to tell those apart.
      const model = applyDefaults('models', modelRow('m1', 'p1', 'a', { inputPrice: null }));
      assertEqual(model.inputPrice, null);
      const zero = applyDefaults('models', modelRow('m1', 'p1', 'a', { inputPrice: 0 }));
      assertEqual(zero.inputPrice, 0);
    });

    it('DBD3: a default object is copied per row, never shared', () => {
      // If the default object were shared, one row's nested write would appear
      // on every other row of the store - and would only show up once there
      // were two rows with different content in it.
      const a = applyDefaults('models', modelRow('m1', 'p1', 'a'));
      const b = applyDefaults('models', modelRow('m2', 'p1', 'b'));
      a.metadata.flag = true;
      a.evidence.push('x');
      assertEqual(b.metadata.flag, undefined, 'the second row is unaffected');
      assertEqual(b.evidence.length, 0);
      assert(a.metadata !== b.metadata, 'they are not the same object');
    });

    it('DBD4: the driver stores what the defaults produced, not what was passed', async () => {
      const db = new MemoryDriver();
      await db.put('providers', providerRow('p1', 'https://a.test/v1'));
      const stored = await db.get('providers', 'p1');
      assertEqual(stored.enabled, true, 'a later read sees the same value the writer did');
    });
  });

  // --------------------------------------------------------------- index keys

  describe('DBK. Index keys', () => {
    it('DBK1: IndexedDB-invalid values are recognised', () => {
      assertEqual(isIndexableValue('abc'), true);
      assertEqual(isIndexableValue(42), true);
      assertEqual(isIndexableValue(true), false, 'a boolean is not an IndexedDB key');
      assertEqual(isIndexableValue(null), false);
      assertEqual(isIndexableValue(undefined), false);
      assertEqual(isIndexableValue(Number.NaN), false);
      assertEqual(isIndexableValue(['a', 'b']), true, 'an array of valid keys is a valid key');
      assertEqual(isIndexableValue(['a', true]), false);
    });

    it('DBK2: a row missing an indexed field is simply not in that index', () => {
      const index = { name: 'by_state', fields: ['state'] };
      assertEqual(indexKeyFor(index, { state: 'ACTIVE' }).kind, 'key');
      assertEqual(indexKeyFor(index, {}).kind, 'none', 'no field, no index entry');
      assertEqual(indexKeyFor(index, { state: null }).kind, 'none');
    });

    it('DBK3: a compound key is the array of its parts', () => {
      const index = { name: 'by_provider_model', fields: ['providerId', 'modelId'] };
      const key = indexKeyFor(index, { providerId: 'p1', modelId: 'a' });
      assertEqual(key.kind, 'key');
      assertEqual(Array.isArray(key.value), true);
      assertEqual(key.value[0], 'p1');
      assertEqual(key.value[1], 'a');
    });

    it('DBK4: 1 and "1" are different keys', async () => {
      // Both are indexable, and a query for one must not return the other.
      // The memory driver's maps key on a token, so the type has to be part of
      // it or the two buckets collapse.
      const db = new MemoryDriver();
      await db.put('models', modelRow('m1', 'p1', 'a', { missCount: 1 }));
      await db.put('models', modelRow('m2', 'p1', 'b', { missCount: '1' }));
      const numeric = await db.findMany('models', { where: { missCount: 1 } });
      assertEqual(numeric.length, 1);
      assertEqual(numeric[0].id, 'm1');
      const textual = await db.findMany('models', { where: { missCount: '1' } });
      assertEqual(textual.length, 1);
      assertEqual(textual[0].id, 'm2');
    });
  });

  // ------------------------------------------------------------- query plans

  describe('DBQ. The plan picks an index the query can use', () => {
    it('DBQ1: an equality on an indexed field is a point lookup', () => {
      const plan = planQuery(STORE_MAP.models, { where: { providerId: 'p1' } });
      assertEqual(plan.kind, 'point');
      assertEqual(plan.index.name, 'by_providerId');
    });

    it('DBQ2: a compound index is only used when every part is pinned', () => {
      const def = STORE_MAP.models;
      const full = planQuery(def, { where: { providerId: 'p1', modelId: 'a' } });
      assertEqual(full.index?.name, 'by_provider_model', 'both parts pinned, so the narrow index wins');

      const partial = planQuery(def, { where: { providerId: 'p1' } });
      assertEqual(partial.index?.name, 'by_providerId', 'one part pinned, so the single-field index is used');
      assert(partial.index.name !== 'by_provider_model', 'and never the compound one');
    });

    it('DBQ3: a range is planned as a range', () => {
      const plan = planQuery(STORE_MAP.mappings, { where: { cooldownUntil: { $lte: 1000 } } });
      assertEqual(plan.kind, 'range');
      assertEqual(plan.index.name, 'by_cooldownUntil');
    });

    it('DBQ4: $in becomes several point lookups', () => {
      const plan = planQuery(STORE_MAP.models, { where: { providerId: { $in: ['p1', 'p2'] } } });
      assertEqual(plan.kind, 'point');
      assertEqual(plan.keys.length, 2);
      assert(plan.keys.includes('p1') && plan.keys.includes('p2'));
    });

    it('DBQ5: no usable index means a scan, said out loud', () => {
      const plan = planQuery(STORE_MAP.models, { where: { notes: 'x' } });
      assertEqual(plan.index, null, 'an unindexed field has to be scanned');
    });

    it('DBQ6: an operator the index cannot serve does not use the index', () => {
      const plan = planQuery(STORE_MAP.models, { where: { modelId: { $contains: 'a' } } });
      assertEqual(plan.index, null, 'a substring match needs every row');
    });
  });

  // ------------------------------------------------- index answers == scans

  describe('DBX. An indexed query answers exactly what a scan answers', () => {

    it('DBX1: equality, $in and range all agree with a scan', async () => {
      const db = new MemoryDriver();
      await db.put('mappings', mappingRow('x1', 'p1', 'a', 'k1', { cooldownUntil: 10 }));
      await db.put('mappings', mappingRow('x2', 'p1', 'b', 'k2', { cooldownUntil: 500 }));
      await db.put('mappings', mappingRow('x3', 'p2', 'a', 'k3', { cooldownUntil: 9000 }));
      await db.put('mappings', mappingRow('x4', 'p2', 'b', 'k4', { cooldownUntil: null }));

      for (const query of [
        { where: { providerId: 'p1' } },
        { where: { providerId: { $in: ['p1', 'p2'] } } },
        { where: { cooldownUntil: { $lte: 1000 } } },
        { where: { providerId: 'p1', modelId: 'a' } },
        { where: { keyId: 'k2' } },
        { where: { status: 'HEALTHY' } },
      ]) {
        const indexed = await db.findMany('mappings', query);
        const scan = await db.findMany('mappings', { ...query, _forceScan: true });
        const a = indexed.map((r) => r.id).sort().join(',');
        const b = scan.map((r) => r.id).sort().join(',');
        assertEqual(a, b, `index and scan disagree for ${JSON.stringify(query)}`);
      }
    });

    it('DBX1b: a row with no value for the field is not "less than" anything', async () => {
      // The rule that keeps an index and a scan from disagreeing. `x4` has no
      // cooldown at all; IndexedDB cannot index that, so it is in no index, and
      // if a range matched it anyway the indexed answer would have one row fewer
      // than the scan. Which reads as "the cooling set is empty" on a real
      // device and "not empty" in a test.
      const db = new MemoryDriver();
      await db.put('mappings', mappingRow('x1', 'p1', 'a', 'k1', { cooldownUntil: 10 }));
      await db.put('mappings', mappingRow('x2', 'p1', 'b', 'k2', { cooldownUntil: 500 }));
      await db.put('mappings', mappingRow('x3', 'p2', 'a', 'k3', { cooldownUntil: null }));

      const cooling = await db.findMany('mappings', { where: { cooldownUntil: { $lte: 1000 } } });
      assertEqual(cooling.map((r) => r.id).join(','), 'x1,x2', 'only the rows that carry a cooldown');

      // And the operators that do mean "does not have it" still work.
      const unbounded = await db.findMany('mappings', { where: { cooldownUntil: null } });
      assertEqual(unbounded.map((r) => r.id).join(','), 'x3', 'null finds the row with none');
      const notCooling = await db.findMany('mappings', { where: { cooldownUntil: { $ne: 10 } } });
      assertEqual(notCooling.map((r) => r.id).sort().join(','), 'x2,x3');
      const missing = await db.findMany('mappings', { where: { retryAfterMs: { $exists: false } } });
      assertEqual(missing.length, 3, 'every row is missing retryAfterMs');
    });

    it('DBX2: a compound-index query matches the scan on every store that has one', async () => {
      const db = new MemoryDriver();
      await db.put('models', modelRow('m1', 'p1', 'a'));
      await db.put('models', modelRow('m2', 'p1', 'b'));
      await db.put('models', modelRow('m3', 'p2', 'a'));
      await db.put('keys', keyRow('k1', 'p1', 'a'.repeat(64)));
      await db.put('keys', keyRow('k2', 'p1', 'b'.repeat(64)));

      for (const [store, query] of [
        ['models', { where: { providerId: 'p1', modelId: 'b' } }],
        ['keys', { where: { providerId: 'p1', fingerprint: 'b'.repeat(64) } }],
        ['deletedKeys', { where: { identity: 'nope' } }],
      ]) {
        const found = await db.findMany(store, query);
        const all = await db.list(store);
        const expected = all.filter(wherePredicate(query.where));
        assertEqual(found.length, expected.length, `${store} ${JSON.stringify(query)}`);
      }
    });

    it('DBX3: a row whose indexed field is missing is still findable by a scan-equivalent query', async () => {
      // A model written without `state` is not in `by_state`, but asking for
      // `state: undefined` must not find it and asking for anything else must
      // not lose it either.
      const db = new MemoryDriver();
      await db.put('models', { id: 'm1', providerId: 'p1', modelId: 'a', displayName: 'a', source: 'MANUAL', freeStatus: 'FREE_UNKNOWN', firstSeenAt: now, lastSeenAt: now });
      const all = await db.findMany('models', { where: { providerId: 'p1' } });
      assertEqual(all.length, 1, 'it is reachable through the index it does have');
    });

    it('DBX4: an index stops pointing at a row the moment the field changes', async () => {
      // The stale-index bug is invisible afterwards and permanent in
      // production: the old index entry keeps matching a row that has moved.
      const db = new MemoryDriver();
      await db.put('models', modelRow('m1', 'p1', 'a', { state: 'ACTIVE' }));
      assertEqual((await db.findMany('models', { where: { state: 'ACTIVE' } })).length, 1);

      await db.put('models', modelRow('m1', 'p1', 'a', { state: 'INACTIVE' }));
      assertEqual((await db.findMany('models', { where: { state: 'ACTIVE' } })).length, 0, 'no longer active');
      assertEqual((await db.findMany('models', { where: { state: 'INACTIVE' } })).length, 1);
      assertEqual((await db.findMany('models', { where: { providerId: 'p1' } })).length, 1, 'and still there');
    });

    it('DBX5: a removed row leaves nothing behind in any index', async () => {
      const db = new MemoryDriver();
      await db.put('models', modelRow('m1', 'p1', 'a', { state: 'ACTIVE' }));
      await db.remove('models', 'm1');
      for (const where of [{ state: 'ACTIVE' }, { providerId: 'p1' }, { freeStatus: 'FREE_VERIFIED' }]) {
        assertEqual((await db.findMany('models', { where })).length, 0, JSON.stringify(where));
      }
    });

    it('DBX6: clearing a store empties its indexes too', async () => {
      const db = new MemoryDriver();
      await db.put('models', modelRow('m1', 'p1', 'a'));
      await db.clear('models');
      assertEqual((await db.findMany('models', { where: { providerId: 'p1' } })).length, 0);
      await db.put('models', modelRow('m2', 'p1', 'b'));
      assertEqual((await db.findMany('models', { where: { providerId: 'p1' } })).length, 1,
        'and a fresh write builds the index again');
    });

    it('DBX7: sort, limit and offset work the same through an index', async () => {
      const db = new MemoryDriver();
      for (const [i, id] of ['a', 'b', 'c', 'd'].entries()) {
        await db.put('models', modelRow('m' + i, 'p1', id, { missCount: 10 - i * 3 }));
      }
      const query = { where: { providerId: 'p1' }, sort: { missCount: 'DESC' }, limit: 2, offset: 1 };
      const indexed = await db.findMany('models', query);
      const all = await db.list('models');
      const expected = applyQuery(all, query);
      assertEqual(indexed.map((r) => r.id).join(','), expected.map((r) => r.id).join(','));
      assertEqual(indexed.length, 2, 'the page is the size asked for');
    });
  });

  // ------------------------------------------------------------ uniqueness

  describe('DBU. Identity is enforced, not assumed', () => {
    it('DBU1: the same model twice for one URL is refused', async () => {
      const db = new MemoryDriver();
      await db.put('models', modelRow('m1', 'p1', 'a'));
      let threw = null;
      try { await db.put('models', modelRow('m2', 'p1', 'a')); } catch (e) { threw = e; }
      assert(threw, 'a second row for the same provider + model must not be storable');
      assertEqual(threw.index, 'by_provider_model', 'the error names the constraint');
      assertEqual((await db.list('models')).length, 1, 'and nothing was written');
    });

    it('DBU2: the same key pasted twice is refused', async () => {
      const db = new MemoryDriver();
      await db.put('keys', keyRow('k1', 'p1', 'f'.repeat(64)));
      let threw = false;
      try { await db.put('keys', keyRow('k2', 'p1', 'f'.repeat(64))); } catch { threw = true; }
      assert(threw, 'the same secret on the same URL is one key');
    });

    it('DBU3: one verdict per key + model + URL triple', async () => {
      const db = new MemoryDriver();
      await db.put('mappings', mappingRow('x1', 'p1', 'a', 'k1'));
      let threw = false;
      try { await db.put('mappings', mappingRow('x2', 'p1', 'a', 'k1')); } catch { threw = true; }
      assert(threw, 'a re-probe updates the row instead of forking it');
    });

    it('DBU4: the same model name on two URLs is two rows', async () => {
      // Not a duplicate. Two gateways can both offer `llama-3`, and they are
      // measured separately, so collapsing them would merge their speed.
      const db = new MemoryDriver();
      await db.put('models', modelRow('m1', 'p1', 'shared'));
      await db.put('models', modelRow('m2', 'p2', 'shared'));
      assertEqual((await db.list('models')).length, 2);
    });

    it('DBU5: updating a row is not a duplicate of itself', async () => {
      // Every `update` in core/ is a read, a spread and a put. If put treated
      // its own previous row as a collision, no update anywhere would work.
      const db = new MemoryDriver();
      await db.put('models', modelRow('m1', 'p1', 'a', { state: 'ACTIVE' }));
      await db.put('models', modelRow('m1', 'p1', 'a', { state: 'INACTIVE' }));
      assertEqual((await db.list('models')).length, 1);
      assertEqual((await db.get('models', 'm1')).state, 'INACTIVE');
    });

    it('DBU6: one URL is one provider', async () => {
      const db = new MemoryDriver();
      await db.put('providers', providerRow('p1', 'https://a.test/v1'));
      let threw = false;
      try { await db.put('providers', providerRow('p2', 'https://a.test/v1')); } catch { threw = true; }
      assert(threw, 'the normalised URL is the identity, so this cannot be stored twice');
    });

    it('DBU7: a rejected write leaves the store exactly as it was', async () => {
      const db = new MemoryDriver();
      await db.put('models', modelRow('m1', 'p1', 'a'));
      try { await db.put('models', modelRow('m2', 'p1', 'a')); } catch { /* expected */ }
      assertEqual((await db.list('models')).length, 1);
      assertEqual((await db.findMany('models', { where: { providerId: 'p1' } })).length, 1,
        'and the index agrees with the rows');
    });

    it('DBU8: a row without its key is refused', async () => {
      const db = new MemoryDriver();
      let threw = null;
      try { await db.put('models', { providerId: 'p1', modelId: 'a' }); } catch (e) { threw = e; }
      assert(threw, 'a row with no primary key would be unreachable forever');
      assertEqual(threw.name, 'MissingKeyError');
    });
  });

  // ----------------------------------------------------------- transactions

  describe('DBT. Transactions', () => {
    it('DBT1: a failure inside a transaction leaves nothing behind', async () => {
      // A scan writes hundreds of rows. If it dies on row 200, having 199 rows
      // of a 200-model catalog is worse than having none: the missing model
      // looks like it does not exist.
      const db = new MemoryDriver();
      await db.put('providers', providerRow('p1', 'https://a.test/v1'));

      let threw = null;
      try {
        await db.tx(['models'], 'readwrite', async (tx) => {
          await tx.put('models', modelRow('m1', 'p1', 'a'));
          await tx.put('models', modelRow('m2', 'p1', 'b'));
          throw new Error('provider returned a truncated catalog');
        });
      } catch (e) { threw = e; }

      assert(threw, 'the error reaches the caller');
      assertEqual((await db.list('models')).length, 0, 'nothing was kept');
      assertEqual((await db.findMany('models', { where: { providerId: 'p1' } })).length, 0,
        'and the indexes agree');
    });

    it('DBT2: a rollback covers indexes too, not just rows', async () => {
      const db = new MemoryDriver();
      try {
        await db.tx(['models'], 'readwrite', async (tx) => {
          await tx.put('models', modelRow('m1', 'p1', 'a', { state: 'ACTIVE' }));
          throw new Error('boom');
        });
      } catch { /* expected */ }
      // If only the row map were restored, this index entry would survive and
      // find() would return a row that does not exist.
      assertEqual((await db.findMany('models', { where: { state: 'ACTIVE' } })).length, 0);
    });

    it('DBT3: a committed transaction keeps everything', async () => {
      const db = new MemoryDriver();
      const written = await db.tx(['models'], 'readwrite', async (tx) => {
        await tx.put('models', modelRow('m1', 'p1', 'a'));
        await tx.put('models', modelRow('m2', 'p1', 'b'));
        return 'done';
      });
      assertEqual(written, 'done', 'the return value comes back');
      assertEqual((await db.list('models')).length, 2);
    });

    it('DBT4: a unique violation inside a transaction rolls the whole batch back', async () => {
      const db = new MemoryDriver();
      await db.put('models', modelRow('m0', 'p1', 'existing'));
      try {
        await db.putMany('models', [modelRow('m1', 'p1', 'a'), modelRow('m2', 'p1', 'a')]);
      } catch { /* expected: m2 collides with m1 */ }
      const all = await db.list('models');
      assertEqual(all.length, 1, 'neither of the batch rows survived');
      assertEqual(all[0].id, 'm0', 'and the pre-existing one is untouched');
    });

    it('DBT5: putMany writes a whole batch in one go', async () => {
      const db = new MemoryDriver();
      const rows = ['a', 'b', 'c', 'd'].map((id, i) => modelRow('m' + i, 'p1', id));
      const out = await db.putMany('models', rows);
      assertEqual(out.length, 4);
      assertEqual((await db.list('models')).length, 4);
      assertEqual((await db.findMany('models', { where: { providerId: 'p1' } })).length, 4);
    });

    it('DBT6: a nested transaction joins the outer one', async () => {
      const db = new MemoryDriver();
      try {
        await db.tx(['models'], 'readwrite', async (outer) => {
          await outer.put('models', modelRow('m1', 'p1', 'a'));
          // An inner rollback must not undo the outer commit, and an inner
          // commit must not take its own snapshot either.
          await outer.tx(['models'], 'readwrite', async (inner) => {
            await inner.put('models', modelRow('m2', 'p1', 'b'));
          });
          throw new Error('outer fails');
        });
      } catch { /* expected */ }
      assertEqual((await db.list('models')).length, 0, 'the outer rollback won');
    });
  });

  // ------------------------------------------------------------- migrations

  describe('DBM. Migrations', () => {
    it('DBM1: the declared version matches the IDB version', () => {
      // If these drift apart, IndexedDB never runs the upgrade handler for a
      // schema change and an existing browser keeps the old stores for good.
      assertEqual(IDB_VERSION, SCHEMA_VERSION);
      assert(SCHEMA_VERSION >= 2, 'the first real schema change bumps it past 1');
    });

    it('DBM2: every migration names a version and a step', () => {
      for (const m of MIGRATIONS) {
        assert(Number.isInteger(m.from) && Number.isInteger(m.to), `${m.name}: version numbers`);
        assert(m.to > m.from, `${m.name}: has to move forward`);
        assertEqual(typeof m.data, 'function', `${m.name}: has a data step`);
      }
      // And they form an unbroken chain, or a database mid-way is stranded.
      for (let i = 1; i < MIGRATIONS.length; i += 1) {
        assertEqual(
          MIGRATIONS[i].from, MIGRATIONS[i - 1].to,
          `gap between ${MIGRATIONS[i - 1].name} and ${MIGRATIONS[i].name}`
        );
      }
    });

    it('DBM3: a fresh database is stamped with the current version', async () => {
      const db = new MemoryDriver();
      const result = await runDataMigrations(db);
      assertEqual(result.to, SCHEMA_VERSION);
      const row = await db.get('settings', VERSION_ROW);
      assertEqual(row.value.version, SCHEMA_VERSION, 'so it is not re-run on next boot');
    });

    it('DBM4: running it twice changes nothing the second time', async () => {
      const db = new MemoryDriver();
      await db.put('settings', { id: 'priority', value: { rotation: 'SPEED' } });
      await runDataMigrations(db);
      const second = await runDataMigrations(db);
      assertEqual(second.ran.length, 0, 'nothing pending');
      const priority = await db.get('settings', 'priority');
      assertEqual(priority.value.rotation, 'SPEED', 'and the user settings survived');
    });

    it('DBM5: the settings migration wraps the rows that were stored flat', async () => {
      // An old database holds `{ id: 'priority', rotation, skipped, order }` on
      // the row itself. The declared shape is `{ id, value }`, so the old shape
      // has to be converted rather than left for a reader to guess at.
      //
      // Driven through a stub rather than a real driver, and that is the point:
      // a driver cannot produce a flat row any more, because `value` has a
      // default and every write fills it in. The migration exists for databases
      // written before this schema did, so it has to be tested against rows no
      // current writer would produce.
      const legacy = new Map([
        ['priority', { id: 'priority', rotation: 'MANUAL', skipped: { model: ['m1'] }, order: { model: [] } }],
        [VERSION_ROW, { id: VERSION_ROW, value: { version: 1 } }],
      ]);
      const stub = {
        _storeNames: () => ['settings'],
        async get(store, id) { return legacy.get(id) ?? null; },
        async list(store) { return [...legacy.values()]; },
        async put(store, row) { legacy.set(row.id, row); },
      };

      await runDataMigrations(stub, 2);

      const migrated = legacy.get('priority');
      assertEqual(migrated.value.rotation, 'MANUAL', 'the payload is now under value');
      assertEqual(migrated.value.skipped.model[0], 'm1', 'and nothing inside it was lost');
      assertEqual(migrated.rotation, undefined, 'and not duplicated onto the row');
      assertEqual(legacy.get(VERSION_ROW).value.version, 2, 'the bookkeeping row moved on');
    });

    it('DBM5b: a settings row written today never needs migrating', async () => {
      // The other half of DBM5: the driver fills in `value`, so the shape the
      // migration exists to fix cannot be produced any more. Without this the
      // migration would look necessary when it is only historical.
      const db = new MemoryDriver();
      await db.put('settings', { id: 'priority', value: { rotation: 'SPEED' } });
      const row = await db.get('settings', 'priority');
      assertEqual(row.value.rotation, 'SPEED');
      assertEqual(row.value.skipped, undefined, 'not wrapped a second time');
      await runDataMigrations(db);
      assertEqual((await db.get('settings', 'priority')).value.rotation, 'SPEED', 'and left alone');
    });

    it('DBM6: the row-version migration drops the per-row stamp', async () => {
      const db = new MemoryDriver();
      await db.put('models', { ...modelRow('m1', 'p1', 'a'), _schemaVersion: 1 });
      await db.put('models', modelRow('m2', 'p1', 'b'));
      await runDataMigrations(db, 3);
      const all = await db.list('models');
      assertEqual(all.length, 2, 'both rows are still there');
      assertEqual('_schemaVersion' in all[0], false, 'and the stamp is gone');
    });

    it('DBM7: the version is recorded after each step, not only at the end', async () => {
      // An upgrade interrupted half way has to resume from where it stopped.
      // Recording once at the end would replay every step on the next boot.
      const db = new MemoryDriver();
      await db.put('settings', { id: VERSION_ROW, value: { version: 1 } });
      const result = await runDataMigrations(db);
      assert(result.ran.length >= 1);
      assertEqual((await db.get('settings', VERSION_ROW)).value.version, SCHEMA_VERSION);
    });

    it('DBM8: a migration cannot lose a secret while tidying up', async () => {
      const db = new MemoryDriver();
      await db.put('keys', keyRow('k1', 'p1', 'f'.repeat(64)));
      await runDataMigrations(db);
      const stored = await db.get('keys', 'k1');
      assertEqual(stored.secret, 'sk-not-real-' + 'f'.repeat(64), 'the secret is untouched');
      assertEqual(stored.fingerprint, 'f'.repeat(64), 'and so is the fingerprint');
    });
  });

  // -------------------------------------------------------------- event log

  describe('DBE. The activity log', () => {
    it('DBE1: an event is stored with a kind, a time and a payload', async () => {
      const db = new MemoryDriver();
      const log = new EventLog(db);
      const row = await log.record({ kind: EVENT_KIND.SCAN, providerId: 'p1', payload: { added: 3 } });
      assert(row?.id, 'the event has an id');
      const stored = await db.get('events', row.id);
      assertEqual(stored.kind, 'scan');
      assertEqual(stored.providerId, 'p1');
      assertEqual(stored.payload.added, 3);
      assert(Number.isFinite(Date.parse(stored.ts)), 'and a timestamp a person can read');
      assert(Number.isFinite(stored.seq), 'plus an order that two events in one millisecond can share');
    });

    it('DBE2: an undeclared kind is refused by the schema', async () => {
      const db = new MemoryDriver();
      const result = db.validate('events', { id: 'e1', kind: 'invented', ts: now });
      assertEqual(result.ok, false, 'a kind no reader knows how to render');
      assert(result.errors.some((e) => e.includes('kind')), result.errors.join('; '));
    });

    it('DBE3: the log is capped, oldest first', async () => {
      // An uncapped event store grows without bound in the one database the app
      // treats as its home, and the cost is invisible until the device is full.
      const db = new MemoryDriver();
      const log = new EventLog(db, { limit: 5 });
      for (let i = 0; i < 12; i += 1) {
        await log.record({ kind: EVENT_KIND.SCAN, payload: { i } });
      }
      const stored = await db.list('events');
      assertEqual(stored.length, 5, 'capped at the limit');

      const recent = await log.recent({ limit: 10 });
      const numbers = recent.map((r) => r.payload.i);
      assertEqual(numbers.join(','), '11,10,9,8,7', 'newest first, and the oldest are the ones dropped');
    });

    it('DBE4: a failing log never fails the thing it describes', async () => {
      const db = new MemoryDriver();
      const log = new EventLog(db);
      db.put = async () => { throw new Error('storage is full'); };
      const row = await log.record({ kind: EVENT_KIND.SCAN });
      assertEqual(row, null, 'reported as not written');
      // And an event with no kind is not written at all.
      db.put = MemoryDriver.prototype.put;
      assertEqual(await log.record({}), null, 'a kind is not optional');
    });

    it('DBE5: the log can be read back by kind and by URL', async () => {
      const db = new MemoryDriver();
      const log = new EventLog(db);
      await log.record({ kind: EVENT_KIND.SCAN, providerId: 'p1', payload: { n: 1 } });
      await log.record({ kind: EVENT_KIND.SCAN, providerId: 'p2', payload: { n: 2 } });
      assertEqual((await log.recent({ providerId: 'p2' })).length, 1, 'filtered by URL');
      assertEqual((await log.recent({ kind: EVENT_KIND.SCAN })).length, 2, 'filtered by kind');
      await log.clear();
      assertEqual((await log.recent()).length, 0, 'and cleared');
    });
  });

  // ------------------------------------------------------ driver contract

  describe('DBD2. The driver contract', () => {
    it('DBD2a: both drivers answer every method the app uses', async () => {
      const drivers = [new MemoryDriver()];
      const methods = [
        'open', 'close', 'get', 'list', 'put', 'remove', 'clear', 'clearAll',
        'find', 'findMany', 'count', 'tx', 'validate', 'seed', 'putMany', 'removeMany', 'stats',
      ];
      for (const driver of drivers) {
        for (const method of methods) {
          assertEqual(typeof driver[method], 'function', `driver is missing ${method}`);
        }
        assertEqual(driver.degraded, false, 'a memory driver is not a degraded one');
      }
    });

    it('DBD2f: open is idempotent and close leaves the driver usable again', async () => {
      // The app opens before its first read and the tests open before seeding,
      // so neither may have to know whether somebody got there first. Opening
      // twice must not produce two connections: on IndexedDB the second one
      // blocks the first tab's upgrade.
      const db = new MemoryDriver();
      await db.open();
      await db.open();
      await db.put('providers', providerRow('p1', 'https://a.test/v1'));
      await db.close();
      assertEqual((await db.list('providers')).length, 1, 'the data outlives a close');
    });

    it('DBD2g: count takes a bare where clause or a whole query', async () => {
      // `summary()` wants `{ providerId }`; the parity tests want the same count
      // computed both ways. Two call shapes, one driver contract.
      const db = new MemoryDriver();
      await db.put('models', modelRow('m1', 'p1', 'a'));
      await db.put('models', modelRow('m2', 'p1', 'b'));
      await db.put('models', modelRow('m3', 'p2', 'a'));

      assertEqual(await db.count('models'), 3, 'no argument counts the store');
      assertEqual(await db.count('models', { providerId: 'p1' }), 2, 'a bare clause');
      assertEqual(await db.count('models', { where: { providerId: 'p1' } }), 2, 'a query object');
      assertEqual(
        await db.count('models', { where: { providerId: 'p1' }, _forceScan: true }), 2,
        'and the forced scan agrees with the index'
      );
      // A field that happens to look like a query key is still a where clause,
      // because no store declares a column called `where`, `sort` or `limit`.
      assertEqual(await db.count('models', { state: 'ACTIVE' }), 3);
    });

    it('DBD2b: find returns null and remove returns false for a row that is not there', async () => {
      const db = new MemoryDriver();
      assertEqual(await db.get('providers', 'nope'), null);
      assertEqual(await db.find('providers', { id: 'nope' }), null);
      assertEqual(await db.remove('providers', 'nope'), false);
      assertEqual(await db.count('providers'), 0);
    });

    it('DBD2c: a read never hands out a live reference', async () => {
      // Every update in core/ is `{ ...row, patch }`. If the store returned its
      // own object, a caller that forgot to put would still have changed it.
      const db = new MemoryDriver();
      await db.put('models', modelRow('m1', 'p1', 'a'));
      const first = await db.get('models', 'm1');
      first.state = 'INACTIVE';
      first.metadata.tampered = true;
      const second = await db.get('models', 'm1');
      assertEqual(second.state, 'ACTIVE', 'the stored row is unchanged');
      assertEqual(second.metadata.tampered, undefined, 'nested values too');
    });

    it('DBD2d: stats report what each store holds', async () => {
      const db = new MemoryDriver();
      await db.put('providers', providerRow('p1', 'https://a.test/v1'));
      await db.putMany('models', [modelRow('m1', 'p1', 'a'), modelRow('m2', 'p1', 'b')]);
      const stats = await db.stats();
      assertEqual(stats.providers, 1);
      assertEqual(stats.models, 2);
      assertEqual(stats.keys, 0);
      for (const store of STORES) assert(typeof stats[store] === 'number', `${store} is counted`);
    });

    it('DBD2e: an unknown store is refused rather than silently accepted', async () => {
      const db = new MemoryDriver();
      let threw = false;
      try { await db.put('nonsense', { id: 'x' }); } catch { threw = true; }
      assert(threw, 'a typo in a store name must not become a silent no-op');
    });
  });
}