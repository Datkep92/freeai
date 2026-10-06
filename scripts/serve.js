#!/usr/bin/env node
/**
 * Static file server for the UI.
 *
 * Uses node:net rather than node:http on purpose: this project's Node runtime
 * has WebAssembly disabled, which makes undici - and therefore node:http and
 * fetch - crash on lazy load. node:net has no such dependency, so the server
 * runs everywhere while the browser still loads the ES modules normally.
 *
 * Usage: node scripts/serve.js [port]
 */
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const port = Number(process.argv[2] ?? 8788);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png',
};

const server = net.createServer((socket) => {
  let buffer = '';
  socket.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    const end = buffer.indexOf('\r\n\r\n');
    if (end === -1) return;

    const requestLine = buffer.slice(0, end).split('\r\n')[0] ?? '';
    const [method, rawPath] = requestLine.split(' ');
    buffer = '';

    let pathname = '/';
    try {
      pathname = decodeURIComponent(new URL(rawPath ?? '/', 'http://x').pathname);
    } catch {
      pathname = '/';
    }
    if (pathname.endsWith('/')) pathname += 'index.html';

    // Contain every request inside the project directory.
    const target = path.resolve(root, '.' + pathname);
    if (!target.startsWith(root)) {
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }

    fs.readFile(target, (error, data) => {
      if (error) {
        socket.end('HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n');
        return;
      }
      const type = MIME[path.extname(target)] ?? 'application/octet-stream';
      const headers = [
        'HTTP/1.1 200 OK',
        `Content-Type: ${type}`,
        `Content-Length: ${Buffer.byteLength(data)}`,
        'Cache-Control: no-cache',
        '',
        '',
      ].join('\r\n');
      socket.end(headers + (method === 'HEAD' ? '' : data.toString('utf8')));
    });
  });

  socket.on('error', () => {});
});

server.listen(port, () => {
  console.log(`Free Model Hub: http://localhost:${port}`);
});
