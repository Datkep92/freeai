/**
 * Health, score and cooldown (plan 19, 20).
 *
 * Deterministic - no randomness, no ML. The same inputs always produce the
 * same score, which is what makes the ranking testable.
 */

import { CONFIG } from './config.js';
import { STATUS } from './statuses.js';
import { clamp, isoNow } from './util.js';

const scoreCfg = CONFIG.score;
const cdCfg = CONFIG.cooldown;

/**
 * Ranking score. Free models rank above paid ones, which is the whole point of
 * the app: the default route must prefer what costs nothing.
 */
export function computeScore(mapping, { now = Date.now() } = {}) {
  if (!mapping) return 0;
  let score = scoreCfg.base;

  if (mapping.status === STATUS.HEALTHY) score += scoreCfg.healthyBonus;
  if (mapping.freeStatus === 'FREE_VERIFIED') score += scoreCfg.freeBonus;
  else if (mapping.freeStatus === 'FREE_LIKELY') score += scoreCfg.freeBonus / 2;

  if (mapping.cooldownUntil && mapping.cooldownUntil > now) score -= scoreCfg.cooldownPenalty;

  if (Number.isFinite(mapping.latencyMs)) {
    score -= clamp(
      mapping.latencyMs * scoreCfg.latencyPenaltyPerMs,
      0,
      scoreCfg.latencyPenaltyMax
    );
  }

  score -= clamp(
    (mapping.failureCount ?? 0) * scoreCfg.failurePenaltyPerCount,
    0,
    scoreCfg.failurePenaltyMax
  );

  return Math.round(score);
}

/** Retry-After wins; otherwise bounded exponential backoff. Never infinite. */
export function computeCooldown(status, { retryAfterMs = null, failureCount = 0 } = {}) {
  if (status === STATUS.RATE_LIMITED) {
    if (Number.isFinite(retryAfterMs) && retryAfterMs > 0) {
      return Math.min(retryAfterMs, cdCfg.retryAfterCapMs);
    }
    const backoff = cdCfg.rateLimitBaseMs * 2 ** Math.min(failureCount, 10);
    return Math.min(backoff, cdCfg.rateLimitMaxMs);
  }
  if (status === STATUS.TEMP_ERROR) {
    const backoff = cdCfg.tempErrorBaseMs * 2 ** Math.min(failureCount, 10);
    return Math.min(backoff, cdCfg.tempErrorMaxMs);
  }
  return 0;
}

/** The single place a probe result becomes stored state. */
export function applyResult(mapping, result, { now = Date.now() } = {}) {
  const ok = Boolean(result?.ok);
  const status = ok ? STATUS.HEALTHY : (result?.status ?? STATUS.UNKNOWN_ERROR);

  if (ok) {
    const next = {
      ...mapping,
      status,
      verified: true,
      failureCount: 0,
      cooldownUntil: null,
      latencyMs: result.latencyMs ?? mapping.latencyMs,
      lastTestAt: isoNow(),
      lastSuccessAt: isoNow(),
      lastErrorClass: null,
      lastErrorMessage: null,
      updatedAt: isoNow(),
    };
    return { ...next, score: computeScore(next, { now }) };
  }

  const failureCount = (mapping.failureCount ?? 0) + 1;
  const cooldownMs = computeCooldown(status, {
    retryAfterMs: result?.retryAfterMs ?? null,
    failureCount,
  });

  const next = {
    ...mapping,
    status,
    verified: false,
    failureCount,
    cooldownUntil: cooldownMs > 0 ? now + cooldownMs : null,
    latencyMs: result?.latencyMs ?? mapping.latencyMs,
    lastTestAt: isoNow(),
    lastFailureAt: isoNow(),
    lastErrorClass: status,
    lastErrorMessage: result?.error ?? null,
    updatedAt: isoNow(),
  };
  return { ...next, score: computeScore(next, { now }) };
}
