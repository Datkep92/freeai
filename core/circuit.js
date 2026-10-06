/**
 * Circuit breaker (plan 21).
 *
 * CLOSED -> OPEN -> (cooldown elapsed) HALF_OPEN -> CLOSED or OPEN.
 *
 * Pure functions of state plus outcome, so the transition table can be tested
 * without any I/O and without timers.
 */

import { CONFIG } from './config.js';

const cfg = CONFIG.circuit;

export const CIRCUIT_STATE = {
  CLOSED: 'CLOSED',
  OPEN: 'OPEN',
  HALF_OPEN: 'HALF_OPEN',
};

export function initialBreaker() {
  return { state: CIRCUIT_STATE.CLOSED, failures: 0, windowStart: null, openedAt: null };
}

export function isProviderAvailable(breaker, { now = Date.now() } = {}) {
  if (!breaker) return true;
  if (breaker.state === CIRCUIT_STATE.OPEN) {
    if (breaker.openedAt && now - breaker.openedAt >= cfg.openMs) return true;
    return false;
  }
  return true;
}

export function recordProviderFailure(breaker, { now = Date.now() } = {}) {
  const state = breaker ?? initialBreaker();
  const withinWindow = state.windowStart !== null && now - state.windowStart <= cfg.windowMs;
  const failures = withinWindow ? state.failures + 1 : 1;
  const windowStart = withinWindow ? state.windowStart : now;

  if (failures >= cfg.failureThreshold) {
    return { state: CIRCUIT_STATE.OPEN, failures, windowStart, openedAt: now };
  }
  return { ...state, failures, windowStart };
}

export function recordProviderSuccess(breaker) {
  return initialBreaker();
}

export function refreshBreaker(breaker, { now = Date.now() } = {}) {
  if (breaker?.state === CIRCUIT_STATE.OPEN && breaker.openedAt && now - breaker.openedAt >= cfg.openMs) {
    return { ...breaker, state: CIRCUIT_STATE.HALF_OPEN };
  }
  return breaker ?? initialBreaker();
}
