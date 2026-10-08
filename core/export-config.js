/**
 * Export the configuration that is actually working.
 *
 * The question this answers is not "what have I stored" but "what can I hand to
 * another CLI right now". So it exports only the endpoints that proved
 * themselves: a provider appears because a mapping on it is HEALTHY, and the key
 * and model it carries are the ones that produced that verdict. A URL with keys
 * but no successful check is not in the file - pasting an unverified key into
 * another tool would move the failure, not the configuration.
 *
 * Locked rows are left out too. A lock means "do not use this", and a file that
 * quietly carried a row the user had switched off would be the same class of
 * bug as the router using it: the configuration and the app would disagree.
 *
 * Three shapes are offered on purpose, because no single file satisfies every
 * client. `.env` is what the OpenAI-compatible CLIs read (openai, aichat, llm,
 * mods, aider, ...), and it names a default endpoint plus one prefixed block per
 * URL so a multi-URL setup survives the flat format. JSON and YAML carry the
 * same picture without losing the list.
 *
 * This module is pure: it takes rows in and returns a string. Nothing here
 * touches storage or the DOM, and nothing here logs - the output contains real
 * secrets, so the only place allowed to show it is the export sheet the user
 * explicitly opened.
 */

import { STATUS } from './statuses.js';

/** The shapes the UI offers, in the order it offers them. */
export const EXPORT_FORMATS = ['env', 'json', 'yaml'];

/** A name turned into an ENV-safe prefix: upper case, no punctuation. */
function slugify(name, fallback = 'URL') {
  const cleaned = String(name ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return cleaned || fallback;
}

/** One YAML scalar. Quoted whenever the plain form could be ambiguous. */
function yamlScalar(value) {
  const text = String(value ?? '');
  if (text === '') return "''";
  // JSON's double-quoted form is a valid YAML scalar, and it is already correct
  // for every character that would otherwise change the meaning of the line.
  if (/^[A-Za-z0-9_./@+ ]+$/.test(text) && !/^\s|\s$/.test(text)) return text;
  return JSON.stringify(text);
}

/**
 * Reduce stored rows to the working configuration.
 *
 * Returns { version, exportedAt, default, endpoints }, which the three
 * formatters all read. `default` is the first endpoint, so a single-URL setup
 * still produces the OPENAI_* block most CLIs expect.
 */
export function buildExport({
  providers = [],
  keys = [],
  models = [],
  mappings = [],
  skipped = {},
  exportedAt = null,
} = {}) {
  const skipProvider = new Set(skipped.provider ?? []);
  const skipModel = new Set(skipped.model ?? []);
  const skipKey = new Set(skipped.key ?? []);

  const keyById = new Map(keys.map((k) => [k.id, k]));
  const modelByIdentity = new Map(models.map((m) => [`${m.providerId}::${m.modelId}`, m]));

  // Only a mapping that answered is "working". UNTESTED and every failure are
  // deliberately excluded: an export is a claim about what works.
  const healthy = mappings.filter((m) => m.status === STATUS.HEALTHY);

  const endpoints = [];
  for (const provider of providers) {
    if (skipProvider.has(provider.id)) continue;

    const usable = [];
    for (const mapping of healthy) {
      if (mapping.providerId !== provider.id) continue;
      if (skipKey.has(mapping.keyId)) continue;
      const key = keyById.get(mapping.keyId);
      if (!key) continue;
      const modelRow = modelByIdentity.get(`${provider.id}::${mapping.modelId}`);
      if (modelRow && skipModel.has(modelRow.id)) continue;
      usable.push({ model: mapping.modelId, key });
    }
    if (!usable.length) continue;

    endpoints.push({
      name: provider.name,
      slug: slugify(provider.name, 'URL'),
      baseURL: provider.baseURL,
      // The first healthy pair is the default one: it is the fastest-ranked
      // mapping the app already trusts for this URL.
      apiKey: usable[0].key.secret,
      model: usable[0].model,
      models: [...new Set(usable.map((u) => u.model))],
    });
  }

  endpoints.sort((a, b) => a.name.localeCompare(b.name, 'vi'));

  return {
    version: 1,
    exportedAt: exportedAt ?? new Date().toISOString(),
    default: endpoints[0] ?? null,
    endpoints,
  };
}

/** The `.env` shape: a default block plus one prefixed block per URL. */
function toEnv(data) {
  const lines = [
    '# FreeAI — cấu hình đang hoạt động',
    `# Xuất lúc ${data.exportedAt}`,
    '# Dùng cho CLI OpenAI-compatible: openai, aichat, llm, mods, aider, ...',
    '',
  ];

  if (data.default) {
    lines.push(
      '# Endpoint mặc định — dùng khi CLI chỉ đọc OPENAI_*',
      `OPENAI_BASE_URL=${data.default.baseURL}`,
      `OPENAI_API_KEY=${data.default.apiKey}`,
      `OPENAI_MODEL=${data.default.model}`,
      ''
    );
  }

  for (const endpoint of data.endpoints) {
    lines.push(
      `# ${endpoint.name}`,
      `${endpoint.slug}_BASE_URL=${endpoint.baseURL}`,
      `${endpoint.slug}_API_KEY=${endpoint.apiKey}`,
      `${endpoint.slug}_MODEL=${endpoint.model}`,
      ''
    );
  }

  return `${lines.join('\n').trimEnd()}\n`;
}

/** The same picture as JSON, without the prefixed duplicates. */
function toJson(data) {
  const out = {
    version: data.version,
    exportedAt: data.exportedAt,
    default: data.default
      ? {
          name: data.default.name,
          baseURL: data.default.baseURL,
          apiKey: data.default.apiKey,
          model: data.default.model,
        }
      : null,
    endpoints: data.endpoints.map((e) => ({
      name: e.name,
      baseURL: e.baseURL,
      apiKey: e.apiKey,
      model: e.model,
      models: e.models,
    })),
  };
  return `${JSON.stringify(out, null, 2)}\n`;
}

/** The same picture as YAML, for the tools configured with a file. */
function toYaml(data) {
  const lines = [`version: ${data.version}`, `exportedAt: ${yamlScalar(data.exportedAt)}`];

  lines.push('default:');
  if (data.default) {
    lines.push(`  name: ${yamlScalar(data.default.name)}`);
    lines.push(`  baseURL: ${yamlScalar(data.default.baseURL)}`);
    lines.push(`  apiKey: ${yamlScalar(data.default.apiKey)}`);
    lines.push(`  model: ${yamlScalar(data.default.model)}`);
  } else {
    lines.push('  null');
  }

  lines.push('endpoints:');
  if (!data.endpoints.length) {
    lines.push('  []');
  }
  for (const endpoint of data.endpoints) {
    lines.push(`  - name: ${yamlScalar(endpoint.name)}`);
    lines.push(`    baseURL: ${yamlScalar(endpoint.baseURL)}`);
    lines.push(`    apiKey: ${yamlScalar(endpoint.apiKey)}`);
    lines.push(`    model: ${yamlScalar(endpoint.model)}`);
    lines.push('    models:');
    for (const model of endpoint.models) lines.push(`      - ${yamlScalar(model)}`);
  }

  return `${lines.join('\n')}\n`;
}

/** Render `data` in one of the offered shapes. */
export function formatExport(data, format = 'env') {
  if (format === 'json') return toJson(data);
  if (format === 'yaml') return toYaml(data);
  return toEnv(data);
}

/** Convenience: rows in, one file's text out. */
export function exportConfig(rows, format = 'env') {
  return formatExport(buildExport(rows), format);
}
