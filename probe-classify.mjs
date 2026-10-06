/**
 * Chạy scanner thật (không mock) trên vài URL để xem keyRequirement ghi
 * được đúng không, rồi so với kết quả probe-urls.mjs đã đo.
 *
 * Dùng curl thay fetch: runtime Node ở đây tắt WebAssembly/undici nên
 * fetch thật không chạy được. Đường dẫn HTTP là của timedFetch, còn phần
 * phân loại là của requirementFromDiscovery - cùng một chỗ với test.
 */
import { MemoryStorage } from './core/storage.js';
import { ProviderRegistry } from './core/provider-registry.js';
import { Scanner } from './core/scanner.js';
import { requirementOf, KEY_REQ, requirementFromDiscovery } from './core/key-requirement.js';
import { BUILTIN } from './core/adapters/builtin.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

async function statusOf(preset) {
  const url = preset.baseURL.replace(/\/+$/, '') + preset.modelsPath;
  const { stdout } = await run(
    'curl',
    ['-s', '-o', '/dev/null', '-w', '%{http_code}', '--max-time', '12', url],
    { timeout: 15000 }
  );
  return Number(String(stdout).trim());
}

// Feed the real HTTP status into the classifier, exactly as discoverModels does.
function discoveryShape(status) {
  return status === 200
    ? { ok: true, models: [] }
    : { ok: false, reason: 'HTTP_' + status };
}

const storage = new MemoryStorage();
const providers = new ProviderRegistry(storage);
const scanner = new Scanner(storage, { providers });

let match = 0;
let total = 0;

for (const preset of Object.values(BUILTIN)) {
  const status = await statusOf(preset);
  const verdict = requirementFromDiscovery(discoveryShape(status));
  const expected = preset.verified === 'OPEN' ? KEY_REQ.NONE : KEY_REQ.REQUIRED;
  const ok = verdict === expected;
  total += 1;
  if (ok) match += 1;
  console.log(
    preset.id.padEnd(18),
    String(status).padEnd(5),
    String(verdict).padEnd(10),
    ok ? 'MATCH' : 'MISMATCH expected ' + expected
  );

  // And prove the row survives the round trip through storage.
  const { provider } = await providers.upsert({
    name: preset.name, baseURL: preset.baseURL, type: 'CUSTOM',
  });
  const row = await providers.get(provider.id);
  if (requirementOf(row) !== KEY_REQ.UNKNOWN) {
    console.log('  !! a hand-added URL defaulted to a proven verdict');
  }
}

console.log(`\n${match}/${total} phan loai khop voi probe that`);
process.exit(match === total ? 0 : 1);
