import { describe, it, assert, assertEqual } from './harness.js';
import { MemoryStorage } from '../core/storage.js';
import { ProviderRegistry } from '../core/provider-registry.js';
import { ModelRegistry } from '../core/model-registry.js';
import { KeyRegistry } from '../core/key-registry.js';
import { KeyVerifier } from '../core/key-verifier.js';
import { Mapper } from '../core/mapper.js';
import { Router } from '../core/router.js';
import { classifyErrorProbe } from './helpers.js';
import { STATUS } from '../core/statuses.js';
import { FREE } from '../core/free-detector.js';
import { createMockFetch } from './mock-fetch.js';

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
