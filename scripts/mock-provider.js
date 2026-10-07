#!/usr/bin/env node
/**
 * A fake OpenAI-compatible provider, so the UI can be looked at for real
 * without a real key and without spending anyone's quota.
 *
 * Add `http://localhost:8799/v1` as a URL in the app and scan: the model list
 * below deliberately covers all four free levels, the two scripted refusals, and
 * a priced model that must never appear in the list.
 *
 * Uses node:net rather than node:http for the same reason scripts/serve.js does:
 * this project's Node runtime has WebAssembly disabled, which makes undici - and
 * therefore node:http and fetch - crash on lazy load.
 *
 * Keys it will accept, so every status can be seen on purpose:
 *   anything            -> works
 *   bad-*               -> 401 invalid key       (AUTH_INVALID)
 *   rate-*              -> 429 rate limit        (RATE_LIMITED)
 *   quota-*             -> 402 over quota        (QUOTA_EXHAUSTED)
 *
 * Models that always fail, whatever the key:
 *   model-nghen         -> 403 no access         (MODEL_DENIED)
 *   model-bien-mat      -> 404 not found         (MODEL_UNAVAILABLE)
 *
 * Usage: node scripts/mock-provider.js [port]
 */
import net from 'node:net';

const port = Number(process.argv[2] ?? 8799);

/** How far apart the streamed chunks are sent, so speed is measurable. */
const CHUNK_DELAY_MS = 25;

/**
 * The catalog. `pricing` is what the free detector reads, so these entries are
 * what make each level appear:
 *
 *   pricing 0/0            -> FREE_VERIFIED  (shown, "0đ")
 *   no pricing, name free  -> FREE_LIKELY    (shown, "0đ")
 *   no pricing, plain name -> FREE_UNKNOWN   (hidden behind "Chưa rõ giá")
 *   pricing > 0            -> PAID           (never listed)
 */
const MODELS = [
  { id: 'ngon-0d-v1', name: 'Ngon 0đ v1', pricing: { prompt: '0', completion: '0' }, context_length: 131072 },
  { id: 'ling-3.1-flash', name: 'inclusionAI: Ling 3.1 Flash', pricing: { prompt: '0', completion: '0' }, context_length: 262144 },
  { id: 'model-nghen', name: 'Model bị khoá quyền', pricing: { prompt: '0', completion: '0' } },
  { id: 'model-bien-mat', name: 'Model không tồn tại', pricing: { prompt: '0', completion: '0' } },

  { id: 'space-bunny-free', name: 'Space Bunny (free)' },
  { id: 'deepseek-v3:free', name: 'DeepSeek V3 bản free' },

  { id: 'bi-an-1', name: 'Bí Ẩn 1' },
  { id: 'provider-x-preview', name: 'Provider X preview' },

  { id: 'cao-cap-pro', name: 'Cao Cấp Pro', pricing: { prompt: '0.000003', completion: '0.000012' } },
];

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

const STATUS_TEXT = { 200: 'OK', 204: 'No Content', 400: 'Bad Request', 401: 'Unauthorized', 402: 'Payment Required', 403: 'Forbidden', 404: 'Not Found', 429: 'Too Many Requests' };

/** A token never goes to the terminal whole, not even a fake one. */
function mask(token) {
  const value = String(token ?? '');
  if (value.length <= 10) return value ? '…' : '(không có)';
  return `${value.slice(0, 5)}…${value.slice(-4)}`;
}

function send(socket, status, headers, body = '') {
  const payload = Buffer.from(body);
  const head = [
    `HTTP/1.1 ${status} ${STATUS_TEXT[status] ?? 'OK'}`,
    ...Object.entries({ ...CORS, ...headers }).map(([name, value]) => `${name}: ${value}`),
    `Content-Length: ${payload.length}`,
    'Connection: close',
    '',
    '',
  ].join('\r\n');
  socket.end(Buffer.concat([Buffer.from(head), payload]));
}

function sendJson(socket, status, body) {
  send(socket, status, { 'Content-Type': 'application/json; charset=utf-8' }, JSON.stringify(body));
}

/** A refusal in the shape every provider uses, so the classifier reads it. */
function fail(socket, status, message, code) {
  sendJson(socket, status, { error: { message, type: 'invalid_request_error', code } });
}

/**
 * One SSE answer, written in pieces with a delay between them.
 *
 * The delay is the point: time-to-first-token and tokens per second are observed
 * from the stream and cannot be invented, so a mock that answered in one write
 * would leave every speed on screen reading "chưa đo".
 */
