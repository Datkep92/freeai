import { describe, it, assert, assertEqual } from './harness.js';
import fs from 'node:fs';
import { MemoryStorage } from '../core/storage.js';
import { ProviderRegistry } from '../core/provider-registry.js';
import { ModelRegistry, MODEL_SOURCE, MODEL_STATE } from '../core/model-registry.js';
import { KeyRegistry } from '../core/key-registry.js';
import { Scanner } from '../core/scanner.js';
import { Mapper } from '../core/mapper.js';
import { detectFree, FREE, orderModelsForVerify } from '../core/free-detector.js';
import { createMockFetch } from './mock-fetch.js';
import { normalizeWebsiteUrl } from '../core/provider-registry.js';
import { BUILTIN_LIST } from '../core/adapters/builtin.js';

// Synthetic fixtures only. Never valid credentials.
const KEY_A = 'oc_sk_A1b2C3d4E5f6G7h8I9j0';
const KEY_B = 'oc_sk_Z9y8X7w6V5u4T3s2R1q0';

function useRoutes(routes) {
  const m = createMockFetch(routes);
  globalThis.fetch = m;
  return m;
}

/** A provider with a priced catalog: one free, one paid, one name-only. */
const CATALOG = {
  body: {
    data: [
      { id: 'free/verified', name: 'Free Verified', pricing: { prompt: '0', completion: '0' } },
      { id: 'paid/one', name: 'Paid One', pricing: { prompt: '0.001', completion: '0.002' } },
      { id: 'name-only-free', name: 'name-only-free' },
      { id: 'silent/one', name: 'Silent One' },
    ],
  },
};

