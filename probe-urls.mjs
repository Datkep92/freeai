#!/usr/bin/env node
/**
 * Live check for every built-in URL.
 *
 * Sends no API key, so the result is deliberately three-valued:
 *
 *   200 with a model count  - the catalog is public; models can be scanned now
 *   401/403                 - the endpoint is alive and wants a key. Not broken.
 *   anything else           - the entry needs fixing, and this says so
 *
 * The measured verdicts are recorded in builtin.js as `verified` so the app can
 * tell the user what is known to work instead of implying every entry is live.
 *
 * Usage: node probe-urls.mjs
 */
import { BUILTIN_LIST } from './core/adapters/builtin.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

async function probe(preset) {
  const url = preset.baseURL.replace(/\/+$/, '') + preset.modelsPath;
  try {
    const { stdout } = await run(
      'curl',
      ['-s', '-o', '/dev/null', '-w', '%{http_code}', '--max-time', '12', '-H', 'Accept: application/json', url],
      { timeout: 15000 }
    );
    const status = Number(String(stdout).trim());
    if (status === 200) return { id: preset.id, verdict: 'OPEN', status };
    if (status === 401 || status === 403) return { id: preset.id, verdict: 'NEEDS_KEY', status };
    return { id: preset.id, verdict: 'BROKEN', status };
  } catch (error) {
    return { id: preset.id, verdict: 'BROKEN', status: 'NETWORK', detail: error.shortMessage ?? error.message };
  }
}

const results = await Promise.all(BUILTIN_LIST.map(probe));

const groups = {
  OPEN: results.filter((r) => r.verdict === 'OPEN'),
  NEEDS_KEY: results.filter((r) => r.verdict === 'NEEDS_KEY'),
  BROKEN: results.filter((r) => r.verdict === 'BROKEN'),
};

for (const [name, list] of Object.entries(groups)) {
  console.log(`\n=== ${name} (${list.length}) ===`);
  for (const r of list) console.log(`  ${r.id.padEnd(20)} ${r.status} ${r.detail ?? ''}`);
}

console.log(`\ntotal: ${results.length}`);
process.exit(groups.BROKEN.length ? 1 : 0);
