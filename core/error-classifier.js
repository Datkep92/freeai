/**
 * Error classifier (plan 15, 16, 17).
 *
 * Decides which of the statuses a failed response is, using status code,
 * error.type, error.code, error.message and Retry-After together. Looking at
 * the HTTP status alone is not enough and causes real harm: a blanket 403 on
 * one model used to condemn an entire API key.
 */

import { STATUS } from './statuses.js';

const AUTH_PATTERNS = [
  /invalid[ _-]?api[ _-]?key/i,
  /incorrect api key/i,
  /unauthorized/i,
  /authentication/i,
  /no api key/i,
  /missing api key/i,
  /permission denied/i,
  /forbidden/i,
  /invalid[ _-]?token/i,
];

const MODEL_DENIED_PATTERNS = [
  /model .{0,40}not (?:allowed|permitted|authorized)/i,
  /not permitted to use (?:the )?model/i,
  /you do not have access to (?:the )?model/i,
  /model_access_denied/i,
  /model .{0,30}not available (?:to|for) (?:your|this)/i,
  /no access to model/i,
];

const MODEL_UNAVAILABLE_PATTERNS = [
  /model (?:not found|does not exist|no such model)/i,
  /unknown model/i,
  /invalid model/i,
  /model_not_found/i,
  /no such model/i,
  /model .{0,30}(?:unavailable|deprecated|retired)/i,
];

const QUOTA_PATTERNS = [
  /insufficient[ _-]?(?:quota|credit|balance|funds)/i,
  /quota (?:exceeded|exhausted)/i,
  /exceeded your current quota/i,
  /out of credits/i,
  /credit balance is too low/i,
  /billing|not enough balance/i,
];

const RATE_LIMIT_PATTERNS = [
  /rate[ _-]?limit/i,
  /too many requests/i,
  /slow down/i,
  /try again in/i,
];

const EXPIRED_PATTERNS = [
  /expired/i,
  /key has expired/i,
  /token expired/i,
  /credential.*expired/i,
];

const TEMP_PATTERNS = [
  /temporarily unavailable/i,
  /service unavailable/i,
  /internal server error/i,
  /bad gateway/i,
  /gateway timeout/i,
  /overloaded/i,
  /try again later/i,
];

function anyMatch(text, patterns) {
  return patterns.some((re) => re.test(text));
}

/** Pull a message and a machine code out of the many shapes providers use. */
function extract(payload) {
  if (!payload || typeof payload !== 'object') {
    return { message: String(payload ?? ''), code: null };
  }
  const error = payload.error ?? payload;
  const message =
    error?.message ?? error?.msg ?? error?.detail ?? payload.message ?? payload.detail ?? '';
  const code =
    error?.code ?? error?.type ?? payload.code ?? payload.type ?? error?.status ?? null;
  return { message: String(message ?? ''), code: code == null ? null : String(code) };
}

/** Retry-After may be seconds or an HTTP date. */
function parseRetryAfter(headers) {
  if (!headers?.get) return null;
  const raw = headers.get('Retry-After') ?? headers.get('retry-after');
  if (!raw) return null;

  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds > 0) return Math.min(seconds * 1000, 60 * 60 * 1000);

  const at = Date.parse(raw);
  if (Number.isFinite(at)) return Math.max(0, Math.min(at - Date.now(), 60 * 60 * 1000));
  return null;
}

/**
 * Classify one failed response.
 *
 * Returns { status, scope, httpStatus, code, message, retryAfterMs }.
 * `scope` decides how far the damage spreads: 'key' means the secret itself is
 * suspect, 'mapping' means only this model x key pair is affected.
 */
export function classifyError({ httpStatus, payload, headers } = {}) {
  const { message, code } = extract(payload);
  const haystack = `${message} ${code ?? ''}`;
  const retryAfterMs = parseRetryAfter(headers);
  const base = { httpStatus: httpStatus ?? null, code, message: message.slice(0, 300), retryAfterMs };

  // Order matters. Semantic body content beats the bare status code, because
  // providers reuse status codes for unrelated meanings.

  // 429 is ambiguous: a rate limit and an exhausted balance look identical
  // from the outside. Only the body tells them apart, so quota wins first.
  if (anyMatch(haystack, QUOTA_PATTERNS) || httpStatus === 402) {
    return { ...base, status: STATUS.QUOTA_EXHAUSTED, scope: 'key' };
  }

  if (anyMatch(haystack, MODEL_DENIED_PATTERNS)) {
    return { ...base, status: STATUS.MODEL_DENIED, scope: 'mapping' };
  }

  if (anyMatch(haystack, MODEL_UNAVAILABLE_PATTERNS)) {
    return { ...base, status: STATUS.MODEL_UNAVAILABLE, scope: 'mapping' };
  }

  // Some gateways answer a denied model with 403 plus a body that also says
  // "forbidden". The model pattern already ran above, so reaching here means
  // the model was not named: a 403 with no model hint is a credential
  // problem, which is exactly what the AUTH branch below concludes.


  if (anyMatch(haystack, EXPIRED_PATTERNS)) {
    return { ...base, status: STATUS.EXPIRED, scope: 'key' };
  }

  if (httpStatus === 429 || anyMatch(haystack, RATE_LIMIT_PATTERNS)) {
    return { ...base, status: STATUS.RATE_LIMITED, scope: 'mapping' };
  }

  // 403 alone does NOT mean the key is bad. Providers use it both for a
  // rejected credential and for "this key may not run that model". Blaming
  // the key on the bare code deletes secrets that still work, so a body that
  // names the model keeps the verdict on the mapping.
  if (
    httpStatus === 403 &&
    anyMatch(haystack, [...MODEL_DENIED_PATTERNS, ...MODEL_UNAVAILABLE_PATTERNS])
  ) {
    const denied = anyMatch(haystack, MODEL_DENIED_PATTERNS);
    return {
      ...base,
      status: denied ? STATUS.MODEL_DENIED : STATUS.MODEL_UNAVAILABLE,
      scope: 'mapping',
    };
  }

  if (httpStatus === 401 || (httpStatus === 403 && anyMatch(haystack, AUTH_PATTERNS))) {
    return { ...base, status: STATUS.AUTH_INVALID, scope: 'key' };
  }

  if (httpStatus >= 500 || anyMatch(haystack, TEMP_PATTERNS)) {
    return { ...base, status: STATUS.PROVIDER_DOWN, scope: 'provider' };
  }

  if (httpStatus >= 400) {
    return { ...base, status: STATUS.REQUEST_ERROR, scope: 'request' };
  }

  return { ...base, status: STATUS.UNKNOWN_ERROR, scope: 'request' };
}
