/**
 * Router (plan 18, 19).
 *
 * Fallback order: KEY -> MODEL -> PROVIDER.
 *   URL A / Model A / Key 1 fails
 *     -> Key 2 on the same model
 *     -> next model on the same URL
 *     -> the same model on the next provider
 *
 * FREE_ONLY is the default because free is the whole point of the app. A paid
 * model is only ever used when the caller explicitly opts in.
 *
 * Lazy learning (plan 19): an UNTESTED mapping is not skipped - it is tried
 * for real and the result is written back, so the registry learns from use
 * instead of from a pre-flight test that would cost quota up front.
 */

import { CONFIG } from './config.js';
import { STATUS, KEY_BLOCKING_STATUS } from './statuses.js';
import { FREE } from './free-detector.js';
import { createAdapter } from './adapters/builtin.js';
import { measure } from './metrics.js';
import { isProviderAvailable, recordProviderFailure, recordProviderSuccess, refreshBreaker } from './circuit.js';
import { isoNow, sanitizeError } from './util.js';
import { Priority, SCOPE, ROTATION, sortByPriority } from './priority.js';

export class Router {
  constructor(storage, { providers, models, mapper, priority, metrics } = {}) {
    this.storage = storage;
    this.providers = providers;
    this.models = models;
    this.mapper = mapper;
    // The user's own ordering and skip list. Optional so a caller that only
    // wants a plain health-ranked list still works, but the app passes both so
    // a locked row can never be picked.
    this.priority = priority ?? new Priority(storage);
    this.metrics = metrics ?? null;
  }

  /**
   * Every mapping that could serve a request, ranked.
   * `freeOnly` is applied here rather than at call sites so no caller can
   * accidentally route to a paid model.
   */
  async candidates({ freeOnly = true, modelId = null, now = Date.now() } = {}) {
    const [mappings, keys, models, providerRows] = await Promise.all([
      this.mapper.list(),
      this.storage.list('keys'),
      this.models.list(),
      this.providers.list(),
    ]);

    const keyById = new Map(keys.map((k) => [k.id, k]));
    const modelByKey = new Map(models.map((m) => [`${m.providerId}::${m.modelId}`, m]));
    const providerById = new Map(providerRows.map((p) => [p.id, p]));

    // The user's rules, resolved per URL. A locked URL is out entirely; a locked
    // model or key is out of that URL only, and the per-URL override wins over
    // the global one. Read here rather than at the call site so the UI list and
    // the router agree on what "usable" means.
    const globalState = await this.priority.load();
    const globallyLockedUrls = new Set(globalState.skipped?.[SCOPE.PROVIDER] ?? []);
    const effectiveByProvider = new Map();

    const out = [];

    for (const mapping of mappings) {
      const key = keyById.get(mapping.keyId);
      const provider = providerById.get(mapping.providerId);
      const model = modelByKey.get(`${mapping.providerId}::${mapping.modelId}`);
      if (!key || !provider || !model) continue;

      if (modelId && mapping.modelId !== modelId) continue;
      if (model.active === false) continue;

      if (freeOnly) {
        if (model.freeStatus === FREE.PAID) continue;
        // UNKNOWN models are not dropped: refusing to route them would make
        // the hub useless for every provider that hides its pricing.
      }

      if (key.enabled === false) continue;
      if (KEY_BLOCKING_STATUS.has(key.status)) continue;
      if (KEY_BLOCKING_STATUS.has(mapping.status)) continue;
      if (mapping.status === STATUS.MODEL_DENIED) continue;
      if (mapping.status === STATUS.MODEL_UNAVAILABLE) continue;
      if (mapping.status === STATUS.DISABLED) continue;
      if (mapping.cooldownUntil && mapping.cooldownUntil > now) continue;

      if (!isProviderAvailable(provider.breaker, { now })) continue;

      // A locked URL takes its whole subtree out. This is inheritance, not a
      // copy: nothing was written onto the models or keys, so a URL locked
      // yesterday still covers a model discovered this morning.
      if (globallyLockedUrls.has(provider.id)) continue;

      const effective =
        effectiveByProvider.get(provider.id) ??
        (await this.priority.forProvider(provider));
      effectiveByProvider.set(provider.id, effective);

      // A lock is matched by either id form: the UI writes row ids globally and
      // model ids per URL, so both have to be honoured or one of them is dead.
      if (effective.skippedModels?.has(model.id) || effective.skippedModels?.has(model.modelId)) continue;
      if (effective.skippedKeys?.has(key.id) || effective.skippedKeys?.has(key.fingerprint)) continue;

      out.push({
        mapping,
        key,
        provider,
        model,
        score:
          (mapping.score ?? 0) +
          (model.freeStatus === FREE.FREE_VERIFIED ? 60 : model.freeStatus === FREE.FREE_LIKELY ? 30 : 0) +
          (mapping.verified ? 25 : 0),
      });
    }

    // The user's decision comes first. `sortByPriority` already encodes the
    // precedence: an id they dragged outranks anything, then the per-URL rule
    // decides - fastest measured first by default - and the health-derived score
    // is only the tie-break.
    //
    // Per-URL order and rotation are applied before the cross-URL ranking, so
    // two URLs offering the same model each keep the order that URL was given,
    // instead of the first URL's arrangement deciding both.
    const metrics = this.metrics ? await this.metrics.mapFor(models) : new Map();
    // `groups` holds each URL's list in the order that URL was ranked in, and
    // that order is the answer - so it is what gets returned, not the flat
    // list that was being rebuilt separately.
    const groups = [];
    const byProvider = new Map();
    for (const candidate of out) {
      if (!byProvider.has(candidate.provider.id)) byProvider.set(candidate.provider.id, []);
      byProvider.get(candidate.provider.id).push(candidate);
    }
    for (const [providerId, list] of byProvider) {
      const effective = effectiveByProvider.get(providerId) ?? { rotation: ROTATION.SPEED };
      const perUrl = sortByPriority(list, {
        skipped: new Set(), // already applied above
        order: effective.orderModels ?? [],
        rotation: effective.rotation ?? ROTATION.SPEED,
        metrics,
        scope: SCOPE.MODEL,
        // A candidate wraps the real rows, so both identities are named here:
        // the stored row id for the dragged order, and "URL::model" for the
        // measurement, which is how metrics are keyed.
        idOf: (candidate) => candidate.model.id,
        metricKeyOf: (candidate) => `${candidate.provider.id}::${candidate.model.modelId}`,
        fallback: (a, b) =>
          Number(!!b.mapping.verified) - Number(!!a.mapping.verified) ||
          b.score - a.score,
      });
      groups.push(perUrl);
    }

    // Across URLs the user's per-URL order cannot be compared - it only means
    // anything inside the URL it was dragged in. So each URL keeps the ranking
    // it was just given and the groups are concatenated by how healthy their
    // best option is. Sorting the flattened list instead would throw away every
    // dragged position established above.
    groups.sort((a, b) => {
      const best = (list) => list.reduce((acc, c) => (c.score > acc.score ? c : acc), list[0]);
      const left = best(a);
      const right = best(b);
      if (left.mapping.verified !== right.mapping.verified) return left.mapping.verified ? -1 : 1;
      if (left.score !== right.score) return right.score - left.score;
      return 0; // stable: the order the URLs were stored in is kept
    });
    return groups.flat();
  }

