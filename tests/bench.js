/**
 * Free-detector benchmark.
 *
 * Scores the detector against the real OpenRouter catalog captured on
 * 2026-10. The catalog ships prices, so every row has a ground truth: a model
 * priced 0/0 is free and anything else is not. The detector must never call a
 * priced model free.
 *
 *   node --no-experimental-fetch tests/bench.js
 */
import fs from 'node:fs';
import { detectFree, FREE } from '../core/free-detector.js';

const CATALOG = new URL('./fixtures/openrouter-models.json', import.meta.url);
const hasFixture = fs.existsSync(CATALOG);

export function bench() {
  if (!hasFixture) {
    console.log('No fixture found at tests/fixtures/openrouter-models.json');
    console.log('Fetch it with:');
    console.log('  curl -s https://openrouter.ai/api/v1/models -o tests/fixtures/openrouter-models.json');
    return { total: 0, ok: 0 };
  }

  const models = JSON.parse(fs.readFileSync(CATALOG, 'utf8')).data ?? [];
  let ok = 0;
  let verified = 0;
  let paid = 0;
  const wrong = [];

  for (const raw of models) {
    const r = detectFree({
      modelId: raw.id,
      displayName: raw.name,
      pricing: raw.pricing,
      source: 'openrouter_pricing',
    });

    const free = Number(raw.pricing?.prompt) === 0 && Number(raw.pricing?.completion) === 0;
    const saidFree = r.freeStatus === FREE.FREE_VERIFIED;
    const saidPaid = r.freeStatus === FREE.PAID;

    if (saidFree) verified += 1;
    if (saidPaid) paid += 1;

    // The one rule that must never break: a priced model is never called free.
    if (!free && saidFree) {
      wrong.push(`${raw.id}: priced but called FREE`);
      continue;
    }
    if (free && !saidFree) {
      wrong.push(`${raw.id}: free but called ${r.freeStatus}`);
      continue;
    }
    ok += 1;
  }

  console.log(`\nFree detector benchmark`);
  console.log('='.repeat(52));
  console.log(`models     : ${models.length}`);
  console.log(`verified 0d: ${verified}`);
  console.log(`paid       : ${paid}`);
  console.log(`correct    : ${ok}/${models.length} (${((ok / models.length) * 100).toFixed(1)}%)`);
  console.log('='.repeat(52));

  if (wrong.length) {
    console.log('\nWrong:');
    for (const w of wrong) console.log('  ' + w);
  } else {
    console.log('\nKhông có mẫu sai.');
  }
  return { total: models.length, ok };
}

bench();
