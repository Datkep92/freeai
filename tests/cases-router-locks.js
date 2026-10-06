/**
 * The router obeys the user's locks, order and speed.
 *
 * The UI can show a row as locked while the app still routes a request to it.
 * That gap is invisible until a request lands on something deliberately taken
 * out of rotation, so these cases drive the router directly: a lock that only
 * affects rendering cannot pass here.
 */
import { describe, it, assert, assertEqual } from './harness.js';
import { MemoryStorage } from '../core/storage.js';
import { ProviderRegistry } from '../core/provider-registry.js';
import { ModelRegistry } from '../core/model-registry.js';
import { KeyRegistry } from '../core/key-registry.js';
import { Mapper } from '../core/mapper.js';
import { Router } from '../core/router.js';
import { Priority, SCOPE, ROTATION } from '../core/priority.js';
import { MetricsRegistry, measure } from '../core/metrics.js';
import { STATUS } from '../core/statuses.js';
import { createMockFetch } from './mock-fetch.js';

// Synthetic fixtures only.
const KEY_A = 'oc_sk_A1b2C3d4E5f6G7h8I9j0';
const KEY_B = 'oc_sk_Z9y8X7w6V5u4T3s2R1q0';

/** One URL, `modelIds` free models, one key, every mapping healthy. */
async function setup(modelIds, { baseURL = 'https://t.test/v1', secret = KEY_A } = {}) {
  globalThis.fetch = createMockFetch({
    '/models': { body: { data: modelIds.map((id) => ({ id })) } },
    '/chat/completions': { body: { choices: [{ message: { content: 'OK' } }] } },
  });

  const storage = new MemoryStorage();
  const providers = new ProviderRegistry(storage);
  const models = new ModelRegistry(storage);
  const keys = new KeyRegistry(storage);
  const mapper = new Mapper(storage);
  const priority = new Priority(storage);
  const metrics = new MetricsRegistry(storage);

  const { provider } = await providers.upsert({ name: 'T', baseURL });
  const key = await keys.add({ providerId: provider.id, secret });
  const ctx = {
    storage, providers, models, keys, mapper, priority, metrics, provider, key,
  };

  // A healthy mapping per model, all with the same score so only the user's
  // own rules can decide the order.
  for (const modelId of modelIds) {
    await models.upsertDiscovered({ providerId: provider.id, modelId });
    const { mapping } = await mapper.upsert({ providerId: provider.id, modelId, keyId: key.key.id });
    await mapper.update(mapping.id, { status: STATUS.HEALTHY, verified: true, score: 50 });
  }

  ctx.router = new Router(storage, { providers, models, mapper, priority, metrics });
  return ctx;
}

const ids = (list) => list.map((c) => c.mapping.modelId);

/**
 * The response a measurement is read from.
 *
 * Tokens per second is completion tokens over generation time, so a fixture
 * without a usage block would measure nothing and every speed case would pass
 * for the wrong reason.
 */
const payload = { usage: { prompt_tokens: 10, completion_tokens: 40 } };

/** The stored row ids for a URL's models - the form a lock list actually holds. */
const rowIdsOf = async (models, providerId, modelIds = null) => {
  const rows = await models.list(providerId);
  if (!modelIds) return rows.map((r) => r.id);
  // The caller's order is the order being asserted, so the rows are looked up in
  // that order. Returning them in storage order would quietly test the reverse.
  return modelIds.map(
    (modelId) => rows.find((r) => r.modelId === modelId)?.id
  );
};