  async pick(options = {}) {
    const all = await this.candidates(options);
    return all[0] ?? null;
  }

  /**
   * Serve a request, walking the fallback chain on failure.
   *
   * Each attempt either succeeds or records the failure against that exact
   * mapping, so the next call starts from better information.
   */
  async complete({ messages, modelId = null, freeOnly = true, maxTokens = 64, maxAttempts = 4, timeoutMs = CONFIG.probeTimeoutMs, onEvent, run } = {}) {
    const tried = [];

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const excluded = new Set(tried.map((t) => t.mappingId));
      const all = (await this.candidates({ freeOnly, modelId })).filter(
        (c) => !excluded.has(c.mapping.id)
      );
      if (!all.length) {
        return { ok: false, reason: 'NO_ELIGIBLE_MAPPING', tried };
      }

      // Prefer another key on the same model before giving up on the model.
      const sameModel = all.find((c) => c.mapping.modelId === (tried.at(-1)?.modelId ?? c.mapping.modelId));
      const candidate = sameModel ?? all[0];
      const adapter = createAdapter(candidate.provider);

      onEvent?.({ stage: 'attempt', provider: candidate.provider.name, model: candidate.mapping.modelId });
      const startedAt = Date.now();

      try {
        const request = adapter.buildChatRequest({ model: candidate.mapping.modelId, maxTokens });
        const { response, latencyMs, error } = await fetchWithTimeout(
          adapter.chatUrl(),
          {
            method: request.method,
            headers: adapter.buildAuthHeaders(candidate.key.secret),
            body: JSON.stringify({
              model: candidate.mapping.modelId,
              messages,
              max_tokens: maxTokens,
            }),
          },
          timeoutMs
        );

        if (error) throw error;

        if (response.ok) {
          const payload = await response.json().catch(() => null);
          const content =
            payload?.choices?.[0]?.message?.content ?? payload?.choices?.[0]?.text ?? '';

          await this._recordSuccess(candidate, { payload, latencyMs });

          onEvent?.({ stage: 'success', provider: candidate.provider.name, model: candidate.mapping.modelId, latencyMs });
          return { ok: true, content, provider: candidate.provider.name, model: candidate.mapping.modelId, latencyMs, tried };
        }

        const payload = await response.json().catch(() => null);
        const classified = adapter.classifyError({
          httpStatus: response.status,
          payload,
          headers: response.headers,
        });
        tried.push({
          mappingId: candidate.mapping.id,
          providerId: candidate.provider.id,
          modelId: candidate.mapping.modelId,
          status: classified.status,
        });
        await this._recordFailure(candidate, classified, Date.now() - startedAt);
        onEvent?.({ stage: 'failed', provider: candidate.provider.name, model: candidate.mapping.modelId, status: classified.status });
      } catch (error) {
        tried.push({
          mappingId: candidate.mapping.id,
          providerId: candidate.provider.id,
          modelId: candidate.mapping.modelId,
          status: STATUS.TEMP_ERROR,
        });
        await this.mapper.record(candidate.mapping.id, {
          ok: false,
          status: STATUS.TEMP_ERROR,
          error: sanitizeError(error.message ?? '', [candidate.key.secret]),
          latencyMs: Date.now() - startedAt,
        });
        onEvent?.({ stage: 'failed', provider: candidate.provider.name, error: error.message });
      }

      if (run?.cancelled()) return { ok: false, reason: 'CANCELLED', tried };
    }

