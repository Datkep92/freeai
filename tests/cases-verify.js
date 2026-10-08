import { describe, it, assert, assertEqual } from './harness.js';
import { MemoryStorage } from '../core/storage.js';
import { ProviderRegistry } from '../core/provider-registry.js';
import { ModelRegistry } from '../core/model-registry.js';
import { KeyRegistry } from '../core/key-registry.js';
import { KeyVerifier } from '../core/key-verifier.js';
import { BulkProbe, STOP } from '../core/bulk-probe.js';
import { Mapper } from '../core/mapper.js';
import { Router } from '../core/router.js';
import { classifyErrorProbe } from './helpers.js';
import { STATUS } from '../core/statuses.js';
import { FREE } from '../core/free-detector.js';
import { createMockFetch } from './mock-fetch.js';
import { buildExport, formatExport } from '../core/export-config.js';
import { Agent } from '../core/agent.js';

// Synthetic fixtures only.
const KEY_A = 'oc_sk_A1b2C3d4E5f6G7h8I9j0';
const KEY_B = 'oc_sk_Z9y8X7w6V5u4T3s2R1q0';
const KEY_C = 'oc_sk_Q1w2E3r4T5y6U7i8O9p0';

/** Build a provider with `modelIds` and one key, then verify it. */
async function setup(modelIds, { keySecret = KEY_A, chat } = {}) {
  const mock = createMockFetch({
    '/models': { body: { data: modelIds.map((id) => ({ id })) } },
    '/chat/completions': chat ?? { body: { choices: [{ message: { content: 'OK' } }] } },
  });
  globalThis.fetch = mock;

  const storage = new MemoryStorage();
  const providers = new ProviderRegistry(storage);
  const models = new ModelRegistry(storage);
  const keys = new KeyRegistry(storage);
  const mapper = new Mapper(storage);

  const { provider } = await providers.upsert({ name: 'T', baseURL: 'https://t.test/v1' });
  for (const id of modelIds) await models.upsertDiscovered({ providerId: provider.id, modelId: id });
  const { key } = await keys.add({ providerId: provider.id, secret: keySecret });

  const verifier = new KeyVerifier(storage, { providers, models, mapper });
  return { mock, storage, providers, models, keys, mapper, provider, key, verifier };
}

/** Build a provider with `models` and one key, ready for a bulk run. */
async function setupBulk(models, { keySecret = KEY_A, chat } = {}) {
  const mock = createMockFetch({
    '/models': { body: { data: [] } },
    '/chat/completions': chat ?? { body: { choices: [{ message: { content: 'OK' } }] } },
  });
  globalThis.fetch = mock;

  const storage = new MemoryStorage();
  const providers = new ProviderRegistry(storage);
  const registry = new ModelRegistry(storage);
  const keys = new KeyRegistry(storage);
  const mapper = new Mapper(storage);

  const { provider } = await providers.upsert({ name: 'T', baseURL: 'https://t.test/v1' });
  for (const m of models) {
    await registry.upsertDiscovered({
      providerId: provider.id,
      modelId: m.modelId,
      pricing: m.pricing ?? { prompt: '0', completion: '0' },
    });
  }
  const { key } = await keys.add({ providerId: provider.id, secret: keySecret });

  const prober = new BulkProbe(storage, { providers, models: registry, mapper });
  return { mock, storage, providers, models: registry, keys, mapper, provider, key, prober };
}

/** Every model id a request actually named. */
function requestedModels(mock) {
  return mock.calls
    .filter((c) => c.url.includes('/chat/completions'))
    .map((c) => JSON.parse(String(c.body)).model);
}

/** A chat route that refuses everything with one status. */
function refuseAll(status, message) {
  return () => ({ status, body: { error: { message } } });
}

/** A chat route where only `failing` is refused. */
function refuseModel(failing, status = 403, message = null) {
  return (url, options) => {
    const body = String(options.body ?? '');
    const wanted = Array.isArray(failing) ? failing : [failing];
    const hit = wanted.some((m) => body.includes(m));
    return hit
      ? { status, body: { error: { message: message ?? `model ${wanted[0]} not allowed for this key` } } }
      : { body: { choices: [{ message: { content: 'OK' } }] } };
  };
}

