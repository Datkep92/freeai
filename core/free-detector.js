/**
 * Free detector (plan 3, 4).
 *
 * Answers "is this model free?" from metadata, never from a test request.
 *
 * This module is the reason the app exists, so its conservatism is the point:
 * a false FREE_VERIFIED makes the router send real traffic to a paid model,
 * and a false PAID hides a free one the user came for. Both directions matter,
 * so the four levels are not a ranking but a statement of how much we know:
 *
 *   FREE_VERIFIED - a source with authority said the price is zero
 *   FREE_LIKELY   - the name says so, but nothing authoritative confirmed it
 *   FREE_UNKNOWN  - nothing to go on
 *   PAID          - a price greater than zero was found
 */

export const FREE = {
  FREE_VERIFIED: 'FREE_VERIFIED',
  FREE_LIKELY: 'FREE_LIKELY',
  FREE_UNKNOWN: 'FREE_UNKNOWN',
  PAID: 'PAID',
};

export const FREE_META = {
  [FREE.FREE_VERIFIED]: { emoji: '🟢', label: 'Miễn phí (xác minh)' },
  [FREE.FREE_LIKELY]: { emoji: '🟡', label: 'Nghi là miễn phí' },
  [FREE.FREE_UNKNOWN]: { emoji: '⚪', label: 'Chưa rõ giá' },
  [FREE.PAID]: { emoji: '⚫', label: 'Có phí' },
};

export function freeMeta(status) {
  return FREE_META[status] ?? FREE_META[FREE.FREE_UNKNOWN];
}

/**
 * Name hints, used only as supporting evidence.
 *
 * Measured against the live OpenRouter catalog: 20 models priced 0, of which 4
 * carry no "free" marker at all (inclusionai/ling-3.1-flash, openrouter/free,
 * two lyria previews). No priced model carried the word "free". So a name hint
 * never yields a wrong VERIFIED, it only ever misses some free models - which
 * is the safe direction to fail in.
 */
const FREE_NAME_PATTERN = /(^|[:\s\-_/])(free|gratis|no-?cost)([:\s\-_/]|$)|:free$|-free$|\bfree\b/i;

/** Read a number out of a pricing field that may be a number, string or absent. */
function readPrice(value) {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * Decide the free status of one model.
 *
 * `pricing` is whatever the adapter extracted: { input, output } with numbers,
 * or null when the provider publishes no pricing at all.
 * Returns { freeStatus, inputPrice, outputPrice, evidence }.
 */
export function detectFree({ modelId = '', displayName = '', pricing = null, source = null } = {}) {
  const evidence = [];
  const name = String(displayName || modelId || '');
  const nameHint = FREE_NAME_PATTERN.test(name);

  // --- 1. Authoritative pricing -------------------------------------------------
  // This is the only thing that can produce FREE_VERIFIED. A price of exactly
  // zero from the provider's own catalog means the provider will not bill.
  if (pricing) {
    // Providers disagree on field names. OpenRouter ships prompt/completion,
    // most OpenAI-compatible gateways ship input/output. Reading only one
    // spelling silently turns every free model into FREE_UNKNOWN, so accept
    // both and treat them as the same two numbers.
    const input = readPrice(pricing.input ?? pricing.prompt ?? pricing.input_price);
    const output = readPrice(pricing.output ?? pricing.completion ?? pricing.output_price);
    const hasBoth = input !== null && output !== null;

    if (hasBoth && input === 0 && output === 0) {
      evidence.push({ source: source ?? 'provider_pricing', field: 'prompt', value: '0' });
      evidence.push({ source: source ?? 'provider_pricing', field: 'completion', value: '0' });
      if (nameHint) evidence.push({ source: 'name_hint', value: 'contains "free"' });
      return {
        freeStatus: FREE.FREE_VERIFIED,
        inputPrice: 0,
        outputPrice: 0,
        evidence,
      };
    }

    if (input > 0 || output > 0) {
      evidence.push({ source: source ?? 'provider_pricing', field: 'input', value: String(input) });
      evidence.push({ source: source ?? 'provider_pricing', field: 'output', value: String(output) });
      return { freeStatus: FREE.PAID, inputPrice: input, outputPrice: output, evidence };
    }

    // Present but zero on one side only (some providers price output at 0 for
    // previews). Not enough to call it free.
    evidence.push({ source: source ?? 'provider_pricing', field: 'partial', value: JSON.stringify({ input, output }) });
    return {
      freeStatus: nameHint ? FREE.FREE_LIKELY : FREE.FREE_UNKNOWN,
      inputPrice: input,
      outputPrice: output,
      evidence,
    };
  }

  // --- 2. Name hint only ---------------------------------------------------------
  // No pricing published. The name is a hint, never proof: plan 4 forbids
  // promoting a model to FREE_VERIFIED on its name alone.
  if (nameHint) {
    evidence.push({ source: 'name_hint', value: name });
    return { freeStatus: FREE.FREE_LIKELY, inputPrice: null, outputPrice: null, evidence };
  }

  return { freeStatus: FREE.FREE_UNKNOWN, inputPrice: null, outputPrice: null, evidence };
}

/** Merge new evidence into an existing record without losing what we knew. */
export function mergeEvidence(existing = [], incoming = []) {
  const seen = new Set(existing.map((e) => `${e.source}:${e.field ?? ''}:${e.value}`));
  const merged = [...existing];
  for (const item of incoming) {
    const key = `${item.source}:${item.field ?? ''}:${item.value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(item);
  }
  return merged;
}

/**
 * The one definition of "0đ" the whole app agrees on.
 *
 * A model qualifies when the provider published a zero price (FREE_VERIFIED) or
 * its name says free (FREE_LIKELY). FREE_UNKNOWN is deliberately left out: the
 * user does not use paid models, and a model nobody priced is one the app
 * cannot promise costs nothing. Those rows are not discarded - they stay in
 * storage and stay reachable behind their own filter - they are simply never
 * presented as "what I can use for free".
 *
 * Kept here rather than in the UI so the list, the chips, every count that
 * reads "N model 0đ" and the router all answer the same question the same way.
 */
export function isFreeModel(model) {
  if (!model) return false;
  return model.freeStatus === FREE.FREE_VERIFIED || model.freeStatus === FREE.FREE_LIKELY;
}

/**
 * A model with nothing known about its price.
 *
 * A record written before `freeStatus` existed, or by a provider that published
 * no pricing at all, arrives with no value; treating that as "unknown" rather
 * than as "not unknown" is what keeps such a row findable behind the filter
 * instead of invisible under every chip.
 */
export function isUnknownPrice(model) {
  if (!model) return false;
  if (model.freeStatus === FREE.PAID) return false;
  return model.freeStatus == null || model.freeStatus === FREE.FREE_UNKNOWN;
}

/**
 * Order candidates for the first-success verifier (plan 12).
 *
 * Cheapest to try first, so the common case costs exactly one request.
 */
export function orderModelsForVerify(models, { limit = 5 } = {}) {
  return [...models]
    .sort((a, b) => {
      const rank = { [FREE.FREE_VERIFIED]: 0, [FREE.FREE_LIKELY]: 1, [FREE.FREE_UNKNOWN]: 2, [FREE.PAID]: 3 };
      const byFree = (rank[a.freeStatus] ?? 4) - (rank[b.freeStatus] ?? 4);
      if (byFree !== 0) return byFree;
      return String(a.modelId).localeCompare(String(b.modelId));
    })
    .slice(0, limit);
}

/** Models the verifier may spend a request on. Paid models are never probed. */
export function verifiableModels(models) {
  return models.filter((m) => m.freeStatus !== FREE.PAID);
}