    return { ok: false, reason: 'ALL_ATTEMPTS_FAILED', tried };
  }

  /**
   * Serve a streamed chat turn, walking the same fallback chain as complete().
   *
   * The rotation is deliberately not reimplemented: candidates(), cooldown,
   * the circuit breaker, the key/model/provider fallback and lazy learning are
   * the same code the console and the verifier already trust. Only the transport
   * differs - tokens go out through `onToken` as they arrive.
   *
   * One rule is new, and it is about honesty rather than plumbing: a stream that
   * has already emitted text is never retried on another model. Swapping models
   * after the user has seen half an answer would splice two replies together
   * with no seam, so a failure past the first token is reported as partial. The
   * failure is still recorded, so the next call starts from better information.
   */
  async streamChat({
    messages,
    modelId = null,
    freeOnly = true,
    maxTokens = 256,
    maxAttempts = 4,
    timeoutMs = CONFIG.probeTimeoutMs,
    onToken,
    onEvent,
    run,
  } = {}) {
    const tried = [];

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const excluded = new Set(tried.map((t) => t.mappingId));
      const all = (await this.candidates({ freeOnly, modelId })).filter(
        (c) => !excluded.has(c.mapping.id)
      );
      if (!all.length) {
        return { ok: false, reason: 'NO_ELIGIBLE_MAPPING', tried };
      }

      const sameModel = all.find((c) => c.mapping.modelId === (tried.at(-1)?.modelId ?? c.mapping.modelId));
      const candidate = sameModel ?? all[0];
      const adapter = createAdapter(candidate.provider);

      onEvent?.({ stage: 'attempt', provider: candidate.provider.name, model: candidate.mapping.modelId });
      const startedAt = Date.now();
      let emitted = false;

      try {
        const result = await adapter.streamChat({
          model: candidate.mapping.modelId,
          secret: candidate.key.secret,
          messages,
          maxTokens,
          timeoutMs,
          onToken: (delta) => {
            emitted = true;
            onToken?.(delta);
          },
        });

        if (result.ok) {
          await this._recordSuccess(candidate, { payload: result.payload, latencyMs: result.latencyMs });
          onEvent?.({ stage: 'success', provider: candidate.provider.name, model: candidate.mapping.modelId, latencyMs: result.latencyMs });
          return {
            ok: true,
            content: result.content ?? '',
            toolCalls: result.toolCalls ?? [],
            finishReason: result.finishReason ?? null,
            provider: candidate.provider.name,
            providerId: candidate.provider.id,
            keyId: candidate.key.id,
            model: candidate.mapping.modelId,
            latencyMs: result.latencyMs,
            ttftMs: result.ttftMs ?? null,
            // Only the usage is carried out: the session sums it for its budget,
            // and the whole payload is not something a caller needs.
            usage: result.payload?.usage ?? null,
            tried,
          };
        }

        tried.push({
          mappingId: candidate.mapping.id,
          providerId: candidate.provider.id,
          modelId: candidate.mapping.modelId,
          status: result.status,
        });

        await this._recordFailure(
          candidate,
          { status: result.status, scope: result.scope, message: result.error, retryAfterMs: result.retryAfterMs },
          Date.now() - startedAt
        );
        onEvent?.({ stage: 'failed', provider: candidate.provider.name, model: candidate.mapping.modelId, status: result.status });

        if (emitted) {
          return { ok: false, reason: 'PARTIAL', status: result.status, partial: true, tried };
        }
      } catch (error) {
        tried.push({
          mappingId: candidate.mapping.id,
          providerId: candidate.provider.id,
          modelId: candidate.mapping.modelId,
          status: STATUS.TEMP_ERROR,
        });
        await this.mapper.record(candidate.mapping.id, {
          ok: false,
          status: STATUS.TEMP_ERROR,
          error: sanitizeError(error.message ?? '', [candidate.key.secret]),
          latencyMs: Date.now() - startedAt,
        });
        onEvent?.({ stage: 'failed', provider: candidate.provider.name, error: error.message });
        if (emitted) return { ok: false, reason: 'PARTIAL', status: STATUS.TEMP_ERROR, partial: true, tried };
      }

      if (run?.cancelled()) return { ok: false, reason: 'CANCELLED', tried };
    }

    return { ok: false, reason: 'ALL_ATTEMPTS_FAILED', tried };
  }

  /**
   * Write what a successful request proves, in one place.
   *
   * A real request is the best speed sample there is, so its numbers are
   * recorded here too: without this the ranking would only ever know about
   * models the user happened to run a "check API" on, and every other model
   * would sort as unknown forever. Time to first token is unavailable on a
   * non-streaming call, so it stays null rather than being back-calculated.
   *
   * Extracted rather than inlined at both call sites so a streamed turn and a
   * plain one cannot drift into disagreeing about what "healthy" writes.
   */
  async _recordSuccess(candidate, { payload, latencyMs }) {
    await this.mapper.record(candidate.mapping.id, { ok: true, latencyMs });

    if (this.metrics) {
      await this.metrics.record(
        candidate.provider.id,
        candidate.mapping.modelId,
        measure({ payload, totalMs: latencyMs, ttftMs: null })
      );
    }
    await this.storage.put('keys', {
      ...candidate.key,
      status: STATUS.HEALTHY,
      lastSuccessAt: isoNow(),
      updatedAt: isoNow(),
    });
    await this.providers.update(candidate.provider.id, {
      breaker: recordProviderSuccess(candidate.provider.breaker),
    });
  }

  /**
   * Failure handling, scoped by who is at fault.
   *
   * A key-scoped verdict updates the key but must never take the other
   * mappings of that key down with it - the key may still work elsewhere.
   */
  async _recordFailure(candidate, classified, latencyMs) {
    await this.mapper.record(candidate.mapping.id, {
      ok: false,
      status: classified.status,
      error: sanitizeError(classified.message ?? '', [candidate.key.secret]),
      retryAfterMs: classified.retryAfterMs,
      latencyMs,
    });

    if (classified.scope === 'key' && candidate.key) {
      await this.storage.put('keys', {
        ...candidate.key,
        status: classified.status,
        lastFailureAt: isoNow(),
        updatedAt: isoNow(),
      });
    }

    if (classified.status === STATUS.PROVIDER_DOWN) {
      const provider = await this.providers.get(candidate.provider.id);
      await this.providers.update(candidate.provider.id, {
        breaker: recordProviderFailure(provider?.breaker),
      });
    } else {
      const provider = await this.providers.get(candidate.provider.id);
      await this.providers.update(candidate.provider.id, {
        breaker: refreshBreaker(provider?.breaker),
      });
    }
  }
}

/**
 * fetch with a timeout, and the duration of the call.
 *
 * The timing is taken here rather than around the caller, because the caller's
 * own clock also covers JSON parsing and bookkeeping - time that is not the
 * provider's answer time. `latencyMs` used to be missing from this return value
 * entirely, which made every recorded duration undefined: the health score, the
 * cooldown maths and the speed ranking were all silently reading nothing.
 */
async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    return { response, latencyMs: Date.now() - startedAt, error: null };
  } catch (error) {
    return { response: null, latencyMs: Date.now() - startedAt, error };
  } finally {
    clearTimeout(timer);
  }
}
