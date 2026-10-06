/**
 * Built-in provider adapters (plan 1, 29).
 *
 * Researched against the live APIs rather than from memory. Measured 2026-10:
 *
 *   OpenRouter   /api/v1/models  200, publishes `pricing` {prompt,completion}
 *   OpenCode Zen /zen/v1/models   200, id/object/created/owned_by only
 *   NVIDIA Build /v1/models       200, id/object/created/owned_by only
 *
 * Only OpenRouter can prove a model is free from metadata. The other two
 * publish no price, so their free models can only ever reach FREE_LIKELY.
 * Nothing here hard-codes a model list: the catalog is always fetched.
 *
 * `verified` records what a live probe actually returned on 2026-10, so the UI
 * can say "this one is known to work" instead of implying every entry is live:
 *
 *   OPEN       - /models answered 200 with no key; a scan will return models
 *   NEEDS_KEY  - the endpoint is alive but answers 401/403; the user's key works
 *
 * Re-run `node probe-urls.mjs` to refresh these. A BROKEN entry should be fixed
 * or removed rather than shipped, because it only costs the user a failed tap.
 */

import { BaseAdapter, extractPricing } from './base.js';

export const BUILTIN = {
  OPENROUTER: {
    id: 'openrouter',
    name: 'OpenRouter',
    type: 'BUILT_IN',
    // Measured 2026-10 by probe-urls.mjs: /models answers 200 with no key.
    verified: 'OPEN',
    baseURL: 'https://openrouter.ai/api/v1',
    protocol: 'openai-compatible',
    modelsPath: '/models',
    chatPath: '/chat/completions',
    // The only built-in that publishes pricing, so its free models can be
    // proven free from the catalog rather than guessed from the name.
    freeTier: 'reported',
    note: 'Có bảng giá công khai, tự nhận ra model 0đ chính xác nhất.',
  },
  OPENCODE_ZEN: {
    id: 'opencode-zen',
    name: 'OpenCode Zen',
    type: 'BUILT_IN',
    // Measured 2026-10 by probe-urls.mjs: /models answers 200 with no key.
    verified: 'OPEN',
    baseURL: 'https://opencode.ai/zen/v1',
    protocol: 'openai-compatible',
    modelsPath: '/models',
    chatPath: '/chat/completions',
    // Measured: /zen/v1/models returns id/object/created/owned_by only, no
    // price at all, so free status here can only ever come from the model name.
    freeTier: 'reported',
    note: 'Không công bố giá, chỉ nhận biết model 0đ qua tên.',
  },
  NVIDIA: {
    id: 'nvidia',
    name: 'NVIDIA Build',
    type: 'BUILT_IN',
    // Measured 2026-10 by probe-urls.mjs: /models answers 200 with no key.
    verified: 'OPEN',
    baseURL: 'https://integrate.api.nvidia.com/v1',
    protocol: 'openai-compatible',
    modelsPath: '/models',
    chatPath: '/chat/completions',
    // Measured: same shape as OpenCode Zen, no pricing published.
    freeTier: 'reported',
    note: 'Free tier cho tài khoản NVIDIA. Không công bố giá.',
  },

  // ---- Free-tier gateways ---------------------------------------------
  // Every one of these ships a free allowance rather than a free catalogue, so
  // they are all "free to try", never "provably free". They stay in the list
  // because the user's own key decides how much they can use, and because the
  // app's job is to find out which ones still work today.
  //
  // freeTier states what the provider advertises, not what it guarantees:
  //   'reported' - the provider documents a free allowance; unverified here
  //   'none'     - no free tier advertised
  GROQ: {
    id: 'groq',
    name: 'Groq',
    type: 'BUILT_IN',
    // Measured 2026-10 by probe-urls.mjs: alive, but 401/403 without a key.
    verified: 'NEEDS_KEY',
    baseURL: 'https://api.groq.com/openai/v1',
    protocol: 'openai-compatible',
    modelsPath: '/models',
    chatPath: '/chat/completions',
    freeTier: 'reported',
    note: 'OpenAI-compatible. Free tier có rate limit.',
  },
  CEREBRAS: {
    id: 'cerebras',
    name: 'Cerebras',
    type: 'BUILT_IN',
    // Measured 2026-10 by probe-urls.mjs: alive, but 401/403 without a key.
    verified: 'NEEDS_KEY',
    baseURL: 'https://api.cerebras.ai/v1',
    protocol: 'openai-compatible',
    modelsPath: '/models',
    chatPath: '/chat/completions',
    freeTier: 'reported',
    // Verified: /v1/models answers 403 "Not authenticated" without a key, which
    // is the expected shape and not a broken entry.
    note: 'Rất nhanh. Free tier có rate limit.',
  },
  // Measured: the OpenAI-compatible path serves chat/completions but has no
  // /models route (404). The native v1beta models route does work, so the base
  // stays on the compatible path for chat and modelsPath walks back up to the
  // native list. That absolute path is what makes this entry work at all.
  GOOGLE_AI_STUDIO: {
    id: 'google-ai-studio',
    name: 'Google AI Studio',
    type: 'BUILT_IN',
    // Measured 2026-10 by probe-urls.mjs: alive, but 401/403 without a key.
    verified: 'NEEDS_KEY',
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai',
    protocol: 'openai-compatible',
    modelsPath: '/../models',
    chatPath: '/chat/completions',
    freeTier: 'reported',
    note: 'Gemini free tier. Cần API key từ Google AI Studio.',
  },
  MISTRAL: {
    id: 'mistral',
    name: 'Mistral',
    type: 'BUILT_IN',
    // Measured 2026-10 by probe-urls.mjs: alive, but 401/403 without a key.
    verified: 'NEEDS_KEY',
    baseURL: 'https://api.mistral.ai/v1',
    protocol: 'openai-compatible',
    modelsPath: '/models',
    chatPath: '/chat/completions',
    freeTier: 'reported',
    note: 'Free tier rất nhỏ, phần lớn model có phí.',
  },
  DEEPSEEK: {
    id: 'deepseek',
    name: 'DeepSeek',
    type: 'BUILT_IN',
    // Measured 2026-10 by probe-urls.mjs: alive, but 401/403 without a key.
    verified: 'NEEDS_KEY',
    baseURL: 'https://api.deepseek.com/v1',
    protocol: 'openai-compatible',
    modelsPath: '/models',
    chatPath: '/chat/completions',
    freeTier: 'none',
    note: 'Có model rẻ, không có free tier.',
  },
  XAI: {
    id: 'xai',
    name: 'xAI Grok',
    type: 'BUILT_IN',
    // Measured 2026-10 by probe-urls.mjs: alive, but 401/403 without a key.
    verified: 'NEEDS_KEY',
    baseURL: 'https://api.x.ai/v1',
    protocol: 'openai-compatible',
    modelsPath: '/models',
    chatPath: '/chat/completions',
    freeTier: 'none',
    note: 'Có model miễn phí, không có free tier chung.',
  },
  TOGETHER: {
    id: 'together',
    name: 'Together AI',
    type: 'BUILT_IN',
    // Measured 2026-10 by probe-urls.mjs: alive, but 401/403 without a key.
    verified: 'NEEDS_KEY',
    baseURL: 'https://api.together.xyz/v1',
    protocol: 'openai-compatible',
    modelsPath: '/models',
    chatPath: '/chat/completions',
    freeTier: 'none',
    note: 'Có model 0đ, không có free tier cho tài khoản mới.',
  },
  POLLINATIONS: {
    id: 'pollinations',
    name: 'Pollinations',
    type: 'BUILT_IN',
    // Measured 2026-10 by probe-urls.mjs: /models answers 200 with no key.
    verified: 'OPEN',
    baseURL: 'https://text.pollinations.ai/openai',
    protocol: 'openai-compatible',
    modelsPath: '/models',
    chatPath: '/chat/completions',
    freeTier: 'reported',
    note: 'Không cần API key. Có rate limit công cộng.',
  },

  // ---- OpenAI-compatible gateways with a free tier --------------------
  // Listed so the user can try them without hunting for a base URL. All of
  // them publish no pricing, so a free verdict here can only come from the
  // model name or from the key actually working.
  SAMBANOVA: {
    id: 'sambanova',
    name: 'SambaNova',
    type: 'BUILT_IN',
    // Measured 2026-10 by probe-urls.mjs: /models answers 200 with no key.
    verified: 'OPEN',
    baseURL: 'https://api.sambanova.ai/v1',
    protocol: 'openai-compatible',
    modelsPath: '/models',
    chatPath: '/chat/completions',
    freeTier: 'reported',
    note: 'Free tier cho tài khoản mới.',
  },
  AIMLAPI: {
    id: 'aimlapi',
    name: 'AI/ML API',
    type: 'BUILT_IN',
    // Measured 2026-10 by probe-urls.mjs: /models answers 200 with no key.
    verified: 'OPEN',
    baseURL: 'https://api.aimlapi.com/v1',
    protocol: 'openai-compatible',
    modelsPath: '/models',
    chatPath: '/chat/completions',
    freeTier: 'reported',
    note: 'Có free tier cho model mở.',
  },
  CHUTES: {
    id: 'chutes',
    name: 'Chutes',
    type: 'BUILT_IN',
    // Measured 2026-10 by probe-urls.mjs: /models answers 200 with no key.
    verified: 'OPEN',
    baseURL: 'https://llm.chutes.ai/v1',
    protocol: 'openai-compatible',
    modelsPath: '/models',
    chatPath: '/chat/completions',
    freeTier: 'reported',
    note: 'Gateway mở, free tier theo token.',
  },
  OPENAI: {
    id: 'openai',
    name: 'OpenAI',
    type: 'BUILT_IN',
    // Measured 2026-10 by probe-urls.mjs: alive, but 401/403 without a key.
    verified: 'NEEDS_KEY',
    baseURL: 'https://api.openai.com/v1',
    protocol: 'openai-compatible',
    modelsPath: '/models',
    chatPath: '/chat/completions',
    freeTier: 'none',
    note: 'Có API key miễn phí dùng thử nhỏ cho tài khoản mới.',
  },
  Z_AI: {
    id: 'z-ai',
    name: 'Z.AI (GLM)',
    type: 'BUILT_IN',
    // Measured 2026-10 by probe-urls.mjs: alive, but 401/403 without a key.
    verified: 'NEEDS_KEY',
    baseURL: 'https://api.z.ai/api/paas/v4',
    protocol: 'openai-compatible',
    modelsPath: '/models',
    chatPath: '/chat/completions',
    freeTier: 'reported',
    note: 'GLM free tier qua endpoint tương thích OpenAI.',
  },
  FIREWORKS: {
    id: 'fireworks',
    name: 'Fireworks AI',
    type: 'BUILT_IN',
    // Measured 2026-10 by probe-urls.mjs: alive, but 401/403 without a key.
    verified: 'NEEDS_KEY',
    baseURL: 'https://api.fireworks.ai/inference/v1',
    protocol: 'openai-compatible',
    modelsPath: '/models',
    chatPath: '/chat/completions',
    freeTier: 'none',
    note: 'Có một số model mở miễn phí.',
  },
  DEEPINFRA: {
    id: 'deepinfra',
    name: 'DeepInfra',
    type: 'BUILT_IN',
    // Measured 2026-10 by probe-urls.mjs: /models answers 200 with no key.
    verified: 'OPEN',
    baseURL: 'https://api.deepinfra.com/v1/openai',
    protocol: 'openai-compatible',
    modelsPath: '/models',
    chatPath: '/chat/completions',
    freeTier: 'none',
    note: 'Rẻ hơn, không có free tier.',
  },
  HYPERBOLIC: {
    id: 'hyperbolic',
    name: 'Hyperbolic',
    type: 'BUILT_IN',
    // Measured 2026-10 by probe-urls.mjs: alive, but 401/403 without a key.
    verified: 'NEEDS_KEY',
    baseURL: 'https://api.hyperbolic.xyz/v1',
    protocol: 'openai-compatible',
    modelsPath: '/models',
    chatPath: '/chat/completions',
    freeTier: 'none',
    note: 'Có model mở, không có free tier.',
  },
  NOVITA: {
    id: 'novita',
    name: 'Novita AI',
    type: 'BUILT_IN',
    // Measured 2026-10 by probe-urls.mjs: /models answers 200 with no key.
    verified: 'OPEN',
    baseURL: 'https://api.novita.ai/v3/openai',
    protocol: 'openai-compatible',
    modelsPath: '/models',
    chatPath: '/chat/completions',
    freeTier: 'none',
    note: 'Gateway rẻ, không free tier.',
  },
  VERCEL: {
    id: 'vercel',
    name: 'Vercel AI Gateway',
    type: 'BUILT_IN',
    // Measured 2026-10 by probe-urls.mjs: /models answers 200 with no key.
    verified: 'OPEN',
    baseURL: 'https://ai-gateway.vercel.sh/v1',
    protocol: 'openai-compatible',
    modelsPath: '/models',
    chatPath: '/chat/completions',
    freeTier: 'reported',
    note: 'Có free tier qua Vercel AI Gateway.',
  },
  GITHUB_MODELS: {
    id: 'github-models',
    name: 'GitHub Models',
    type: 'BUILT_IN',
    // Measured 2026-10 by probe-urls.mjs: /models answers 200 with no key.
    verified: 'OPEN',
    baseURL: 'https://models.github.ai/inference',
    protocol: 'openai-compatible',
    modelsPath: '/models',
    chatPath: '/chat/completions',
    freeTier: 'reported',
    note: 'Free tier cho tài khoản GitHub.',
  },
  FREEPROXY: {
    id: 'freeproxy',
    name: 'Free Proxy (thử nghiệm)',
    type: 'BUILT_IN',
    // Measured 2026-10 by probe-urls.mjs: /models answers 200 with no key.
    verified: 'OPEN',
    baseURL: 'https://api.apifree.ai/v1',
    protocol: 'openai-compatible',
    modelsPath: '/models',
    chatPath: '/chat/completions',
    freeTier: 'reported',
    note: 'Proxy miễn phí, ổn định không chắc. Dùng thử trước.',
  },
};

