/**
 * Model metrics (plan 31).
 *
 * The router used to know one number about a model: how long the last request
 * took. That is not enough to choose between two free models that both work, so
 * this file measures the things a person actually compares when picking one:
 *
 *   ttftMs        time to first token - what "snappy" means
 *   tokensPerSec  generation speed
 *   totalMs       end to end
 *   promptTokens / completionTokens - what the request cost in quota
 *   contextWindow - published limit, when the provider states it
 *
 * Two rules this file exists to enforce:
 *
 *   1. A measurement is only ever stored for a request that actually succeeded.
 *      A 401 or a timeout has no token count, and writing zeros there would
 *      make a broken model look fast.
 *
 *   2. Numbers are aggregated, never overwritten. One request proves a model
 *      works; it does not prove it is fast. So a model keeps a running average
 *      plus its best and worst seen, and the router reads the average.
 *
 * Everything is deterministic and derived from stored rows, so the same history
 * always produces the same numbers.
 */

import { CONFIG } from './config.js';
import { isoNow, makeId } from './util.js';

const metricCfg = CONFIG.metrics;

/**
 * A fresh, empty metrics row.
 *
 * Shape is fixed rather than merged in so a caller reading `row.tokensPerSec`
 * always gets a number or null, never undefined.
 */
export function emptyMetrics() {
  return {
    samples: 0,
    ttftMs: null,
    tokensPerSec: null,
    totalMs: null,
    promptTokens: null,
    completionTokens: null,
    bestTtftMs: null,
    worstTtftMs: null,
    bestTokensPerSec: null,
    lastMeasuredAt: null,
  };
}

/**
 * Read token counts out of a provider response.
 *
 * Providers disagree on every field name and some omit them entirely, so every
 * read is optional and a missing field is null rather than 0. Zero is a real
 * value for completion_tokens on an empty answer and must not be lost.
 */
export function readUsage(payload) {
  if (!payload || typeof payload !== 'object') return { promptTokens: null, completionTokens: null, totalTokens: null };

  const usage = payload.usage ?? payload.token_usage ?? payload.usageMetadata ?? null;
  if (!usage || typeof usage !== 'object') return { promptTokens: null, completionTokens: null, totalTokens: null };

  // Gemini nests camelCase under promptTokenCount and also reports
  // candidatesTokenCount; OpenAI-compatible uses prompt/completion.
  const pick = (...names) => {
    for (const name of names) {
      const value = usage[name];
      if (typeof value === 'number' && Number.isFinite(value)) return value;
      if (typeof value === 'string') {
        const n = Number(value);
        if (Number.isFinite(n)) return n;
      }
    }
    return null;
  };

  const promptTokens = pick('prompt_tokens', 'promptTokenCount', 'input_tokens', 'inputTokens');
  const completionTokens = pick('completion_tokens', 'candidatesTokenCount', 'output_tokens', 'outputTokens');
  const totalTokens = pick('total_tokens', 'totalTokenCount') ?? sum(promptTokens, completionTokens);

  return { promptTokens, completionTokens, totalTokens };
}

/**
 * Turn one finished request into a measurement.
 *
 * `ttftMs` and `totalMs` are measured on the client because no provider
 * reports either. `tokensPerSec` is only computed when both a completion count
 * and a generation duration are available - dividing by a duration that
 * includes the prompt would understate every model on a short prompt.
 */
export function measure({ payload, totalMs, ttftMs, usage } = {}) {
  const counted = usage ?? readUsage(payload);
  const completionTokens = counted.completionTokens;

  // Generation time is total minus time-to-first-token: the part of the request
  // that was actually producing tokens.
  const generationMs =
    Number.isFinite(ttftMs) && Number.isFinite(totalMs) && totalMs > ttftMs ? totalMs - ttftMs : null;

  const tokensPerSec =
    Number.isFinite(completionTokens) && completionTokens > 0 && generationMs !== null && generationMs > 0
      ? round1((completionTokens / generationMs) * 1000)
      : null;

  return {
    ttftMs: Number.isFinite(ttftMs) ? Math.round(ttftMs) : null,
    tokensPerSec,
    totalMs: Number.isFinite(totalMs) ? Math.round(totalMs) : null,
    promptTokens: counted.promptTokens,
    completionTokens,
  };
}

/**
 * Fold one measurement into a stored row.
 *
 * The running average is weighted by sample count rather than replacing the
 * previous value, so a single fast request on a model that is usually slow does
 * not make it look fast. Best and worst are kept because "it has hit 900 tok/s
 * once" is worth knowing even when the average is 300.
 */