export function registerVerifyCases() {
  describe('KV. First-success verification saves quota', () => {
    it('KV1: a key that works on the first model costs exactly one request', async () => {
      const { mock, key, verifier } = await setup(['m1', 'm2', 'm3']);
      const r = await verifier.verifyKey({ keyId: key.id });
      assert(r.ok, 'verified');
      assertEqual(r.verifiedModelId, 'm1');
      assertEqual(r.attempted, 1, 'stopped at the first success');
      assertEqual(mock.countBy('/chat/completions'), 1);
    });

    it('KV2: a failing first model moves to the next, then stops', async () => {
      const { mock, key, verifier } = await setup(['m1', 'm2', 'm3'], { chat: refuseModel('m1') });
      const r = await verifier.verifyKey({ keyId: key.id });
      assert(r.ok);
      assertEqual(r.verifiedModelId, 'm2', 'the second model proved it');
      assertEqual(r.attempted, 2);
      assertEqual(mock.countBy('/chat/completions'), 2, 'm3 was never tried');
    });

    it('KV3: a key refused outright stops after one request', async () => {
      // Every model answers 401, which is how a dead credential looks.
      const { mock, key, verifier } = await setup(['m1', 'm2', 'm3'], {
        chat: () => ({ status: 401, body: { error: { message: 'invalid api key' } } }),
      });
      const r = await verifier.verifyKey({ keyId: key.id });
      assert(!r.ok);
      assertEqual(r.reason, STATUS.AUTH_INVALID);
      assertEqual(r.attempted, 1, 'a dead key is not dragged across every model');
    });

    it('KV4: success records the key and exactly one mapping', async () => {
      const { storage, key, verifier, mapper } = await setup(['m1', 'm2', 'm3'], { chat: refuseModel('m1') });
      await verifier.verifyKey({ keyId: key.id });

      const stored = await storage.get('keys', key.id);
      assertEqual(stored.status, STATUS.HEALTHY);
      assertEqual(stored.verifiedModelId, 'm2', 'one model is verified, not all of them');

      const mappings = await mapper.list();
      assertEqual(mappings.length, 2, 'm1 recorded as failed, m2 as healthy');
      assertEqual(mappings.filter((m) => m.status === STATUS.HEALTHY).length, 1);
    });

    it('KV5: a paid model is never probed', async () => {
      const mock = createMockFetch({
        '/models': { body: { data: [
          { id: 'paid/only', pricing: { prompt: '0.01', completion: '0.02' } },
        ] } },
        '/chat/completions': { body: { choices: [{ message: { content: 'OK' } }] } },
      });
      globalThis.fetch = mock;
      const storage = new MemoryStorage();
      const providers = new ProviderRegistry(storage);
      const models = new ModelRegistry(storage);
      const keys = new KeyRegistry(storage);
      const { provider } = await providers.upsert({ name: 'P', baseURL: 'https://p.test/v1' });
      const scanner = new (await import('../core/scanner.js')).Scanner(storage, { providers, models });
      await scanner.scanProvider({ providerId: provider.id });
      const { key } = await keys.add({ providerId: provider.id, secret: KEY_A });

      const verifier = new KeyVerifier(storage, { providers, models });
      const r = await verifier.verifyKey({ keyId: key.id });
      assert(!r.ok);
      assertEqual(r.reason, 'NO_MODELS');
      assertEqual(mock.countBy('/chat/completions'), 0, 'not one token spent on a paid model');
    });

    it('KV6: verifying twice re-probes only one model', async () => {
      const { mock, key, verifier } = await setup(['m1', 'm2', 'm3']);
      await verifier.verifyKey({ keyId: key.id });
      mock.reset();
      await verifier.verifyKey({ keyId: key.id });
      assertEqual(mock.countBy('/chat/completions'), 1, 'still first-success, not a matrix');
    });

    it('KV7: a URL with no model yet is reported, not guessed', async () => {
      const { key, verifier } = await setup([]);
      const r = await verifier.verifyKey({ keyId: key.id });
      assert(!r.ok);
      assertEqual(r.reason, 'NO_MODELS');
    });

    it('KV8: verifying every key of one URL is still first-success each', async () => {
      const { mock, storage, provider, verifier, keys } = await setup(['m1', 'm2']);
      await keys.add({ providerId: provider.id, secret: KEY_B });
      await keys.add({ providerId: provider.id, secret: KEY_C });
      mock.reset();
      const r = await verifier.verifyProvider({ providerId: provider.id });
      assertEqual(r.ok, true);
      assertEqual(r.requests, 3, 'three keys, one request each');
    });
  });

  describe('EC. Error classification decides how far the damage spreads', () => {
    const cases = [
      ['401 is an invalid key', { httpStatus: 401, payload: { error: { message: 'invalid api key' } } }, STATUS.AUTH_INVALID, 'key'],
      ['402 is an empty balance', { httpStatus: 402, payload: { error: { message: 'payment required' } } }, STATUS.QUOTA_EXHAUSTED, 'key'],
      ['403 naming a model only disables that mapping', { httpStatus: 403, payload: { error: { message: 'model gpt-x not allowed for this key' } } }, STATUS.MODEL_DENIED, 'mapping'],
      ['a bare 403 is still a credential problem', { httpStatus: 403, payload: { error: { message: 'forbidden' } } }, STATUS.AUTH_INVALID, 'key'],
      ['429 rate limit is not an empty balance', { httpStatus: 429, payload: { error: { message: 'rate limit exceeded' } } }, STATUS.RATE_LIMITED, 'mapping'],
      ['429 naming a quota is an empty balance', { httpStatus: 429, payload: { error: { message: 'insufficient credits' } } }, STATUS.QUOTA_EXHAUSTED, 'key'],
      ['5xx is the provider', { httpStatus: 503, payload: { error: { message: 'unavailable' } } }, STATUS.PROVIDER_DOWN, 'provider'],
      ['an unknown model is not an invalid key', { httpStatus: 404, payload: { error: { message: 'model not found' } } }, STATUS.MODEL_UNAVAILABLE, 'mapping'],
    ];

    for (const [name, input, status, scope] of cases) {
      it(`EC: ${name}`, () => {
        const r = classifyErrorProbe(input);
        assertEqual(r.status, status, `status for ${name}`);
        assertEqual(r.scope, scope, `scope for ${name}`);
      });
    }

    it('EC9: Retry-After survives classification', () => {
      const r = classifyErrorProbe(
        { httpStatus: 429, payload: { error: { message: 'slow down' } }, headers: retryAfter(30) }
      );
      assertEqual(r.retryAfterMs, 30000);
    });

    it('EC10: a timeout is transient, never terminal', async () => {
      useAbort();
      const storage = new MemoryStorage();
      const providers = new ProviderRegistry(storage);
      const { provider } = await providers.upsert({ name: 'X', baseURL: 'https://x.test/v1' });
      const adapter = providers.adapterFor(provider);
      const r = await adapter.probeKey({ model: 'm', secret: KEY_A, timeoutMs: 20 });
      assertEqual(r.ok, false);
      assertEqual(r.status, STATUS.TEMP_ERROR);
    });
  });

  describe('RT. Router falls back and respects the verdict', () => {
    it('RT1: a working mapping is used', async () => {
      const { storage, providers, provider, models, key, mapper } = await setup(['m1', 'm2']);
      await mapper.upsert({ providerId: provider.id, modelId: 'm1', keyId: key.id });
      await mapper.upsert({ providerId: provider.id, modelId: 'm2', keyId: key.id });
      const router = new Router(storage, { providers, models, mapper });
      const picked = await router.pick();
      assert(picked, 'something is routable');
      assertEqual(picked.mapping.modelId, 'm1');
    });

    it('RT2: a model-denied mapping is skipped', async () => {
      const { storage, providers, provider, models, key, mapper } = await setup(['m1', 'm2']);
      const { mapping } = await mapper.upsert({ providerId: provider.id, modelId: 'm1', keyId: key.id });
      await mapper.update(mapping.id, { status: STATUS.MODEL_DENIED });
      await mapper.upsert({ providerId: provider.id, modelId: 'm2', keyId: key.id });

      const router = new Router(storage, { providers, models, mapper });
      const all = await router.candidates();
      assertEqual(all.length, 1, 'the denied pair is gone');
      assertEqual(all[0].mapping.modelId, 'm2');
    });

    it('RT3: a denied model does not condemn its key', async () => {
      const { storage, providers, provider, models, key, mapper } = await setup(['m1', 'm2', 'm3']);
      const denied = await mapper.upsert({ providerId: provider.id, modelId: 'm1', keyId: key.id });
      await mapper.update(denied.mapping.id, { status: STATUS.MODEL_DENIED });
      await mapper.upsert({ providerId: provider.id, modelId: 'm2', keyId: key.id });
      await mapper.upsert({ providerId: provider.id, modelId: 'm3', keyId: key.id });

      const stored = await storage.get('keys', key.id);
      assertEqual(stored.status, STATUS.UNTESTED, 'the key itself is untouched');
    });

    it('RT4: a mapping in cooldown is skipped until it expires', async () => {
      const { storage, providers, provider, models, key, mapper } = await setup(['m1', 'm2']);
      const first = await mapper.upsert({ providerId: provider.id, modelId: 'm1', keyId: key.id });
      await mapper.update(first.mapping.id, {
        status: STATUS.RATE_LIMITED,
        cooldownUntil: Date.now() + 60_000,
      });
      await mapper.upsert({ providerId: provider.id, modelId: 'm2', keyId: key.id });

      const router = new Router(storage, { providers, models, mapper });
      const all = await router.candidates();
      assertEqual(all.length, 1);
      assertEqual(all[0].mapping.modelId, 'm2', 'the cooling pair waits');
    });

    it('RT5: a paid model is excluded unless the caller opts in', async () => {
      const storage = new MemoryStorage();
      const providers = new ProviderRegistry(storage);
      const models = new ModelRegistry(storage);
      const mapper = new Mapper(storage);
      const { provider } = await providers.upsert({ name: 'P', baseURL: 'https://p.test/v1' });
      await models.upsertDiscovered({
        providerId: provider.id, modelId: 'paid', pricing: { prompt: '0.01', completion: '0.02' },
      });
      const { key } = await new KeyRegistry(storage).add({ providerId: provider.id, secret: KEY_A });
      await mapper.upsert({ providerId: provider.id, modelId: 'paid', keyId: key.id });

      const router = new Router(storage, { providers, models, mapper });
      assertEqual((await router.candidates()).length, 0, 'free-only skips it');
      assertEqual((await router.candidates({ freeOnly: false })).length, 1, 'explicit opt-in allows it');
    });

    it('RT6: verified free outranks unverified free', async () => {
      const { storage, providers, provider, models, mapper } = await setup(['unknown-one', 'verified-free']);
      await models.upsertDiscovered({
        providerId: provider.id, modelId: 'verified-free', pricing: { prompt: '0', completion: '0' },
      });
      const key = (await storage.list('keys'))[0];
      const a = await mapper.upsert({ providerId: provider.id, modelId: 'unknown-one', keyId: key.id });
      await mapper.update(a.mapping.id, { status: STATUS.HEALTHY, verified: true, score: 90 });
      const b = await mapper.upsert({ providerId: provider.id, modelId: 'verified-free', keyId: key.id });
      await mapper.update(b.mapping.id, { status: STATUS.HEALTHY, verified: true, score: 60 });

      const router = new Router(storage, { providers, models, mapper });
      const picked = await router.pick();
      assertEqual(picked.mapping.modelId, 'verified-free', 'the free one wins on score alone');
    });

    it('RT7: an untested mapping stays routable - lazy learning', async () => {
      const { storage, providers, provider, models, key, mapper } = await setup(['m1']);
      await mapper.upsert({ providerId: provider.id, modelId: 'm1', keyId: key.id });
      const router = new Router(storage, { providers, models, mapper });
      const all = await router.candidates();
      assertEqual(all.length, 1, 'UNTESTED is not a reason to skip it');
      assertEqual(all[0].mapping.status, STATUS.UNTESTED);
    });
  });

  describe('BP. One key across many models', () => {
    it('BP1: the limit is the number of requests actually sent', async () => {
      const { mock, key, provider, prober } = await setupBulk(
        ['m1', 'm2', 'm3', 'm4', 'm5'].map((modelId) => ({ modelId }))
      );

      const r = await prober.run({ providerId: provider.id, keyId: key.id, limit: 3 });

      assertEqual(r.requests, 3, 'three requests for a limit of three');
      assertEqual(r.results.length, 3, 'and three results');
      assertEqual(requestedModels(mock).length, 3, 'the provider saw exactly three');
    });

    it('BP2: a paid model is never probed, however many there are', async () => {
      const { mock, key, provider, prober } = await setupBulk([
        { modelId: 'free-one' },
        { modelId: 'free-two' },
        { modelId: 'expensive', pricing: { prompt: '0.01', completion: '0.02' } },
      ]);

      await prober.run({ providerId: provider.id, keyId: key.id, limit: 10 });
      const asked = requestedModels(mock);

      // The whole app exists to find things that cost nothing. A batch run that
      // quietly spends money would be the worst bug in the codebase, so this is
      // checked against what the provider actually received, not just the list.
      assertEqual(asked.includes('expensive'), false, 'the paid model was never called');
      assertEqual(asked.sort().join(','), 'free-one,free-two', 'and only the free ones were');
    });

    it('BP3: a run writes a verdict per model, and metrics only for successes', async () => {
      const { mock, key, provider, prober, mapper, storage } = await setupBulk(
        [{ modelId: 'good' }, { modelId: 'broken' }],
        {
          chat: (url, options) =>
            String(options.body).includes('broken')
              ? { status: 403, body: { error: { message: 'model broken not allowed' } } }
              : { body: { choices: [{ message: { content: 'OK' } }] } },
        }
      );
      mock.reset();

      await prober.run({ providerId: provider.id, keyId: key.id, limit: 10 });

      const rows = await mapper.list(provider.id);
      const good = rows.find((m) => m.modelId === 'good');
      const broken = rows.find((m) => m.modelId === 'broken');
      assertEqual(good.status, STATUS.HEALTHY, 'the working model is recorded healthy');
      assertEqual(good.verified, true, 'and verified');
      assertEqual(broken.status, STATUS.MODEL_DENIED, 'the refused one keeps its own reason');

      const metrics = await storage.list('metrics');
      assertEqual(metrics.length, 1, 'exactly one measurement row');
      assert(
        String(metrics[0].modelKey ?? metrics[0].modelId ?? '').includes('good') ||
          metrics[0].modelId === 'good',
        'and it belongs to the model that answered: ' + JSON.stringify(metrics[0].modelId)
      );
    });

    it('BP4: five failures that look like the key stop the run', async () => {
      const { mock, key, provider, prober } = await setupBulk(
        Array.from({ length: 20 }, (_, i) => ({ modelId: `m${i}` })),
        { chat: refuseAll(401, 'invalid api key') }
      );
      mock.reset();

      const r = await prober.run({ providerId: provider.id, keyId: key.id, limit: 20 });

      // A dead key answers the same way on every model. Without this the run
      // would spend its whole budget rediscovering one fact.
      assertEqual(r.stopped, true, 'the run stopped itself');
      assertEqual(r.stopReason, STOP.KEY_SUSPECT, 'and says why');
      assertEqual(r.requests, 5, 'after five attempts, not twenty');
    });

    it('BP5: the key is marked once, from the failure that points at it', async () => {
      const { key, provider, prober, storage } = await setupBulk(
        Array.from({ length: 20 }, (_, i) => ({ modelId: `m${i}` })),
        { chat: refuseAll(401, 'invalid api key') }
      );

      await prober.run({ providerId: provider.id, keyId: key.id, limit: 20 });
      const after = await storage.get('keys', key.id);

      assertEqual(after.status, STATUS.AUTH_INVALID, 'the key is no longer treated as usable');
      assert(after.lastError, 'with the reason kept');
      assert(
        !String(after.lastError).includes(key.secret),
        'and the secret itself is never written into the error'
      );
    });

    it('BP6: many refusals that name the model do not stop the run', async () => {
      const { mock, key, provider, prober } = await setupBulk(
        Array.from({ length: 20 }, (_, i) => ({ modelId: `m${i}` })),
        { chat: refuseAll(403, 'model not allowed for this key') }
      );
      mock.reset();

      const r = await prober.run({ providerId: provider.id, keyId: key.id, limit: 12 });

      // A key blocked from 20 models is one healthy key with a restricted grant,
      // not a broken secret. Stopping here would hide the rest of the URL.
      assertEqual(r.stopped, false, 'the run finished what it was asked to');
      assertEqual(r.requests, 12, 'all twelve models were tried');
    });

    it('BP7: a model refusing this key never marks the key itself', async () => {
      const { key, provider, prober, storage } = await setupBulk(
        [{ modelId: 'blocked' }, { modelId: 'fine' }],
        { chat: refuseModel('blocked', 403, 'model blocked not allowed for this key') }
      );

      await prober.run({ providerId: provider.id, keyId: key.id, limit: 10 });
      const after = await storage.get('keys', key.id);

      // Writing this verdict onto the key would remove a working credential
      // from the rotation, because of one model it could not run.
      assertEqual(after.status, STATUS.UNTESTED, 'the key is exactly as it was');
    });

    it('BP8: an exhausted quota stops the run immediately', async () => {
      const { mock, key, provider, prober } = await setupBulk(
        Array.from({ length: 20 }, (_, i) => ({ modelId: `m${i}` })),
        { chat: refuseAll(402, 'insufficient credits') }
      );
      mock.reset();

      const r = await prober.run({ providerId: provider.id, keyId: key.id, limit: 20 });

      assertEqual(r.stopReason, STOP.QUOTA, 'quota is terminal and unambiguous');
      assertEqual(r.requests, 1, 'so there is nothing to gain from a second request');
    });

    it('BP9: cancelling keeps every result measured before the stop', async () => {
      const { key, provider, prober, mapper } = await setupBulk([
        { modelId: 'a' },
        { modelId: 'b' },
        { modelId: 'c' },
      ]);

      let seen = 0;
      const r = await prober.run({
        providerId: provider.id,
        keyId: key.id,
        limit: 10,
        run: { cancelled: () => (seen += 1) > 2 },
      });

      assertEqual(r.stopReason, STOP.CANCELLED, 'the run reports being cancelled');
      assert(r.requests >= 1, 'after at least one request');
      // A partial run is still real evidence: throwing it away would waste the
      // quota the user already spent.
      const rows = await mapper.list(provider.id);
      assertEqual(rows.length, r.results.length, 'and every result it reported was written');
    });
  });

  describe('BK. Many models against many keys', () => {
    /** A provider with `secrets` keys and `modelIds`, ready for a run across keys. */
    async function setupMulti(modelIds, { chat, secrets = [KEY_A, KEY_B] } = {}) {
      const mock = createMockFetch({
        '/models': { body: { data: [] } },
        '/chat/completions': chat ?? { body: { choices: [{ message: { content: 'OK' } }] } },
      });
      globalThis.fetch = mock;

      const storage = new MemoryStorage();
      const providers = new ProviderRegistry(storage);
      const registry = new ModelRegistry(storage);
      const keys = new KeyRegistry(storage);
      const mapper = new Mapper(storage);

      const { provider } = await providers.upsert({ name: 'M', baseURL: 'https://m.test/v1' });
      for (const id of modelIds) {
        await registry.upsertDiscovered({
          providerId: provider.id,
          modelId: id,
          pricing: { prompt: '0', completion: '0' },
        });
      }
      const keyRows = [];
      for (const secret of secrets) keyRows.push((await keys.add({ providerId: provider.id, secret })).key);

      const prober = new BulkProbe(storage, { providers, models: registry, mapper });
      return { mock, storage, providers, models: registry, keys, mapper, provider, keyRows, prober };
    }

    it('BK1: a model is asked once, and a working first key stops the loop', async () => {
      const { mock, provider, keyRows, prober } = await setupMulti(['m1', 'm2']);
      mock.reset();
      const r = await prober.runAcrossKeys({ providerId: provider.id, keyIds: keyRows.map((k) => k.id), limit: 10 });

      assertEqual(r.healthy, 2, 'both models answered');
      assertEqual(r.requests, 2, 'one request per model, not one per key');
      assertEqual(r.results.every((e) => e.keyId === keyRows[0].id), true, 'the first key answered both');
    });

    it('BK2: when the first key is refused the model falls through to the next key', async () => {
      const { mock, provider, keyRows, prober } = await setupMulti(['blocked', 'fine'], {
        chat: (url, options) =>
          String(options.headers?.Authorization ?? '').includes(KEY_A)
            ? { status: 401, body: { error: { message: 'invalid api key' } } }
            : { body: { choices: [{ message: { content: 'OK' } }] } },
      });
      mock.reset();
      const r = await prober.runAcrossKeys({ providerId: provider.id, keyIds: keyRows.map((k) => k.id), limit: 10 });

      assertEqual(r.results.length, 2, 'a verdict for every model');
      assertEqual(r.results.every((e) => e.ok), true, 'and both usable, thanks to the second key');
      assertEqual(r.results.every((e) => e.keyId === keyRows[1].id), true, 'recorded against the key that worked');
    });

    it('BK3: a paid model is never probed by a run across keys either', async () => {
      const storage = new MemoryStorage();
      const providers = new ProviderRegistry(storage);
      const registry = new ModelRegistry(storage);
      const keys = new KeyRegistry(storage);
      const mapper = new Mapper(storage);
      const mock = createMockFetch({
        '/models': { body: { data: [] } },
        '/chat/completions': { body: { choices: [{ message: { content: 'OK' } }] } },
      });
      globalThis.fetch = mock;

      const { provider } = await providers.upsert({ name: 'P', baseURL: 'https://p.test/v1' });
      await registry.upsertDiscovered({ providerId: provider.id, modelId: 'free-one', pricing: { prompt: '0', completion: '0' } });
      await registry.upsertDiscovered({ providerId: provider.id, modelId: 'expensive', pricing: { prompt: '1', completion: '2' } });
      const { key } = await keys.add({ providerId: provider.id, secret: KEY_A });

      const prober = new BulkProbe(storage, { providers, models: registry, mapper });
      mock.reset();
      await prober.runAcrossKeys({ providerId: provider.id, keyIds: [key.id], limit: 10 });

      assertEqual(requestedModels(mock).includes('expensive'), false, 'the paid model was never called');
    });

    it('BK4: a key that fails everywhere is retired once, and the run stops when none are left', async () => {
      const { mock, provider, keyRows, prober, storage } = await setupMulti(
        Array.from({ length: 20 }, (_, i) => `m${i}`),
        { chat: refuseAll(401, 'invalid api key') }
      );
      mock.reset();
      const r = await prober.runAcrossKeys({ providerId: provider.id, keyIds: keyRows.map((k) => k.id), limit: 20 });

      assertEqual(r.stopped, true, 'the run stopped itself');
      // Five failures per key retire it, and there are two keys: ten requests,
      // not forty. Without retirement the dead key would be re-asked on every
      // one of the twenty models.
      assertEqual(r.requests, 10, 'each key burned its streak once, then stopped being asked');
      const after = await storage.get('keys', keyRows[0].id);
      assertEqual(after.status, STATUS.AUTH_INVALID, 'and the dead key is marked');
    });
  });

  describe('EX. Exporting the working configuration', () => {
    const rows = () => ({
      providers: [
        { id: 'p1', name: 'Gate One', baseURL: 'https://a.test/v1' },
        { id: 'p2', name: 'Untried', baseURL: 'https://b.test/v1' },
      ],
      keys: [
        { id: 'k1', secret: KEY_A, masked: 'oc…I9j0' },
        { id: 'k2', secret: KEY_B, masked: 'oc…R1q0' },
      ],
      models: [{ id: 'm1', providerId: 'p1', modelId: 'free-one' }],
      mappings: [
        { providerId: 'p1', modelId: 'free-one', keyId: 'k1', status: STATUS.HEALTHY },
        { providerId: 'p2', modelId: 'some-model', keyId: 'k2', status: STATUS.UNTESTED },
      ],
      exportedAt: '2026-01-01T00:00:00.000Z',
    });

    it('EX1: only an endpoint with a proven mapping is exported, with the key that proved it', async () => {
      const data = buildExport(rows());

      assertEqual(data.endpoints.length, 1, 'only the proven URL is exported');
      assertEqual(data.endpoints[0].baseURL, 'https://a.test/v1', 'and it is the right one');
      assertEqual(data.endpoints[0].apiKey, KEY_A, 'carrying the key that answered');
      assertEqual(data.endpoints[0].model, 'free-one', 'and the model that answered');
      assertEqual(data.default.baseURL, 'https://a.test/v1', 'the first endpoint is the default');
    });

    it('EX2: the .env names the default and one prefixed block per URL', async () => {
      const env = formatExport(buildExport(rows()), 'env');

      assert(env.includes('OPENAI_BASE_URL=https://a.test/v1'), 'the default block: ' + env);
      assert(env.includes(`OPENAI_API_KEY=${KEY_A}`), 'with the key');
      assert(env.includes('OPENAI_MODEL=free-one'), 'and the model');
      // A second URL is reachable too, under its own prefix, so a multi-URL
      // setup survives the flat .env format.
      assert(env.includes('GATE_ONE_BASE_URL=https://a.test/v1'), 'the per-URL block: ' + env);
    });

    it('EX3: json and yaml carry the same picture as env', async () => {
      const data = buildExport(rows());

      const parsed = JSON.parse(formatExport(data, 'json'));
      assertEqual(parsed.default.baseURL, 'https://a.test/v1', 'json default baseURL');
      assertEqual(parsed.default.apiKey, KEY_A, 'json carries the key');
      assertEqual(parsed.endpoints.length, 1, 'json carries the endpoint list');

      const yaml = formatExport(data, 'yaml');
      assert(yaml.includes('apiKey:'), 'yaml names the key field: ' + yaml);
      assert(yaml.includes('https://a.test/v1'), 'and the URL');
    });

    it('EX4: a locked key, model or URL is left out of the file', async () => {
      const base = rows();
      assertEqual(buildExport({ ...base, skipped: { key: ['k1'] } }).endpoints.length, 0, 'a locked key is skipped');
      assertEqual(buildExport({ ...base, skipped: { model: ['m1'] } }).endpoints.length, 0, 'a locked model is skipped');
      assertEqual(buildExport({ ...base, skipped: { provider: ['p1'] } }).endpoints.length, 0, 'a locked URL is skipped');
    });
  });

  describe('AG. A streamed chat turn through the router', () => {
    /** A provider with one model and `secrets.length` keys mapped to it. */
    async function setupChat({ chat, modelIds = ['m1'], secrets = [KEY_A] } = {}) {
      const mock = createMockFetch({
        '/models': { body: { data: [] } },
        '/chat/completions': chat ?? { body: { choices: [{ message: { content: 'Xin chao ban' } }] } },
      });
      globalThis.fetch = mock;

      const storage = new MemoryStorage();
      const providers = new ProviderRegistry(storage);
      const models = new ModelRegistry(storage);
      const keys = new KeyRegistry(storage);
      const mapper = new Mapper(storage);

      const { provider } = await providers.upsert({ name: 'Chat Gate', baseURL: 'https://c.test/v1' });
      for (const modelId of modelIds) {
        await models.upsertDiscovered({ providerId: provider.id, modelId, pricing: { prompt: '0', completion: '0' } });
      }
      const keyRows = [];
      for (const secret of secrets) {
        const { key } = await keys.add({ providerId: provider.id, secret });
        keyRows.push(key);
        // Every key is mapped to the first model, so a dead key and a live one
        // are the two candidates for the same model.
        await mapper.upsert({ providerId: provider.id, modelId: modelIds[0], keyId: key.id });
      }

      const router = new Router(storage, { providers, models, mapper });
      return { mock, storage, providers, models, keys, mapper, router, provider, keyRows };
    }

    it('AG1: a streamed turn emits tokens as they arrive and reports the whole answer', async () => {
      const { router } = await setupChat();
      const seen = [];
      const r = await router.streamChat({
        messages: [{ role: 'user', content: 'hi' }],
        onToken: (delta) => seen.push(delta),
      });

      assertEqual(r.ok, true, 'the turn succeeded');
      // The mock streams in 8-character pieces, so a one-blob answer would mean
      // the token callback was never wired.
      assert(seen.length > 1, 'the answer arrived in pieces, not one lump: ' + seen.length);
      assertEqual(seen.join(''), 'Xin chao ban', 'and the pieces spell the answer');
      assertEqual(r.content, 'Xin chao ban', 'the whole answer is returned too');
      assertEqual(r.provider, 'Chat Gate', 'the answering URL is named');
    });

    it('AG2: an expired key rotates to the next key and the failure is recorded', async () => {
      const { router, keyRows } = await setupChat({
        secrets: [KEY_A, KEY_B],
        chat: (url, options) =>
          String(options.headers?.Authorization ?? '').includes(KEY_A)
            ? { status: 401, body: { error: { message: 'invalid api key' } } }
            : { body: { choices: [{ message: { content: 'ok' } }] } },
      });

      const r = await router.streamChat({ messages: [{ role: 'user', content: 'hi' }] });

      assertEqual(r.ok, true, 'the turn still succeeded');
      assertEqual(r.keyId, keyRows[1].id, 'on the other key');
      assertEqual(r.tried.length, 1, 'after exactly one recorded failure');
      assertEqual(r.tried[0].status, STATUS.AUTH_INVALID, 'and the failure was the dead key');
    });

    it('AG3: a hard failure that showed nothing is a plain failure, not a partial one', async () => {
      const { router } = await setupChat({
        secrets: [KEY_A, KEY_B],
        chat: { status: 500, body: { error: { message: 'boom' } } },
      });

      const r = await router.streamChat({ messages: [{ role: 'user', content: 'hi' }] });
      assertEqual(r.ok, false, 'the turn failed');
      // "partial" means the user already saw text. Nothing arrived here, so the
      // UI must be free to show a clean error rather than a half-written answer.
      assertEqual(Boolean(r.partial), false, 'and nothing was shown, so it is not partial');
    });

    it('AG4: the session budget refuses a turn instead of spending past it', async () => {
      const { router } = await setupChat();
      const agent = new Agent(router, { maxTotalTokens: 100 });

      const first = await agent.turn({ userText: 'a', maxTokens: 100 });
      assertEqual(first.ok, true, 'the first turn runs');
      assertEqual(agent.remaining, 0, 'and the whole budget is spent');

      const second = await agent.turn({ userText: 'b' });
      assertEqual(second.ok, false, 'the next turn is refused');
      assertEqual(second.reason, 'BUDGET_EXHAUSTED', 'because the session is out of budget');
    });
  });
}

function retryAfter(seconds) {
  return { get: (n) => (String(n).toLowerCase() === 'retry-after' ? String(seconds) : null) };
}

function useAbort() {
  globalThis.fetch = async () => {
    const error = new Error('aborted');
    error.name = 'AbortError';
    throw error;
  };
}