export const BUILTIN_LIST = Object.values(BUILTIN);

/**
 * OpenRouter publishes full pricing, which is what makes automatic free
 * detection exact here. The `models` payload nests pricing per model, and the
 * free entries are the ones where both numbers are zero.
 */
export class OpenRouterAdapter extends BaseAdapter {
  constructor(config) {
    super({ ...config, type: 'BUILT_IN' });
    this.pricingSource = 'openrouter_pricing';
  }

  normalizeModel(raw) {
    const model = super.normalizeModel(raw);
    if (!model) return null;
    // OpenRouter ids already encode a namespace and often a ":free" tier, and
    // its pricing object uses prompt/completion. extractPricing handles both,
    // so the base result is already correct - this only records where the
    // numbers came from, which the evidence trail needs.
    return { ...model, pricingSource: this.pricingSource };
  }
}

/** OpenCode Zen and NVIDIA: no pricing published, free status comes from the name. */
export class CatalogOnlyAdapter extends BaseAdapter {
  constructor(config) {
    super({ ...config, type: 'BUILT_IN' });
    this.pricingSource = null;
  }

  normalizeModel(raw) {
    const model = super.normalizeModel(raw);
    if (!model) return null;
    // Confirmed by measurement: neither endpoint returns a price field, so
    // pricing must stay null. Anything else would fabricate a PAID verdict.
    return { ...model, pricing: null, pricingSource: null };
  }
}

const ADAPTER_CLASSES = {
  [BUILTIN.OPENROUTER.id]: OpenRouterAdapter,
  [BUILTIN.OPENCODE_ZEN.id]: CatalogOnlyAdapter,
  [BUILTIN.NVIDIA.id]: CatalogOnlyAdapter,
};

/**
 * Instantiate the right adapter for a provider row.
 *
 * Built-ins are matched on their id, whether the caller passes the constant
 * from BUILTIN or a row read back from storage. Custom providers fall through
 * to the generic OpenAI-compatible adapter.
 */
export function createAdapter(provider) {
  const builtinId = provider?.builtinId ?? (provider?.type === 'BUILT_IN' ? provider?.id : null);
  const Klass = builtinId ? ADAPTER_CLASSES[builtinId] : null;
  if (Klass) return new Klass(provider);
  return new BaseAdapter(provider);
}

export { extractPricing };
