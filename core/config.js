/**
 * Central configuration.
 *
 * Every threshold and tunable lives here so changing policy is a one-file
 * edit. No magic numbers are allowed to leak into the modules themselves.
 */

export const CONFIG = {
  // ---- Network ----
  discoveryTimeoutMs: 12000,
  probeTimeoutMs: 15000,

  // Providers are independent hosts, so waiting for one dead gateway to time
  // out would serialise the whole scan behind the slowest one. This only caps
  // how many sockets we open at once.
  scanConcurrency: 4,
  probeConcurrency: 3,

  // ---- Probe shape ----
  // "Reply exactly: OK" is the smallest request that still proves inference
  // works. Anything larger burns quota for no extra information.
  probe: {
    message: 'Reply exactly: OK',
    maxTokens: 5,
  },

  // ---- Metrics (plan 31) ----
  // A probe has to be big enough to produce several tokens, otherwise speed
  // cannot be measured at all: five tokens finishes before the first token has
  // really landed, and tokens/sec comes out meaningless. This is still far
  // below anything a user would notice on a quota.
  metrics: {
    // Tokens asked for when the only goal is to measure speed. Above the probe
    // size, below anything that would waste a real request.
    measureTokens: 24,
    // A model measured fewer times than this is still "chưa đủ dữ liệu" in the
    // UI, so one lucky request does not make it look measured.
    minSamplesForDisplay: 2,
    // Samples kept per model before the average stops being informative.
    maxSamples: 50,
  },

  // ---- Cache (plan 9) ----
  // Opening the UI must not re-scan the world. Cached rows render instantly
  // and a stale refresh runs in the background.
  cache: {
    scanTtlMs: 6 * 60 * 60 * 1000,
    freeTtlMs: 6 * 60 * 60 * 1000,
  },

  // ---- Key masking (plan 10) ----
  mask: {
    head: 4,
    tail: 4,
  },

  // ---- First-success verification (plan 12) ----
  // Cap on how many models one key may try. The whole point is to stop at the
  // first pass; this only bounds a pathological all-fail case.
  verifyMaxModels: 5,

  // ---- Scoring / cooldown (plan 20) ----
  score: {
    base: 50,
    freeBonus: 30,
    healthyBonus: 20,
    cooldownPenalty: 40,
    latencyPenaltyPerMs: 0.02,
    latencyPenaltyMax: 20,
    failurePenaltyPerCount: 12,
    failurePenaltyMax: 40,
  },
  cooldown: {
    rateLimitBaseMs: 30 * 1000,
    rateLimitMaxMs: 15 * 60 * 1000,
    tempErrorBaseMs: 5 * 1000,
    tempErrorMaxMs: 60 * 1000,
    retryAfterCapMs: 60 * 60 * 1000,
  },

  // ---- Circuit breaker (plan 21) ----
  circuit: {
    failureThreshold: 5,
    windowMs: 60 * 1000,
    openMs: 120 * 1000,
  },

  // ---- Event log retention ----
  eventLogLimit: 300,
};

export const CONFIG_PATH = 'core/config.js';
