/**
 * Adapter interface (plan 28).
 *
 * Every provider - built-in or custom - exposes the same six operations, so
 * the scanner, verifier and router never special-case a provider name.
 *
 *   discoverModels()  -> list models (no inference, no tokens)
 *   normalizeModel()   -> turn a raw entry into { modelId, displayName, pricing }
 *   detectFree()       -> free status + evidence
 *   probeKey()         -> one minimal inference request
 *   buildChatRequest() -> production-shaped chat payload
 *   classifyError()    -> map a failure to a status
 *
 * The generic OpenAI-compatible adapter covers the majority. Built-ins
 * override only what genuinely differs - so far, only pricing extraction.
 */

import { CONFIG } from '../config.js';
import { readJson, timedFetch } from '../util.js';
import { measure } from '../metrics.js';
import { classifyError } from '../error-classifier.js';
import { detectFree } from '../free-detector.js';

/**
 * Pull pricing out of the many shapes providers use.
 * Returns null when the provider publishes no pricing at all, which is the
 * signal the detector needs to fall back to weaker evidence.
 */
export function extractPricing(raw) {
  if (!raw || typeof raw !== 'object') return null;

  const p = raw.pricing ?? raw.price ?? raw.cost ?? raw.prices ?? null;
  if (!p || typeof p !== 'object') return null;

  const pick = (...names) => {
    for (const name of names) {
      const value = p[name];
      if (value === 0) return 0;
      if (typeof value === 'number' && Number.isFinite(value)) return value;
      if (typeof value === 'string') {
        const n = Number(value);
        if (Number.isFinite(n)) return n;
      }
      // Nested { input: { price: 0 } } shapes.
      if (value && typeof value === 'object') {
        const nested = Number(value.price ?? value.amount ?? value.value);
        if (Number.isFinite(nested)) return nested;
      }
    }
    return null;
  };

  const input = pick('prompt', 'input', 'input_price', 'inputPrice', 'prompt_price', 'request');
  const output = pick('completion', 'output', 'output_price', 'outputPrice', 'completion_price', 'response');

  if (input === null && output === null) return null;
  return { input, output };
}

export class BaseAdapter {
  constructor(config = {}) {
    this.type = config.type ?? 'CUSTOM';
    this.baseURL = config.baseURL;
    this.protocol = config.protocol ?? 'openai-compatible';
    this.modelsPath = config.modelsPath ?? '/models';
    this.chatPath = config.chatPath ?? '/chat/completions';
  }

  modelsUrl() {
    return `${String(this.baseURL).replace(/\/+$/, '')}${this.modelsPath}`;
  }

  chatUrl() {
    return `${String(this.baseURL).replace(/\/+$/, '')}${this.chatPath}`;
  }

