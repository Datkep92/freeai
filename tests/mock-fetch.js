/**
 * Deterministic mock fetch. No real API calls in any test.
 *
 * Routes map a URL substring to a response descriptor or a handler.
 * Returns a minimal response object rather than the global Response so the
 * suite behaves the same with or without experimental fetch enabled.
 */

function makeHeaders(init = {}) {
  const map = new Map(Object.entries(init).map(([k, v]) => [k.toLowerCase(), String(v)]));
  return {
    get: (name) => map.get(String(name).toLowerCase()) ?? null,
    has: (name) => map.has(String(name).toLowerCase()),
    forEach: (fn) => map.forEach((v, k) => fn(k, v)),
  };
}

/**
 * Turn a chat payload into SSE chunks.
 *
 * Real providers stream this way and the measurement code depends on it, so a
 * mock that only returned one blob would leave time-to-first-token and
 * tokens/sec permanently unmeasured and the tests would pass for the wrong
 * reason.
 */
function toStreamChunks(body) {
  const text =
    typeof body === 'string' ? '' : (body?.choices?.[0]?.message?.content ?? body?.choices?.[0]?.text ?? '');
  const pieces = String(text).match(/.{1,8}/gs) ?? [];

  const chunks = pieces.map((piece, index) => ({
    model: body?.model ?? 'mock-model',
    choices: [{ index: 0, delta: { content: piece } }],
    // Usage on the last chunk is what OpenAI-compatible providers do.
    ...(index === pieces.length - 1 && body?.usage ? { usage: body.usage } : {}),
  }));

  return [...chunks.map((c) => 'data: ' + JSON.stringify(c) + '\n\n'), 'data: [DONE]\n\n'];
}

function makeResponse({ status = 200, body = {}, headers = {}, stream = false } = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: makeHeaders({ 'Content-Type': 'application/json', ...headers }),
    async text() {
      return text;
    },
    async json() {
      try {
        return JSON.parse(text);
      } catch {
        return null;
      }
    },
    // A minimal reader over the encoded chunks. Yields one Uint8Array per
    // chunk, which is what the stream-reading code consumes.
    ...(stream
      ? {
          body: {
            getReader() {
              let index = 0;
              const encoded = toStreamChunks(body).map((c) => new TextEncoder().encode(c));
              return {
                async read() {
                  if (index >= encoded.length) return { done: true, value: undefined };
                  return { done: false, value: encoded[index++] };
                },
                cancel() {},
              };
            },
          },
        }
      : {}),
  };
}

export function createMockFetch(routes = {}, { defaultRoute = null } = {}) {
  const calls = [];

  async function mockFetch(url, options = {}) {
    const href = String(url);
    const method = options.method ?? 'GET';
    calls.push({ url: href, method, options, body: options.body ?? null });

    const key = Object.keys(routes).find((pattern) => href.includes(pattern));
    const route = key ? routes[key] : defaultRoute;

    if (!route) {
      return makeResponse({ status: 404, body: { error: { message: 'no mock route' } } });
    }

    const result = typeof route === 'function' ? await route(href, options, calls.length) : route;
    if (result?.__throw) throw new Error(result.message ?? 'network failure');
    if (result?.__abort) {
      const error = new Error('The operation was aborted.');
      error.name = 'AbortError';
      throw error;
    }

    // A request that asked for a stream gets one, unless the route forced
    // stream:false to simulate a provider that refuses it.
    let wantsStream = false;
    try {
      wantsStream = JSON.parse(options.body ?? '{}').stream === true;
    } catch {
      wantsStream = false;
    }
    const forced = typeof route === 'function' ? undefined : route?.stream;
    return makeResponse({ ...result, stream: forced ?? wantsStream });
  }

  mockFetch.calls = calls;
  mockFetch.routes = routes;
  mockFetch.reset = () => {
    calls.length = 0;
  };
  mockFetch.countBy = (fragment) =>
    calls.filter((c) => c.url.includes(fragment)).length;
  return mockFetch;
}

export { makeResponse };