export function accumulate(row, measurement) {
  const base = { ...emptyMetrics(), ...(row ?? {}) };
  const next = { ...base };

  if (!measurement || !Number.isFinite(measurement.totalMs) && !Number.isFinite(measurement.ttftMs)) {
    return next;
  }

  next.samples = (base.samples ?? 0) + 1;
  next.lastMeasuredAt = isoNow();

  for (const field of ['ttftMs', 'tokensPerSec', 'totalMs', 'promptTokens', 'completionTokens']) {
    const value = measurement[field];
    if (value === null || value === undefined || !Number.isFinite(value)) continue;

    // Averaging a token count across samples of different prompt sizes would
    // produce a meaningless number, so the latest real value is kept instead.
    if (field === 'promptTokens' || field === 'completionTokens') {
      next[field] = value;
      continue;
    }

    next[field] = mergeAverage(base[field], value, next.samples - 1);
  }

  if (Number.isFinite(measurement.ttftMs)) {
    next.bestTtftMs = minOrFirst(base.bestTtftMs, measurement.ttftMs);
    next.worstTtftMs = maxOrFirst(base.worstTtftMs, measurement.ttftMs);
  }
  if (Number.isFinite(measurement.tokensPerSec)) {
    next.bestTokensPerSec = maxOrFirst(base.bestTokensPerSec, measurement.tokensPerSec);
  }

  return next;
}

/**
 * Metrics registry.
 *
 * One row per model, addressed the same way the router addresses a candidate:
 * providerId plus modelId. Two URLs can offer the same model name, and they are
 * measured separately - a slow gateway and a fast one are not the same model.
 */
export class MetricsRegistry {
  constructor(storage) {
    this.storage = storage;
  }

  static identity(providerId, modelId) {
    return `${providerId}::${modelId}`;
  }

  async get(providerId, modelId) {
    const row = await this.storage.get('metrics', MetricsRegistry.identity(providerId, modelId));
    return row ?? null;
  }

  /**
   * Read metrics for many models at once, keyed by identity.
   *
   * One read for the whole store rather than one per model. The router calls this
   * on every request to rank candidates, so a per-model read would make the
   * ranking cost one IndexedDB round trip per model on screen.
   */
  async mapFor(models) {
    const rows = await this.storage.list('metrics');
    const byIdentity = new Map(rows.map((r) => [r.identity, r]));
    const out = new Map();
    for (const model of models) {
      const identity = MetricsRegistry.identity(model.providerId, model.modelId);
      out.set(identity, byIdentity.get(identity) ?? emptyMetrics());
    }
    return out;
  }

  /**
   * Record one successful request.
   *
   * Returns the new row, or null when there was nothing worth storing - a
   * failed call must never create a row that reads as "measured".
   */
  async record(providerId, modelId, measurement) {
    if (!Number.isFinite(measurement?.totalMs) && !Number.isFinite(measurement?.ttftMs)) return null;

    const identity = MetricsRegistry.identity(providerId, modelId);
    const existing = await this.storage.get('metrics', identity);
    const next = {
      ...accumulate(existing, measurement),
      id: identity,
      identity,
      providerId,
      modelId,
    };
    await this.storage.put('metrics', next);
    return next;
  }

  async removeForProvider(providerId) {
    const rows = await this.storage.findMany('metrics', { where: { providerId } });
    if (!rows.length) return 0;
    await this.storage.removeMany('metrics', rows.map((r) => r.id));
    return rows.length;
  }

  /** Drop rows whose model no longer exists. */
  async pruneOrphans(existingIdentities) {
    const rows = await this.storage.list('metrics');
    let removed = 0;
    for (const row of rows) {
      if (existingIdentities.has(row.identity)) continue;
      await this.storage.remove('metrics', row.id);
      removed += 1;
    }
    return removed;
  }
}

/**
 * Rank models for display.
 *
 * Unknown metrics sort last rather than being treated as zero: a model that has
 * never run is not slow, it is unmeasured, and showing it at the bottom because
 * it looks like a 0 tok/s model would be a lie.
 */
export function compareBySpeed(a, b) {
  const scoreA = speedScore(a);
  const scoreB = speedScore(b);
  if (scoreA !== scoreB) return scoreB - scoreA;
  return 0;
}

function speedScore(row) {
  if (!row || !row.samples) return -1;
  const speed = Number.isFinite(row.tokensPerSec) ? row.tokensPerSec / 10 : 0;
  const ttft = Number.isFinite(row.ttftMs) ? 1 / (1 + row.ttftMs / 1000) : 0;
  return round1(speed + ttft);
}

/** Format for the UI. Returns a dash rather than 0 for an unmeasured value. */
export function formatMetric(value, { unit = '', digits = 0 } = {}) {
  if (!Number.isFinite(value)) return '—';
  const rounded = digits > 0 ? round1(value) : Math.round(value);
  return unit ? `${rounded}${unit}` : String(rounded);
}

export { makeId };

// --------------------------------------------------------------- internals

function mergeAverage(previous, value, samplesBefore) {
  if (!Number.isFinite(previous)) return value;
  if (samplesBefore <= 0) return value;
  return round1((previous * samplesBefore + value) / (samplesBefore + 1));
}

function minOrFirst(current, value) {
  return Number.isFinite(current) ? Math.min(current, value) : value;
}

function maxOrFirst(current, value) {
  return Number.isFinite(current) ? Math.max(current, value) : value;
}

function sum(a, b) {
  const values = [a, b].filter((v) => Number.isFinite(v));
  return values.length ? values.reduce((x, y) => x + y, 0) : null;
}

function round1(value) {
  return Math.round(value * 10) / 10;
}
