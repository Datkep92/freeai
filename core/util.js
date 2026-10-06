/**
 * Small shared helpers. No business logic lives here.
 */

import { CONFIG } from './config.js';

/** RFC3339 timestamp. */
export function isoNow() {
  return new Date().toISOString();
}

export function nowMs() {
  return Date.now();
}

let idCounter = 0;

/** Short unique id. Not a secret, not globally unique. */
export function makeId(prefix = 'id') {
  idCounter = (idCounter + 1) % 100000;
  return `${prefix}_${Date.now().toString(36)}${idCounter.toString(36)}`;
}

export function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

/**
 * Mask a secret for display: oc_s…AlQY
 *
 * The UI shows this everywhere except the explicit reveal, so a leaked
 * screenshot is not a leaked credential.
 */
export function maskSecret(secret) {
  const value = String(secret ?? '');
  if (!value) return '';
  const { head, tail } = CONFIG.mask;
  if (value.length <= head + tail) return '•'.repeat(value.length);
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

/**
 * SHA-256 fingerprint of a secret.
 *
 * Used for duplicate detection and for remembering deletions without ever
 * storing the secret again. `globalThis.crypto` covers both the browser and
 * Node 18+, so no import shim is needed.
 */
export async function fingerprintSecret(secret) {
  const data = new TextEncoder().encode(String(secret ?? ''));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Remove secrets from text before it is logged, exported or shown in an error.
 *
 * Providers happily echo the Authorization header back in error payloads. Any
 * string we pass through here must never contain the secret itself.
 */
export function sanitizeError(text, secrets = []) {
  let out = String(text ?? '');

  // Every form the same key can arrive in is checked, not just the exact
  // string. A paste routinely carries a trailing newline or a leading space,
  // and the provider echoes the header it was sent - so matching only the exact
  // stored value missed the common case and leaked the key into the log, where
  // it is stored and shown forever.
  const forms = new Set();
  for (const raw of secrets) {
    if (typeof raw !== 'string') continue;
    const trimmed = raw.trim();
    // Short values are skipped on purpose: masking a 3-character string would
    // blank out ordinary words in the message.
    if (trimmed.length < 12) continue;
    forms.add(trimmed);
    // Also catch the secret with its whitespace still attached, and any
    // surrounding quote characters a JSON body would have added.
    forms.add(raw);
    forms.add(JSON.stringify(trimmed).slice(1, -1));
    forms.add(`Bearer ${trimmed}`);
    forms.add(`bearer ${trimmed}`);
  }

  for (const form of forms) {
    if (form.length < 12) continue;
    out = out.split(form).join('[secret]');
  }

  // Catch partial echoes of the same key: a provider that truncates the middle
  // still exposes enough to be dangerous if it is written down anywhere.
  for (const secret of secrets) {
    if (typeof secret !== 'string') continue;
    const trimmed = secret.trim();
    if (trimmed.length < 12) continue;
    out = out.replace(new RegExp(escapeRegExp(trimmed.slice(0, 8)), 'gi'), '[secret]');
    out = out.replace(new RegExp(escapeRegExp(trimmed.slice(-8)), 'gi'), '[secret]');
  }

  return out.slice(0, 300);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Run `worker` over `items` with at most `limit` in flight.
 *
 * Preserves result order and never opens more than `limit` sockets, which is
 * what keeps a 60-provider scan from tripping rate limits.
 */
export async function mapWithConcurrency(items, limit, worker, onProgress) {
  const list = Array.from(items);
  const results = new Array(list.length);
  if (!list.length) return results;

  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, list.length) }, async () => {
    while (cursor < list.length) {
      const index = cursor++;
      results[index] = await worker(list[index], index);
      onProgress?.(index + 1, list.length, list[index]);
    }
  });
  await Promise.all(runners);
  return results;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * fetch with a timeout that actually aborts the request.
 *
 * AbortController is the only reliable way to stop a hung gateway; without it
 * one dead host stalls the whole scan.
 */
export async function timedFetch(url, options = {}, timeoutMs = CONFIG.discoveryTimeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    return { response, latencyMs: Date.now() - startedAt, timedOut: false, error: null };
  } catch (error) {
    const timedOut = error?.name === 'AbortError';
    return {
      response: null,
      latencyMs: Date.now() - startedAt,
      timedOut,
      error: timedOut ? new Error('timeout') : error,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Parse JSON without throwing. */
export async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/** Normalise a base URL: trim, strip trailing slashes. */
export function normalizeBaseUrl(url) {
  return String(url ?? '').trim().replace(/\/+$/, '');
}
