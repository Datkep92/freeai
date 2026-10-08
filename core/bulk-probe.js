/**
 * Bulk probe: one key, many models, one URL.
 *
 * This is deliberately NOT the verifier. The verifier asks "is this key alive on
 * this URL" and stops at the first model that answers, which is the right
 * question for a key and the wrong one for a model. This file asks the
 * question that only a batch can answer: of the models on this URL, how many
 * actually work with this key.
 *
 * Because it spends one request per model on purpose, three things bound it.
 *
 *   1. It never probes a paid model. The whole app exists to find things that
 *      cost nothing, and a batch run that quietly spends money on 200 paid
 *      models would be the worst bug in the codebase.
 *
 *   2. It runs strictly one request at a time. Concurrency here buys minutes
 *      and costs rate-limit bans on providers that hand out a handful of
 *      requests per minute - which is most of the free tier.
 *
 *   3. It stops itself once the failures stop looking like the model's fault.
 *      A dead key answers the same way on every model, so without this the run
 *      would spend its whole budget rediscovering one fact.
 *
 * What it writes is exactly what a per-model check would have written: a mapping
 * verdict, and metrics for a request that succeeded. A key's status is only
 * touched when the secret itself is the problem - never because one model
 * refused it.
 */

import { CONFIG } from './config.js';
import { ProviderRegistry } from './provider-registry.js';
import { ModelRegistry } from './model-registry.js';
import { Mapper } from './mapper.js';
import { MetricsRegistry } from './metrics.js';
import { STATUS } from './statuses.js';
import { orderModelsForVerify, verifiableModels } from './free-detector.js';
import { isoNow, sanitizeError } from './util.js';

/** Why a run stopped early. `null` means it ran the models it was given. */
export const STOP = {
  KEY_SUSPECT: 'KEY_SUSPECT',
  QUOTA: 'QUOTA',
  CANCELLED: 'CANCELLED',
};

/**
 * Failures that say something about the secret rather than the model.
 *
 * This mirrors KEY_BLOCKING_STATUS, which is the set the router already treats
 * as "this key will not work". Reusing the same list is what keeps a bulk run
 * and the router from disagreeing about what a dead key looks like.
 */
const KEY_FAILURES = new Set([
  STATUS.AUTH_INVALID,
  STATUS.EXPIRED,
  STATUS.QUOTA_EXHAUSTED,
  STATUS.DISABLED,
]);

export class BulkProbe {
  constructor(storage, { providers, models, mapper, metrics } = {}) {
    this.storage = storage;
    this.providers = providers ?? new ProviderRegistry(storage);
    this.models = models ?? new ModelRegistry(storage);
    this.mapper = mapper ?? new Mapper(storage);
    this.metrics = metrics ?? new MetricsRegistry(storage);
  }

  /**
   * The models this key may be tried against, best first.
   *
   * PAID is excluded outright and inactive models are dropped, both for the
   * reason above. Ordering is the same one the verifier uses, so a bulk run and
   * a "check this key" agree about which model deserves the first request.
   */
  async candidates(providerId, { limit = CONFIG.bulkProbe.defaultLimit } = {}) {
    const all = await this.models.list(providerId);
    const usable = verifiableModels(all.filter((m) => m.active !== false));
    return orderModelsForVerify(usable, { limit });
  }