  buildAuthHeaders(secret) {
    if (!secret) return { 'Content-Type': 'application/json' };
    return { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' };
  }

  /** The smallest request that still proves inference works. */
  buildChatRequest({ model, message = CONFIG.probe.message, maxTokens = CONFIG.probe.maxTokens }) {
    return {
      method: 'POST',
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: message }],
        max_tokens: maxTokens,
      }),
    };
  }

  /** Turn one raw /models entry into the shape the registry stores. */
  normalizeModel(raw) {
    const modelId =
      typeof raw === 'string' ? raw : (raw?.id ?? raw?.name ?? raw?.model ?? raw?.slug ?? null);
    if (!modelId) return null;
    return {
      modelId: String(modelId),
      displayName: raw?.name ?? raw?.display_name ?? String(modelId),
      pricing: extractPricing(raw),
      metadata: raw && typeof raw === 'object' ? raw : {},
    };
  }

  detectFree(model) {
    return detectFree({
      modelId: model.modelId,
      displayName: model.displayName,
      pricing: model.pricing,
      source: 'provider_pricing',
    });
  }

  /**
   * Fetch the model list. Discovery only: no inference, so a large provider
   * costs no tokens.
   */
  async discoverModels({ secret = null, timeoutMs = CONFIG.discoveryTimeoutMs } = {}) {
    const { response, latencyMs, timedOut, error } = await timedFetch(
      this.modelsUrl(),
      { headers: this.buildAuthHeaders(secret) },
      timeoutMs
    );

    if (timedOut) {
      return { ok: false, reason: 'TIMEOUT', models: [], latencyMs, error: 'timeout' };
    }
    if (error) {
      return { ok: false, reason: 'NETWORK', models: [], latencyMs, error: error.message };
    }
    if (!response.ok) {
      const payload = await readJson(response);
      const classified = classifyError({ httpStatus: response.status, payload, headers: response.headers });
      return {
        ok: false,
        reason: 'HTTP_' + response.status,
        models: [],
        latencyMs,
        error: classified.message || 'HTTP ' + response.status,
        classification: classified,
      };
    }

    const payload = await readJson(response);
    const rows = Array.isArray(payload) ? payload : (payload?.data ?? payload?.models ?? []);

    if (!Array.isArray(rows)) {
      return {
        ok: false,
        reason: 'BAD_SHAPE',
        models: [],
        latencyMs,
        error: 'response is not a model list',
      };
    }

    const models = [];
    for (const raw of rows) {
      const model = this.normalizeModel(raw);
      if (model) models.push(model);
    }
    return { ok: true, models, latencyMs };
  }

  /**
   * One minimal inference call. This is the only place tokens are spent, and
   * only for a candidate the user actually asked to verify.
   */
  async probeKey({ model, secret, timeoutMs = CONFIG.probeTimeoutMs } = {}) {
    const request = this.buildChatRequest({ model });
    const { response, latencyMs, timedOut, error } = await timedFetch(
      this.chatUrl(),
      { method: request.method, headers: this.buildAuthHeaders(secret), body: request.body },
      timeoutMs
    );

    if (timedOut) {
      return { ok: false, status: 'TEMP_ERROR', httpStatus: null, latencyMs, error: 'timeout' };
    }
    if (error) {
      return { ok: false, status: 'TEMP_ERROR', httpStatus: null, latencyMs, error: error.message };
    }

    if (response.ok) {
      const payload = await readJson(response);
      const content =
        payload?.choices?.[0]?.message?.content ?? payload?.choices?.[0]?.text ?? null;
      // The payload is returned so token counts can be read from it without a
      // second request.
      return { ok: true, status: 'HEALTHY', httpStatus: response.status, latencyMs, content, payload };
    }

    const payload = await readJson(response);
    const classified = classifyError({
      httpStatus: response.status,
      payload,
      headers: response.headers,
    });
    return {
      ok: false,
      status: classified.status,
      scope: classified.scope,
      httpStatus: response.status,
      latencyMs,
      error: classified.message,
      retryAfterMs: classified.retryAfterMs,
    };
  }

  classifyError(args) {
    return classifyError(args);
  }

  /**
   * One measured request.
   *
   * Runs with stream:true and timestamps the first chunk, because no provider
   * reports time-to-first-token: it has to be observed. The stream is read to
   * completion so the token counts at the end are real rather than missing.
   *
   * Falls back to a plain request when the provider rejects streaming. A
   * gateway that cannot stream still gets measured - it just reports no
   * time-to-first-token, because a number invented from a non-streaming call
   * would be worse than no number at all.
   */
  async probeWithMetrics({
    model,
    secret,
    timeoutMs = CONFIG.probeTimeoutMs,
    maxTokens = CONFIG.metrics.measureTokens,
  } = {}) {
    const streaming = await this.probeStreaming({ model, secret, timeoutMs, maxTokens });

    if (streaming.ok) {
      const metrics = measure({
        payload: streaming.payload,
        totalMs: streaming.totalMs,
        ttftMs: streaming.ttftMs,
      });
      return { ...streaming, metrics };
    }

    // Only a genuine "streaming not supported" gets a second, plain request.
    // A 403 or a 401 already answered the real question - the key or the model
    // is refused - and retrying without stream:true would spend a request to
    // learn the same thing again.
    if (!streaming.unsupported) return streaming;

    // A provider that does not support stream:true still gets a plain probe,
    // and the total duration is recorded even though ttft stays null.
    const plain = await this.probeKey({ model, secret, timeoutMs });
    if (!plain.ok) return plain;

    const metrics = measure({ payload: plain.payload, totalMs: plain.latencyMs, ttftMs: null });
    return { ...plain, metrics };
  }

  /** One streamed request, returning the payload plus both timings. */
  async probeStreaming({ model, secret, timeoutMs = CONFIG.probeTimeoutMs, maxTokens } = {}) {
    const request = this.buildChatRequest({ model, maxTokens });
    const body = JSON.parse(request.body);
    body.stream = true;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const startedAt = Date.now();

    try {
      const response = await fetch(this.chatUrl(), {
        method: 'POST',
        headers: this.buildAuthHeaders(secret),
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const payload = await readJson(response);
        const classified = classifyError({
          httpStatus: response.status,
          payload,
          headers: response.headers,
        });
        return {
          ok: false,
          status: classified.status,
          scope: classified.scope,
          httpStatus: response.status,
          latencyMs: Date.now() - startedAt,
          error: classified.message,
          retryAfterMs: classified.retryAfterMs,
          unsupported: isStreamUnsupported(classified),
        };
      }

      // The timestamp is taken when the first chunk carrying actual content
      // arrives. Headers alone arrive early and would understate every model.
      const { payload, ttftMs } = await readStream(response, startedAt);
      return {
        ok: true,
        status: 'HEALTHY',
        httpStatus: response.status,
        latencyMs: Date.now() - startedAt,
        totalMs: Date.now() - startedAt,
        ttftMs,
        payload,
        content: payload?.choices?.[0]?.message?.content ?? null,
      };
    } catch (error) {
      const timedOut = error?.name === 'AbortError';
      return {
        ok: false,
        status: 'TEMP_ERROR',
        httpStatus: null,
        latencyMs: Date.now() - startedAt,
        error: timedOut ? 'timeout' : error.message,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Read an SSE stream, reassembling it into one payload.
 *
 * A stream is a sequence of `data: {...}` lines. The chunks are merged into
 * the shape a normal response would have, so readUsage() works unchanged. The
 * final usage object may arrive on its own chunk or inside the last one, so it
 * is kept whenever it appears.
 */
async function readStream(response, startedAt) {
  const reader = response.body?.getReader?.();
  if (!reader) return { payload: null, ttftMs: null };

  const decoder = new TextDecoder();
  let buffer = '';
  let ttftMs = null;
  let content = '';
  let usage = null;
  let modelId = null;

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const data = trimmed.slice(5).trim();
      if (!data || data === '[DONE]') continue;

      let chunk;
      try {
        chunk = JSON.parse(data);
      } catch {
        continue;
      }

      // Usage can arrive on any chunk, and on some providers only on the last.
      if (chunk.usage) usage = chunk.usage;
      if (chunk.model) modelId = chunk.model;

      const delta =
        chunk?.choices?.[0]?.delta?.content ??
        chunk?.choices?.[0]?.text ??
        chunk?.candidates?.[0]?.content?.parts?.[0]?.text ??
        '';
      if (!delta) continue;

      // First content byte is the moment "time to first token" refers to.
      if (ttftMs === null) ttftMs = Date.now() - startedAt;
      content += delta;
    }
  }

  const payload = {
    model: modelId,
    choices: [{ message: { role: 'assistant', content } }],
    usage,
  };
  return { payload, ttftMs };
}

/**
 * Did the provider refuse because of streaming, or for an unrelated reason?
 *
 * The distinction is what keeps the verifier honest. A model-denied 403 that
 * happens to mention streaming in its message must NOT trigger a retry: the
 * answer is already "no", and a second request only costs quota. So this is
 * deliberately strict - an explicit complaint about streaming, and nothing else.
 */
function isStreamUnsupported(classified) {
  const message = String(classified?.message ?? '').toLowerCase();
  const explicit =
    message.includes('stream') ||
    message.includes('not supported') ||
    message.includes('unsupported');
  // An auth or permission refusal is a final answer, never a streaming problem.
  const refused =
    classified?.status === 'AUTH_INVALID' ||
    classified?.status === 'MODEL_DENIED' ||
    classified?.status === 'EXPIRED';
  if (refused) return false;
  return explicit && classified?.httpStatus === 400;
}
