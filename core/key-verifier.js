/**
 * Key verifier (plan 12, 13).
 *
 * FIRST SUCCESS -> STOP.
 *
 * Checking a key by trying models in order and continuing past the first pass
 * is the single most expensive mistake this app could make: the user pastes
 * keys to find out whether they work, not to exhaust them. So the verifier
 * returns at the first healthy result and never spends a request on a model
 * it does not need.
 *
 * What that means concretely: a key that works on the first model costs one
 * request. It does not cost one request per model on that URL.
 */

import { CONFIG } from './config.js';
import { FREE, orderModelsForVerify, verifiableModels } from './free-detector.js';
import { ProviderRegistry } from './provider-registry.js';
import { ModelRegistry } from './model-registry.js';
import { Mapper } from './mapper.js';
import { MetricsRegistry } from './metrics.js';
import { STATUS } from './statuses.js';
import { isoNow, sanitizeError } from './util.js';

export class KeyVerifier {
  constructor(storage, { providers, models, mapper, metrics } = {}) {
    this.storage = storage;
    this.providers = providers ?? new ProviderRegistry(storage);
    this.models = models ?? new ModelRegistry(storage);
    this.mapper = mapper ?? new Mapper(storage);
    // Metrics are per model, not per key: two keys on one URL measure the same
    // speed, and averaging them together would let a slow gateway look fast
    // because it also had a quick key.
    this.metrics = metrics ?? new MetricsRegistry(storage);
  }

  /**
   * Which models may this key be tried against, best first.
   *
   * Free-verified models come first because they are both the user's goal and
   * the cheapest thing to prove. PAID models are excluded outright: plan 30
   * forbids probing a paid model.
   */
  async candidates(providerId, { limit = CONFIG.verifyMaxModels } = {}) {
    const models = await this.models.list(providerId);
    const usable = verifiableModels(models.filter((m) => m.active !== false));
    return orderModelsForVerify(usable, { limit });
  }

  /**
   * Verify one key against its URL.
   *
   * Returns which model proved the key works and how many requests that took.
   * `attempted` is the honest cost figure to show the user.
   */
  async verifyKey({ keyId, run, onProgress } = {}) {
    const key = await this.storage.get('keys', keyId);
    if (!key) return { keyId, ok: false, reason: 'KEY_NOT_FOUND', attempted: 0 };

    const provider = await this.providers.get(key.providerId);
    if (!provider) return { keyId, ok: false, reason: 'PROVIDER_NOT_FOUND', attempted: 0 };

    const adapter = this.providers.adapterFor(provider);
    const candidates = await this.candidates(key.providerId);

    if (!candidates.length) {
      await this.keys_update(keyId, {
        status: STATUS.UNTESTED,
        lastCheckedAt: isoNow(),
        lastError: 'khong co model nao de thu',
      });
      return { keyId, ok: false, reason: 'NO_MODELS', attempted: 0 };
    }

    let attempted = 0;
    const attempts = [];

    for (const model of candidates) {
      if (run?.cancelled()) {
        return { keyId, ok: false, reason: 'CANCELLED', attempted, attempts };
      }

      onProgress?.({
        stage: 'verify',
        provider: provider.name,
        model: model.modelId,
        maskedKey: key.masked,
      });

      // One request. This is the only token spend in the whole flow.
      // probeWithMetrics streams so time-to-first-token and tokens/sec can be
      // read off the same call; no second request is made for measurement.
      const result = await adapter.probeWithMetrics({ model: model.modelId, secret: key.secret });
      attempted += 1;
      attempts.push({
        modelId: model.modelId,
        ok: result.ok,
        status: result.status,
        ttftMs: result.metrics?.ttftMs ?? null,
        tokensPerSec: result.metrics?.tokensPerSec ?? null,
      });

      // Only a success carries a measurement. A timeout or a 401 has no token
      // count, and storing zeros there would make a broken model look fast.
      if (result.ok && result.metrics) {
        await this.metrics.record(key.providerId, model.modelId, result.metrics);
      }

      // Persist the verdict for this triple regardless of what follows, so a
      // cancelled run still leaves usable information behind.
      const { mapping } = await this.mapper.upsert({
        providerId: key.providerId,
        modelId: model.modelId,
        keyId: key.id,
      });
      await this.mapper.record(mapping.id, result);

      if (result.ok) {
        // FIRST SUCCESS: stop here. No further models are tried.
        await this.keys_update(keyId, {
          status: STATUS.HEALTHY,
          verifiedModelId: model.modelId,
          lastCheckedAt: isoNow(),
          lastSuccessAt: isoNow(),
          lastError: null,
        });
        onProgress?.({
          stage: 'verify-done',
          provider: provider.name,
          model: model.modelId,
          ok: true,
          attempted,
        });
        return { keyId, ok: true, verifiedModelId: model.modelId, attempted, attempts };
      }

      // A key-scoped failure stops the walk early too: no point trying model
      // after model with a secret the provider just called invalid.
      if (result.status === STATUS.AUTH_INVALID || result.status === STATUS.EXPIRED) {
        await this.keys_update(keyId, {
          status: result.status,
          lastCheckedAt: isoNow(),
          lastError: sanitizeError(result.error ?? '', [key.secret]),
        });
        return { keyId, ok: false, reason: result.status, attempted, attempts };
      }
    }

    await this.keys_update(keyId, {
      status: STATUS.RATE_LIMITED,
      lastCheckedAt: isoNow(),
      lastError: 'khong model nao chay duoc',
    });
    return { keyId, ok: false, reason: 'ALL_FAILED', attempted, attempts };
  }

  /** Verify every key of one URL. */
  async verifyProvider({ providerId, run, onProgress } = {}) {
    const keys = await this.storage.list('keys');
    const mine = keys.filter((k) => k.providerId === providerId);
    const results = [];
    let requests = 0;

    for (const key of mine) {
      if (run?.cancelled()) break;
      const result = await this.verifyKey({ keyId: key.id, run, onProgress });
      requests += result.attempted ?? 0;
      results.push(result);
    }
    return { providerId, ok: results.some((r) => r.ok), requests, results };
  }

  async verifyAll({ run, onProgress } = {}) {
    const keys = await this.storage.list('keys');
    const results = [];
    let requests = 0;

    for (const key of keys) {
      if (run?.cancelled()) break;
      const result = await this.verifyKey({ keyId: key.id, run, onProgress });
      requests += result.attempted ?? 0;
      results.push(result);
    }
    return {
      ok: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
      requests,
      results,
    };
  }

  async keys_update(keyId, patch) {
    const key = await this.storage.get('keys', keyId);
    if (!key) return null;
    const updated = { ...key, ...patch, updatedAt: isoNow() };
    await this.storage.put('keys', updated);
    return updated;
  }
}

export { FREE };