export function registerRouterLockCases() {
  describe('RL. A lock is honoured by the router, not only by the list', () => {
    it('RL1: a locked model is never a candidate, however good its score', async () => {
      const { router, mapper, provider, key, priority, models } = await setup(['m1', 'm2']);

      // Give m2 a perfect score so it would win on health alone.
      const m2 = await mapper.find(provider.id, 'm2', key.key.id);
      await mapper.update(m2.id, { status: STATUS.HEALTHY, verified: true, score: 999 });
      assertEqual((await router.pick()).mapping.modelId, 'm2', 'm2 wins before the lock');

      const [m2Row] = await rowIdsOf(models, provider.id, ['m2']);
      await priority.setSkipped(SCOPE.MODEL, m2Row);

      const after = ids(await router.candidates());
      assertEqual(after.includes('m2'), false, 'the locked model is out of the rotation');
      assert(after.includes('m1'), 'and the other one still runs');
    });

    it('RL2: a locked URL takes every model on it out, by inheritance', async () => {
      const { router, priority, provider } = await setup(['m1', 'm2']);
      assertEqual(ids(await router.candidates()).length, 2, 'both are usable first');

      await priority.setLocked({ level: 'provider', id: provider.id, locked: true });
      assertEqual(
        ids(await router.candidates()).length,
        0,
        'locking the URL empties its whole subtree'
      );

      // The point of inheritance: nothing was written onto the models, so the
      // lock still holds for a model discovered after the lock was set.
      const state = await priority.load();
      assertEqual(state.skipped.model.length, 0, 'no model lock was written');
    });

    it('RL3: a locked key is skipped even when nothing else can serve', async () => {
      const { router, priority, key } = await setup(['m1']);
      await priority.setSkipped(SCOPE.KEY, key.key.id);
      assertEqual(
        ids(await router.candidates()).length,
        0,
        'the only key is locked, so nothing is eligible'
      );
    });

    it('RL4: the dragged order decides what is tried first', async () => {
      const { router, priority, provider, models } = await setup(['m1', 'm2', 'm3']);
      const [m3, m2, m1] = await rowIdsOf(models, provider.id, ['m3', 'm2', 'm1']);
      await priority.setProviderPriority(provider.id, { order: [m3, m2, m1] });

      assertEqual((await router.pick()).mapping.modelId, 'm3', 'the first dragged id goes first');
    });

    it('RL5: with no dragged order, the fastest measured model wins', async () => {
      const { router, metrics, provider } = await setup(['slow', 'fast']);
      await metrics.record(provider.id, 'slow', measure({ payload, totalMs: 2000, ttftMs: 0 }));
      await metrics.record(provider.id, 'fast', measure({ payload, totalMs: 1000, ttftMs: 0 }));

      assertEqual(
        (await router.pick()).mapping.modelId,
        'fast',
        'speed decides when the user has expressed no preference'
      );
    });

    it('RL6: an unmeasured model is not treated as a fast one', async () => {
      const { router, metrics, provider } = await setup(['measured', 'unknown']);
      await metrics.record(provider.id, 'measured', measure({ payload, totalMs: 1000, ttftMs: 0 }));

      assertEqual(
        (await router.pick()).mapping.modelId,
        'measured',
        'never-run ranks behind the one with a real number behind it'
      );
    });

    it('RL7: MANUAL ignores speed and keeps the dragged order', async () => {
      const { router, priority, metrics, provider, models } = await setup(['slow', 'fast']);
      await metrics.record(provider.id, 'slow', measure({ payload, totalMs: 2000, ttftMs: 0 }));
      await metrics.record(provider.id, 'fast', measure({ payload, totalMs: 1000, ttftMs: 0 }));
      const [slow, fast] = await rowIdsOf(models, provider.id, ['slow', 'fast']);

      await priority.setProviderPriority(provider.id, {
        rotation: ROTATION.MANUAL,
        order: [slow, fast],
      });

      assertEqual(
        (await router.pick()).mapping.modelId,
        'slow',
        'a deliberately slow model still goes first when the user ordered it'
      );
    });

    it('RL9: a real request records its own speed measurement', async () => {
      // Ranking by speed is only honest if the numbers arrive on their own.
      // If they were collected by the check button only, every model the user
      // had never manually checked would stay permanently unmeasured and sort
      // behind the ones they happened to check.
      const { router, metrics, provider, models } = await setup(['m1']);

      await router.complete({ messages: [{ role: 'user', content: 'hi' }] });

      const rows = await metrics.mapFor(await models.list(provider.id));
      const measured = rows.get(`${provider.id}::m1`);
      assert(measured?.samples, 'the run was measured: ' + JSON.stringify(measured));
      assert(
        Number.isFinite(measured.totalMs),
        'a duration was recorded even without a streaming first-token time'
      );
      assertEqual(measured.ttftMs, null, 'and time-to-first-token is left unmeasured, not invented');
    });

    it('RL10: a failed attempt records nothing', async () => {
      const { router, metrics, provider, models } = await setup(['m1']);
      globalThis.fetch = createMockFetch({
        '/models': { body: { data: [] } },
        '/chat/completions': { status: 500, body: { error: { message: 'upstream exploded' } } },
      });

      const result = await router.complete({ messages: [{ role: 'user', content: 'hi' }] });
      assertEqual(result.ok, false, 'the run failed');

      const rows = await metrics.mapFor(await models.list(provider.id));
      const measured = rows.get(`${provider.id}::m1`);
      assertEqual(measured?.samples ?? 0, 0, 'a failure has no speed to record');
    });

    it('RL8: a per-URL lock leaves the same model id usable on another URL', async () => {
      const { storage, providers, models, keys, mapper, priority, metrics } = await setup(['m1']);
      const router = new Router(storage, { providers, models, mapper, priority, metrics });

      const second = await providers.upsert({ name: 'U2', baseURL: 'https://u2.test/v1' });
      await models.upsertDiscovered({ providerId: second.provider.id, modelId: 'm1' });
      const key2 = await keys.add({ providerId: second.provider.id, secret: KEY_B });
      const m2 = await mapper.upsert({ providerId: second.provider.id, modelId: 'm1', keyId: key2.key.id });
      await mapper.update(m2.mapping.id, { status: STATUS.HEALTHY, verified: true, score: 50 });

      const first = (await providers.list()).find((p) => p.baseURL === 'https://t.test/v1');
      await priority.setProviderPriority(first.id, { skipped: ['m1'] });

      const picked = await router.candidates();
      assertEqual(
        picked.filter((c) => c.provider.id === first.id).length,
        0,
        'the locked model is gone from the URL that locked it'
      );
      assert(
        picked.some((c) => c.provider.id === second.provider.id),
        'the same model id on another URL is untouched'
      );
    });
  });
}
