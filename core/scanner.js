/**
 * Model scanner (plan 8, 9).
 *
 * Discovery only. It never sends an inference request, so scanning a 460-model
 * provider costs no tokens - only the /models GET.
 *
 * Cache: a provider scanned recently is left alone unless forced, so opening
 * the UI does not re-fetch the world.
 */

import { CONFIG } from './config.js';
import { ProviderRegistry } from './provider-registry.js';
import { ModelRegistry } from './model-registry.js';
import { mapWithConcurrency, isoNow } from './util.js';
import { KEY_REQ, requirementFromDiscovery } from './key-requirement.js';

export class Scanner {
  constructor(storage, { providers, models } = {}) {
    this.storage = storage;
    this.providers = providers ?? new ProviderRegistry(storage);
    this.models = models ?? new ModelRegistry(storage);
  }

  /** True when a scan is worth doing (plan 9). */
  isStale(provider, ttlMs = CONFIG.cache.scanTtlMs) {
    const at = Date.parse(provider.lastScanAt ?? '');
    return !Number.isFinite(at) || Date.now() - at > ttlMs;
  }

  /**
   * Scan one provider.
   *
   * A provider with no /models endpoint is not an error the user must fix: it
   * is reported honestly and the provider stays, ready for manual models.
   */
  async scanProvider({ providerId, secret = null, force = false, onProgress } = {}) {
    const provider = await this.providers.get(providerId);
    if (!provider) return { providerId, ok: false, reason: 'NOT_FOUND' };

    if (provider.enabled === false) {
      return { providerId, ok: false, reason: 'DISABLED', models: 0 };
    }
    if (!force && !this.isStale(provider)) {
      return { providerId, ok: true, skipped: true, reason: 'FRESH', models: 0 };
    }

    const adapter = this.providers.adapterFor(provider);
    onProgress?.({ stage: 'discover', provider: provider.name });

    // A scan that was given a key proves nothing about whether the URL needs
    // one: /models answers 200 either way. Recording that as "no key needed"
    // would move Groq into the wrong drawer the first time the user pasted a
    // key into it. So the verdict is only drawn from an anonymous scan, and a
    // keyed scan leaves the previous verdict untouched.
    const anonymous = !secret;

    const result = await adapter.discoverModels({ secret });

    if (!result.ok) {
      // The scan is what proves whether this URL needs a key, so the verdict is
      // written here rather than inferred later from a stale `verified` field.
      // A 401/403 becomes REQUIRED; a 404, a timeout or a network failure stays
      // UNKNOWN, because "no key was sent" is not the same as "it wants a key".
      const keyRequirement = anonymous
        ? requirementFromDiscovery(result)
        : (provider.keyRequirement ?? KEY_REQ.UNKNOWN);
      await this.providers.update(providerId, {
        status: result.reason === 'TIMEOUT' ? 'TIMEOUT' : 'ERROR',
        lastError: result.error ?? null,
        ...(anonymous ? { keyRequirement, keyRequirementAt: isoNow() } : {}),
      });
      return {
        providerId,
        ok: false,
        reason: result.reason,
        keyRequirement,
        error: result.error,
        models: 0,
        latencyMs: result.latencyMs,
      };
    }

    let added = 0;
    let merged = 0;
    const seen = new Set();

    for (const model of result.models) {
      seen.add(model.modelId);
      const verdict = adapter.detectFree(model);
      const outcome = await this.models.upsertDiscovered({
        providerId,
        modelId: model.modelId,
        displayName: model.displayName,
        pricing: model.pricing,
        pricingSource: model.pricingSource ?? null,
        evidence: verdict.evidence,
        metadata: model.metadata,
      });
      if (outcome.state === 'created') added += 1;
      else merged += 1;
    }

    // Everything the scan did not return becomes NOT_SEEN, never deleted.
    const marked = await this.models.markUnseen(providerId, seen);

    // A 200 on /models is the proof that no key is needed to list this URL's
    // models, so it is recorded rather than left to be re-derived every render.
    await this.providers.update(providerId, {
      status: 'OK',
      lastScanAt: isoNow(),
      lastError: null,
      lastScanMs: result.latencyMs ?? null,
      ...(anonymous ? { keyRequirement: KEY_REQ.NONE, keyRequirementAt: isoNow() } : {}),
    });

    return {
      providerId,
      ok: true,
      reason: 'OK',
      keyRequirement: anonymous ? KEY_REQ.NONE : (provider.keyRequirement ?? KEY_REQ.UNKNOWN),
      total: result.models.length,
      added,
      merged,
      free: result.models.filter((m) => adapter.detectFree(m).freeStatus !== 'PAID').length,
      notSeen: marked.notSeen,
      deactivated: marked.deactivated,
      latencyMs: result.latencyMs,
    };
  }

  /**
   * Scan every provider. Providers are independent hosts, so they run in
   * parallel under a concurrency cap rather than one after another.
   */
  async scanAll({ force = false, secretFor = () => null, onProgress, run } = {}) {
    const providers = (await this.providers.list()).filter((p) => p.enabled !== false);
    const summary = {
      providers: 0,
      skipped: 0,
      failed: 0,
      added: 0,
      merged: 0,
      notSeen: 0,
      results: [],
      cancelled: false,
    };

    await mapWithConcurrency(
      providers,
      CONFIG.scanConcurrency,
      async (provider, index) => {
        if (run?.cancelled()) {
          summary.cancelled = true;
          return;
        }
        onProgress?.({
          stage: 'scan',
          provider: provider.name,
          position: index + 1,
          total: providers.length,
        });

        const result = await this.scanProvider({
          providerId: provider.id,
          secret: secretFor(provider),
          force,
        });
        summary.results.push(result);

        if (result.skipped) summary.skipped += 1;
        else if (result.ok) {
          summary.providers += 1;
          summary.added += result.added;
          summary.merged += result.merged;
          summary.notSeen += result.notSeen ?? 0;
        } else {
          summary.failed += 1;
        }
      }
    );

    return summary;
  }
}

export { isoNow };