export function registerCoreCases() {
  describe('FD. Free detector decides from metadata, never from a guess', () => {
    it('FD1: price zero from the provider proves FREE_VERIFIED', () => {
      const r = detectFree({ modelId: 'x', pricing: { prompt: '0', completion: '0' } });
      assertEqual(r.freeStatus, FREE.FREE_VERIFIED);
      assert(r.evidence.length > 0, 'evidence is stored');
    });

    it('FD2: a free model whose name has no "free" is still verified', () => {
      // Measured on the live catalog: 4 of 20 free models carry no marker.
      const r = detectFree({ modelId: 'inclusionai/ling-3.1-flash', pricing: { prompt: 0, completion: 0 } });
      assertEqual(r.freeStatus, FREE.FREE_VERIFIED);
    });

    it('FD3: a price above zero is PAID and carries the numbers', () => {
      const r = detectFree({ modelId: 'gpt-4o', pricing: { prompt: '0.001', completion: '0.002' } });
      assertEqual(r.freeStatus, FREE.PAID);
      assertEqual(r.inputPrice, 0.001);
      assertEqual(r.outputPrice, 0.002);
    });

    it('FD4: with no pricing, the name is only ever a hint', () => {
      assertEqual(detectFree({ modelId: 'space-bunny-free' }).freeStatus, FREE.FREE_LIKELY);
      assertEqual(detectFree({ modelId: 'x:free' }).freeStatus, FREE.FREE_LIKELY);
      assertEqual(detectFree({ modelId: 'claude-sonnet-5' }).freeStatus, FREE.FREE_UNKNOWN);
    });

    it('FD5: a name never overrides a real price', () => {
      const r = detectFree({ modelId: 'thing-free', pricing: { prompt: '0.5', completion: '1' } });
      assertEqual(r.freeStatus, FREE.PAID, 'paid stays paid whatever the name says');
    });

    it('FD6: verification order puts verified free first and paid last', () => {
      const ordered = orderModelsForVerify([
        { modelId: 'p', freeStatus: FREE.PAID },
        { modelId: 'u', freeStatus: FREE.FREE_UNKNOWN },
        { modelId: 'l', freeStatus: FREE.FREE_LIKELY },
        { modelId: 'v', freeStatus: FREE.FREE_VERIFIED },
      ]);
      assertDeepOrder(ordered.map((m) => m.modelId), ['v', 'l', 'u', 'p']);
    });
  });

  describe('PR. Provider registry', () => {
    it('PR1: built-ins are seeded once and stay put', async () => {
      const s = new MemoryStorage();
      const pr = new ProviderRegistry(s);
      // Counted from the preset list, not hard-coded: the catalogue grows, and
      // a test that pins the number would fail on every new gateway without
      // saying anything about correctness.
      const expected = BUILTIN_LIST.length;
      assertEqual(await pr.seedBuiltins(), expected, 'every built-in is seeded on first run');
      assertEqual(await pr.seedBuiltins(), 0, 'seeding again adds nothing');
      assertEqual((await pr.list()).length, expected);

      // Each preset is stored with the fields the drawer reads, otherwise a URL
      // shows up as a bare name with no indication of what it offers.
      for (const preset of BUILTIN_LIST) {
        const row = await pr.get(preset.id);
        assert(row, preset.id + ' must be stored');
        assert(row.baseURL.startsWith('http'), preset.id + ' needs a usable baseURL');
        // Not "every URL uses /models": Google AI Studio serves chat on an
        // OpenAI-compatible path but lists models only on the native one, so a
        // preset is allowed to carry its own path. What must hold is that the
        // two paths together form real URLs.
        assert(row.modelsPath?.startsWith('/'), preset.id + ' needs an absolute models path');
        assert(row.chatPath?.startsWith('/'), preset.id + ' needs an absolute chat path');
        const modelsUrl = row.baseURL.replace(/\/+$/, '') + row.modelsPath;
        assert(/^https?:\/\/[^/]/.test(modelsUrl), preset.id + ' models URL must be absolute');
        assert(row.note, preset.id + ' must carry a note for the drawer');
        assert(
          ['reported', 'none'].includes(row.freeTier),
          preset.id + ' must declare whether it has a free tier'
        );
      }

      // A second run must not clobber live state, but a changed note does have
      // to reach an already-seeded row.
      const STAMP = '2026-01-01T00:00:00.000Z';
      await pr.update(BUILTIN_LIST[0].id, { status: 'OK', lastScanAt: STAMP });
      await pr.seedBuiltins();
      const after = await pr.get(BUILTIN_LIST[0].id);
      assertEqual(after.status, 'OK', 're-seeding must not reset a live status');
      assertEqual(after.lastScanAt, STAMP, 'nor the last scan time');
    });

    it('PR1b: no preset key is declared twice', () => {
      // A duplicated object key is silently overwritten by the last one, so a
      // whole provider can vanish from the list without any error. That happened:
      // two blocks were both called GROQ, and the real Groq entry disappeared.
      const source = fs.readFileSync(new URL('../core/adapters/builtin.js', import.meta.url), 'utf8');
      const keys = [...source.matchAll(/^  ([A-Z_0-9]+): \{$/gm)].map((m) => m[1]);
      const seen = new Set();
      const dupes = [];
      for (const key of keys) {
        if (seen.has(key)) dupes.push(key);
        seen.add(key);
      }
      assertEqual(dupes.length, 0, 'duplicate preset keys: ' + dupes.join(', '));

      // Each key should also match the id inside its own block, so a rename
      // cannot quietly desynchronise the two.
      const blocks = [...source.matchAll(/^  ([A-Z_0-9]+): \{\n    id: '([a-z0-9\-]+)',/gm)];
      assertEqual(blocks.length, keys.length, 'every key carries an id directly beneath it');
      const mismatched = blocks.filter(([, key, id]) => key.toLowerCase().replace(/_/g, '-') !== id);
      assertEqual(
        mismatched.length,
        0,
        'key should match its id: ' + mismatched.map(([, k, i]) => k + '/' + i).join(', ')
      );
    });

    it('PR2: the same URL twice is one provider', async () => {
      const s = new MemoryStorage();
      const pr = new ProviderRegistry(s);
      const first = await pr.upsert({ name: 'A', baseURL: 'https://dup.test/v1/' });
      assert(first.created, 'first is created');
      const second = await pr.upsert({ name: 'B', baseURL: 'https://dup.test/v1' });
      assertEqual(second.reason, 'DUPLICATE', 'trailing slash must not create a second');
      assertEqual((await pr.list()).length, 1);
    });

    it('PR3: a custom provider that cannot be discovered is still stored', async () => {
      useRoutes({});
      const s = new MemoryStorage();
      const pr = new ProviderRegistry(s);
      const { provider, created } = await pr.upsert({ name: 'Dead', baseURL: 'https://dead.test/v1' });
      assert(created, 'stored before any discovery attempt');
      assert(provider, 'row exists for the user to add manual models to');
    });

    it('PR3b: a website URL is normalized or rejected, never trusted raw', async () => {
      const s = new MemoryStorage();
      const pr = new ProviderRegistry(s);
      const { provider } = await pr.upsert({
        name: 'Docs',
        baseURL: 'https://docs.test/v1',
        websiteURL: 'docs.test',
      });
      assertEqual(provider.websiteURL, null, 'only http(s) is usable for opening a tab');
      const second = await pr.upsert({
        name: 'Docs trailing',
        baseURL: 'https://trailing.test/v1',
        websiteURL: 'https://trailing.test/docs',
      });
      assertEqual(second.provider.websiteURL, 'https://trailing.test/docs');
    });

    it('PR4: removing a provider removes everything under it', async () => {
      const s = new MemoryStorage();
      const pr = new ProviderRegistry(s);
      const { provider } = await pr.upsert({ name: 'X', baseURL: 'https://x.test/v1' });
      await s.put('keys', { id: 'k1', providerId: provider.id });
      await s.put('models', { id: 'm1', providerId: provider.id, modelId: 'a' });
      await s.put('mappings', { id: 'x1', providerId: provider.id, modelId: 'a', keyId: 'k1' });
      await pr.remove(provider.id);
      assertEqual((await s.list('keys')).length, 0);
      assertEqual((await s.list('models')).length, 0);
      assertEqual((await s.list('mappings')).length, 0);
    });
  });

  describe('SC. Scanner discovers without spending tokens', () => {
    it('SC1: a scan stores models with a free verdict each', async () => {
      const mock = useRoutes({ '/models': CATALOG });
      const s = new MemoryStorage();
      const sc = new Scanner(s);
      await sc.providers.seedBuiltins();
      const result = await sc.scanProvider({ providerId: 'openrouter' });
      assert(result.ok, 'scan succeeded');
      assertEqual(result.added, 4);
      assertEqual(mock.countBy('/chat/completions'), 0, 'no inference during discovery');

      const models = await s.list('models');
      const byId = Object.fromEntries(models.map((m) => [m.modelId, m.freeStatus]));
      assertEqual(byId['free/verified'], FREE.FREE_VERIFIED);
      assertEqual(byId['paid/one'], FREE.PAID);
      assertEqual(byId['name-only-free'], FREE.FREE_LIKELY);
      assertEqual(byId['silent/one'], FREE.FREE_UNKNOWN);
    });

    it('SC2: a re-scan within the TTL is skipped', async () => {
      const mock = useRoutes({ '/models': CATALOG });
      const s = new MemoryStorage();
      const sc = new Scanner(s);
      await sc.providers.seedBuiltins();
      await sc.scanProvider({ providerId: 'openrouter' });
      const again = await sc.scanProvider({ providerId: 'openrouter' });
      assert(again.skipped, 'second call short-circuits');
      assertEqual(mock.countBy('/models'), 1, 'only one request was made');
    });

    it('SC3: a re-scan merges instead of duplicating', async () => {
      useRoutes({ '/models': CATALOG });
      const s = new MemoryStorage();
      const sc = new Scanner(s);
      await sc.providers.seedBuiltins();
      await sc.scanProvider({ providerId: 'openrouter' });
      const forced = await sc.scanProvider({ providerId: 'openrouter', force: true });
      assertEqual(forced.added, 0, 'nothing new');
      assertEqual(forced.merged, 4, 'all four merged');
      assertEqual((await s.list('models')).length, 4, 'still four rows');
    });

    it('SC4: a model missing from a scan is marked NOT_SEEN, never deleted', async () => {
      const s = new MemoryStorage();
      const sc = new Scanner(s);
      await sc.providers.seedBuiltins();
      await s.put('models', {
        id: 'm1', providerId: 'openrouter', modelId: 'ghost',
        source: MODEL_SOURCE.AUTO_DISCOVERED, missCount: 0, state: MODEL_STATE.ACTIVE,
      });
      useRoutes({ '/models': { body: { data: [{ id: 'present' }] } } });
      await sc.scanProvider({ providerId: 'openrouter', force: true });

      const ghost = await s.get('models', 'm1');
      assert(ghost, 'the row still exists');
      assertEqual(ghost.state, MODEL_STATE.NOT_SEEN);
      assertEqual(ghost.missCount, 1);
    });

    it('SC5: a manual model is never marked NOT_SEEN', async () => {
      const s = new MemoryStorage();
      const sc = new Scanner(s);
      await sc.providers.seedBuiltins();
      await new ModelRegistry(s).addManual({ providerId: 'openrouter', modelId: 'my-own' });
      useRoutes({ '/models': { body: { data: [] } } });
      await sc.scanProvider({ providerId: 'openrouter', force: true });

      const manual = await s.list('models');
      assertEqual(manual.length, 1, 'still there');
      assertEqual(manual[0].state, MODEL_STATE.ACTIVE);
      assertEqual(manual[0].missCount, 0);
    });

    it('SC6: a provider without /models fails honestly and is kept', async () => {
      useRoutes({ '/models': { status: 404, body: { error: { message: 'not found' } } } });
      const s = new MemoryStorage();
      const sc = new Scanner(s);
      await sc.providers.seedBuiltins();
      const result = await sc.scanProvider({ providerId: 'nvidia' });
      assert(!result.ok, 'scan reported failure');
      assertEqual(result.reason, 'HTTP_404');
      assert(await s.get('providers', 'nvidia'), 'provider is still stored');
    });

    it('SC7: scan all runs every provider under a concurrency cap', async () => {
      const mock = useRoutes({ '/models': { body: { data: [{ id: 'm' }] } } });
      const s = new MemoryStorage();
      const sc = new Scanner(s);
      await sc.providers.seedBuiltins();
      let inFlight = 0;
      let peak = 0;
      const original = globalThis.fetch;
      globalThis.fetch = async (...args) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight -= 1;
        return original(...args);
      };
      const summary = await sc.scanAll({ force: true });
      globalThis.fetch = original;
      assertEqual(summary.providers, BUILTIN_LIST.length, 'every provider was visited');
      assertEqual(mock.countBy('/models'), BUILTIN_LIST.length, 'and each was asked once');
      assert(peak <= 4, 'never more than the configured limit, saw ' + peak);
    });
  });

  describe('KR. Key registry', () => {
    it('KR1: the same secret on one URL is stored once', async () => {
      const s = new MemoryStorage();
      const kr = new KeyRegistry(s);
      const first = await kr.add({ providerId: 'p1', secret: KEY_A });
      assert(first.created);
      const second = await kr.add({ providerId: 'p1', secret: KEY_A });
      assertEqual(second.reason, 'DUPLICATE');
      assertEqual((await kr.list('p1')).length, 1);
    });

    it('KR2: the same secret on two URLs is two keys', async () => {
      const s = new MemoryStorage();
      const kr = new KeyRegistry(s);
      await kr.add({ providerId: 'p1', secret: KEY_A });
      const other = await kr.add({ providerId: 'p2', secret: KEY_A });
      assert(other.created, 'a key belongs to a URL, not to the account');
      assertEqual((await kr.list()).length, 2);
    });

    it('KR3: the stored row is masked for display', async () => {
      const s = new MemoryStorage();
      const kr = new KeyRegistry(s);
      const { key } = await kr.add({ providerId: 'p1', secret: KEY_A });
      assert(!key.masked.includes('b2C3'), 'the middle is not shown');
      assertEqual(key.masked.length < KEY_A.length, true);
    });

    it('KR4: a deleted key does not come back when pasted again', async () => {
      const s = new MemoryStorage();
      const kr = new KeyRegistry(s);
      const { key } = await kr.add({ providerId: 'p1', secret: KEY_A });
      await kr.remove(key.id);
      const again = await kr.add({ providerId: 'p1', secret: KEY_A });
      assertEqual(again.reason, 'BLOCKED');
      assertEqual((await kr.list('p1')).length, 0);
    });

    it('KR5: the delete record keeps no secret', async () => {
      const s = new MemoryStorage();
      const kr = new KeyRegistry(s);
      const { key } = await kr.add({ providerId: 'p1', secret: KEY_A });
      await kr.remove(key.id);
      const record = (await kr.listDeleted())[0];
      assert(record, 'a record exists');
      assertEqual(JSON.stringify(record).includes(KEY_A), false, 'no secret anywhere in it');
      assert(record.fingerprint, 'only the fingerprint is kept');
    });

    it('KR6: restore is the only way back', async () => {
      const s = new MemoryStorage();
      const kr = new KeyRegistry(s);
      const { key } = await kr.add({ providerId: 'p1', secret: KEY_A });
      await kr.remove(key.id);
      const back = await kr.restore('p1', KEY_A);
      assert(back.created, 'restored on request');
      assertEqual((await kr.listDeleted()).length, 0, 'the delete record is cleared too');
    });

    it('KR7: removing a key removes its mappings', async () => {
      const s = new MemoryStorage();
      const kr = new KeyRegistry(s);
      const mapper = new Mapper(s);
      const { key } = await kr.add({ providerId: 'p1', secret: KEY_A });
      await mapper.upsert({ providerId: 'p1', modelId: 'm', keyId: key.id });
      assertEqual((await mapper.list()).length, 1);
      await kr.remove(key.id);
      assertEqual((await mapper.list()).length, 0, 'no dangling mapping');
    });
  });
}

function assertDeepOrder(actual, expected, message = '') {
  assertEqual(JSON.stringify(actual), JSON.stringify(expected), message);
}