  /**
   * Run one key across up to `limit` models of one provider.
   *
   * Returns { results, stopped, stopReason, requests, healthy } where each entry
   * of `results` is { modelId, ok, status, latencyMs, ttftMs, tokensPerSec }.
   *
   * `onProgress` is called once per model as it finishes, so a caller can paint
   * the row rather than wait for the whole run. Whatever was measured before a
   * stop or a cancel stays written - a partial run is still real evidence.
   */
  async run({ providerId, keyId, limit = CONFIG.bulkProbe.defaultLimit, run, onProgress } = {}) {
    const cfg = CONFIG.bulkProbe;
    const results = [];
    let requests = 0;
    let stopped = false;
    let stopReason = null;

    const provider = await this.providers.get(providerId);
    const key = await this.storage.get('keys', keyId);
    if (!provider) return { results, stopped: false, stopReason: 'PROVIDER_NOT_FOUND', requests: 0, healthy: 0 };
    if (!key) return { results, stopped: false, stopReason: 'KEY_NOT_FOUND', requests: 0, healthy: 0 };

    const adapter = this.providers.adapterFor(provider);
    const candidates = await this.candidates(providerId, { limit });

    if (!candidates.length) {
      return { results, stopped: false, stopReason: 'NO_MODELS', requests: 0, healthy: 0 };
    }

    // Consecutive failures that look like the key's fault. Model-scoped failures
    // deliberately do not touch it: a URL where the key is blocked from 20
    // models is one healthy key with a restricted grant, not a broken secret.
    let keyFailureStreak = 0;

    for (const model of candidates) {
      if (run?.cancelled()) {
        stopped = true;
        stopReason = STOP.CANCELLED;
        break;
      }

      const result = await adapter.probeWithMetrics({
        model: model.modelId,
        secret: key.secret,
        maxTokens: cfg.maxTokens,
      });
      requests += 1;

      const entry = {
        modelId: model.modelId,
        ok: Boolean(result.ok),
        status: result.ok ? STATUS.HEALTHY : (result.status ?? STATUS.UNKNOWN_ERROR),
        latencyMs: result.latencyMs ?? null,
        ttftMs: result.metrics?.ttftMs ?? null,
        tokensPerSec: result.metrics?.tokensPerSec ?? null,
        error: result.error ?? null,
      };
      results.push(entry);

      // Only a success carries a measurement: a 401 has no token count, and
      // storing zeros there would make a broken model look fast.
      if (entry.ok && result.metrics) {
        await this.metrics.record(providerId, model.modelId, result.metrics);
      }

      const { mapping } = await this.mapper.upsert({
        providerId,
        modelId: model.modelId,
        keyId,
      });
      await this.mapper.record(mapping.id, result);

      if (entry.ok) {
        keyFailureStreak = 0;
      } else if (KEY_FAILURES.has(entry.status)) {
        keyFailureStreak += 1;
      }

      onProgress?.({ entry, index: results.length, total: candidates.length, model });

      // Quota is terminal and unambiguous: there is nothing left to spend, so
      // continuing would only produce a longer list of the same answer.
      if (entry.status === STATUS.QUOTA_EXHAUSTED) {
        stopped = true;
        stopReason = STOP.QUOTA;
        break;
      }

      if (keyFailureStreak >= cfg.keyFailureStreak) {
        stopped = true;
        stopReason = STOP.KEY_SUSPECT;
        break;
      }
    }

    // The key is marked once, at the end, and only from the failures that point
    // at the secret. A model refusing this key says nothing about whether the
    // key works anywhere else, so writing that verdict onto the key would
    // remove a working credential from the rotation.
    if (stopReason === STOP.KEY_SUSPECT || stopReason === STOP.QUOTA) {
      const lastBad = [...results].reverse().find((r) => !r.ok && KEY_FAILURES.has(r.status));
      const status = lastBad?.status ?? STATUS.AUTH_INVALID;
      await this.storage.put('keys', {
        ...key,
        status,
        lastCheckedAt: isoNow(),
        lastError: sanitizeError(lastBad?.error ?? '', [key.secret]),
        updatedAt: isoNow(),
      });
    }

    return {
      results,
      stopped,
      stopReason,
      requests,
      healthy: results.filter((r) => r.ok).length,
    };
  }