function streamAnswer(socket, model, content) {
  socket.write(
    [
      'HTTP/1.1 200 OK',
      ...Object.entries({ ...CORS, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' }).map(
        ([name, value]) => `${name}: ${value}`
      ),
      'Transfer-Encoding: chunked',
      'Connection: close',
      '',
      '',
    ].join('\r\n')
  );

  const pieces = String(content).match(/.{1,8}/gs) ?? [''];
  const frames = pieces.map((piece, index) =>
    'data: ' +
    JSON.stringify({
      model,
      choices: [{ index: 0, delta: { content: piece } }],
      ...(index === pieces.length - 1
        ? { usage: { prompt_tokens: 12, completion_tokens: pieces.length, total_tokens: 12 + pieces.length } }
        : {}),
    }) +
    '\n\n'
  );
  frames.push('data: [DONE]\n\n');

  let index = 0;
  let closed = false;
  socket.on('close', () => {
    closed = true;
  });

  const writeNext = () => {
    if (closed) return;
    if (index >= frames.length) {
      socket.end('0\r\n\r\n');
      return;
    }
    const piece = Buffer.from(frames[index++]);
    socket.write(Buffer.concat([Buffer.from(piece.length.toString(16) + '\r\n'), piece, Buffer.from('\r\n')]));
    setTimeout(writeNext, CHUNK_DELAY_MS);
  };
  writeNext();
}

/** The help page, because a URL that answers nothing is a URL nobody trusts. */
function homePage() {
  const list = MODELS.map((m) => `<li><code>${m.id}</code> — ${m.name}</li>`).join('');
  return `<!doctype html><html lang="vi"><meta charset="utf-8">
<title>Mock provider</title>
<body style="font:15px/1.5 system-ui;max-width:44rem;margin:2rem auto;padding:0 1rem">
<h1>Mock provider đang chạy</h1>
<p>Thêm URL <code>http://localhost:${port}/v1</code> vào Free Model Hub rồi bấm quét.</p>
<h2>Model</h2><ul>${list}</ul>
<h2>Key để xem từng trạng thái</h2>
<ul>
<li><code>bat-ky-gi</code> — chạy được (khỏe)</li>
<li><code>bad-123</code> — 401 key sai</li>
<li><code>rate-123</code> — 429 quá nhiều request</li>
<li><code>quota-123</code> — 402 hết quota</li>
</ul>
<p>Model <code>model-nghen</code> luôn bị từ chối quyền, <code>model-bien-mat</code> luôn không tồn tại.</p>
</body></html>`;
}

function route(socket, { method, pathname, headers, body }) {
  if (method === 'OPTIONS') {
    send(socket, 204, {});
    return;
  }

  if (method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
    send(socket, 200, { 'Content-Type': 'text/html; charset=utf-8' }, homePage());
    return;
  }

  if (method === 'GET' && pathname === '/v1/models') {
    // Discovery costs nothing and needs no key, exactly like the real thing.
    console.log(`models: ${MODELS.length} model`);
    sendJson(socket, 200, { object: 'list', data: MODELS });
    return;
  }

  if (method === 'POST' && pathname === '/v1/chat/completions') {
    let payload = {};
    try {
      payload = JSON.parse(body || '{}');
    } catch {
      fail(socket, 400, 'Body is not JSON', 'invalid_request');
      return;
    }

    const model = String(payload.model ?? '');
    const auth = String(headers.authorization ?? '');
    const token = auth.replace(/^Bearer\s+/i, '').trim();
    console.log(`chat: ${model || '(thiếu model)'} bằng ${mask(token)}`);

    if (!token) {
      fail(socket, 401, 'Missing API key', 'invalid_api_key');
      return;
    }
    if (token.startsWith('bad')) {
      fail(socket, 401, 'Invalid API key provided', 'invalid_api_key');
      return;
    }
    if (token.startsWith('quota')) {
      fail(socket, 402, 'You exceeded your current quota', 'insufficient_quota');
      return;
    }
    if (token.startsWith('rate')) {
      fail(socket, 429, 'Rate limit reached, please try again in 20s', 'rate_limit_exceeded');
      return;
    }
    if (model === 'model-nghen') {
      fail(socket, 403, `You do not have access to the model ${model}`, 'model_access_denied');
      return;
    }
    if (model === 'model-bien-mat') {
      fail(socket, 404, `The model ${model} does not exist`, 'model_not_found');
      return;
    }

    const content = 'Xin chào, tôi là model giả lập.';
    if (payload.stream === true) {
      streamAnswer(socket, model, content);
      return;
    }
    sendJson(socket, 200, {
      id: 'chatcmpl-mock',
      object: 'chat.completion',
      model,
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 12, completion_tokens: 9, total_tokens: 21 },
    });
    return;
  }

  fail(socket, 404, `No route for ${pathname}`, 'not_found');
}

const server = net.createServer((socket) => {
  let buffer = Buffer.alloc(0);
  let handled = false;

  const onData = (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    const headerEnd = buffer.indexOf('\r\n\r\n');
    if (headerEnd === -1) return;

    const head = buffer.slice(0, headerEnd).toString('utf8');
    const [requestLine, ...headerLines] = head.split('\r\n');
    const [method, rawPath] = requestLine.split(' ');

    const headers = {};
    for (const line of headerLines) {
      const at = line.indexOf(':');
      if (at === -1) continue;
      headers[line.slice(0, at).trim().toLowerCase()] = line.slice(at + 1).trim();
    }

    // A POST body can arrive in a later packet than its headers, so the request
    // is only routed once everything Content-Length promised is here.
    const length = Number(headers['content-length'] ?? 0);
    if (buffer.length - (headerEnd + 4) < length) return;
    if (handled) return;
    handled = true;
    socket.off('data', onData);

    const body = buffer.slice(headerEnd + 4, headerEnd + 4 + length).toString('utf8');
    let pathname = '/';
    try {
      pathname = new URL(rawPath ?? '/', 'http://localhost').pathname;
    } catch {
      pathname = '/';
    }

    try {
      route(socket, { method, pathname, headers, body });
    } catch (error) {
      console.log('lỗi khi trả lời:', error?.message ?? error);
      try {
        fail(socket, 400, 'Mock provider failed', 'mock_error');
      } catch {
        socket.destroy();
      }
    }
  };

  socket.on('data', onData);
  socket.on('error', () => {});
});

server.listen(port, () => {
  console.log(`Mock provider: http://localhost:${port}/v1`);
  console.log(`Thêm URL đó vào app rồi bấm quét. Key bất kỳ, hoặc bad- / rate- / quota- để xem lỗi.`);
});