  /**
   * Many models, many keys: for each free model, try this URL's keys in the
   * order given and stop at the first one that answers.
   *
   * This is the shape the "quét nhiều model" button runs. The single-key `run`
   * above answers "how many models does this one key open"; this answers the
   * question a user with several keys actually has - "is this model usable at
   * all, and by which key". Trying every key against every model would be an
   * N×M bill for one fact per pair; stopping at the first success is the cheap
   * way to learn the only thing the list shows: which model works.
   *
   * A key that fails the same way on enough consecutive models is treated as
   * dead and skipped for the rest of the run, exactly as in `run`, so one bad
   * secret cannot spend the whole budget. A model refused by every key is still
   * reported, with the last refusal as its reason.
   *
   * Returns { results, stopped, stopReason, requests, healthy, keyIds } where
   * each result is { modelId, keyId, keyMasked, ok, status, latencyMs, ttftMs,
   * tokensPerSec, error }.
   */
  async runAcrossKeys({ providerId, keyIds = [], limit = CONFIG.bulkProbe.defaultLimit, run, onProgress } = {}) {
    const cfg = CONFIG.bulkProbe;
    const results = [];
    let requests = 0;
    let stopped = false;
    let stopReason = null;

    const provider = await this.providers.get(providerId);
    if (!provider) {
      return { results, stopped: false, stopReason: 'PROVIDER_NOT_FOUND', requests: 0, healthy: 0, keyIds: [] };
    }

    const slots = [];
    for (const id of keyIds) {
      const row = await this.storage.get('keys', id);
      if (row) slots.push({ row, streak: 0, dead: false, deadReason: null });
    }
    if (!slots.length) {
      return { results, stopped: false, stopReason: 'KEY_NOT_FOUND', requests: 0, healthy: 0, keyIds: [] };
    }

    const adapter = this.providers.adapterFor(provider);
    const candidates = await this.candidates(providerId, { limit });
    if (!candidates.length) {
      return { results, stopped: false, stopReason: 'NO_MODELS', requests: 0, healthy: 0, keyIds: slots.map((s) => s.row.id) };
    }

    // The key is marked once, when it has failed enough, and only from the
    // failures that point at the secret - never because one model refused it.
    const markKey = async (slot, status, error) => {
      await this.storage.put('keys', {
        ...slot.row,
        status,
        lastCheckedAt: isoNow(),
        lastError: sanitizeError(error ?? '', [slot.row.secret]),
        updatedAt: isoNow(),
      });
    };

    for (const model of candidates) {
      if (run?.cancelled()) {
        stopped = true;
        stopReason = STOP.CANCELLED;
        break;
      }

      let entry = null;
      for (const slot of slots) {
        if (slot.dead) continue;
        const key = slot.row;
        const result = await adapter.probeWithMetrics({
          model: model.modelId,
          secret: key.secret,
          maxTokens: cfg.maxTokens,
        });
        requests += 1;

        const ok = Boolean(result.ok);
        const status = ok ? STATUS.HEALTHY : (result.status ?? STATUS.UNKNOWN_ERROR);

        const { mapping } = await this.mapper.upsert({
          providerId,
          modelId: model.modelId,
          keyId: key.id,
        });
        await this.mapper.record(mapping.id, result);

        if (ok) {
          if (result.metrics) await this.metrics.record(providerId, model.modelId, result.metrics);
          slot.streak = 0;
          entry = {
            modelId: model.modelId,
            keyId: key.id,
            keyMasked: key.masked,
            ok: true,
            status,
            latencyMs: result.latencyMs ?? null,
            ttftMs: result.metrics?.ttftMs ?? null,
            tokensPerSec: result.metrics?.tokensPerSec ?? null,
            error: null,
          };
          break;
        }

        entry = {
          modelId: model.modelId,
          keyId: key.id,
          keyMasked: key.masked,
          ok: false,
          status,
          latencyMs: result.latencyMs ?? null,
          ttftMs: null,
          tokensPerSec: null,
          error: result.error ?? null,
        };

        // Quota is terminal for that key only: another key may still answer,
        // so it is retired rather than stopping the whole run.
        if (status === STATUS.QUOTA_EXHAUSTED) {
          slot.dead = true;
          slot.deadReason = STOP.QUOTA;
          await markKey(slot, STATUS.QUOTA_EXHAUSTED, result.error);
          continue;
        }

        if (KEY_FAILURES.has(status)) {
          slot.streak += 1;
          if (slot.streak >= cfg.keyFailureStreak) {
            slot.dead = true;
            slot.deadReason = STOP.KEY_SUSPECT;
            await markKey(slot, status, result.error);
          }
        }
      }

      if (entry) results.push(entry);
      onProgress?.({ entry, index: results.length, total: candidates.length, model });

      // No key left that could answer, so there is nothing more to learn.
      if (slots.every((s) => s.dead)) {
        stopped = true;
        stopReason = slots.some((s) => s.deadReason === STOP.QUOTA) ? STOP.QUOTA : STOP.KEY_SUSPECT;
        break;
      }
    }

    return {
      results,
      stopped,
      stopReason,
      requests,
      healthy: results.filter((r) => r.ok).length,
      keyIds: slots.map((s) => s.row.id),
    };
  }
}
