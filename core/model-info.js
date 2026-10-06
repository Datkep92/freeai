/**
 * What we know about a model, read out of the raw catalog entry.
 *
 * The scanner stores every field the provider published in `metadata`, but the
 * UI could only ever show the model id and, once a request had run, its speed.
 * Everything below was already in the database and simply never read - which is
 * why the answer to "why does this model show nothing" is not a missing scan but
 * a missing renderer.
 *
 * Two rules this file follows:
 *
 *   1. A field is shown only when the provider stated it. A context window is
 *      never guessed from the model name, and a missing value stays missing
 *      rather than becoming a zero that reads like "no limit".
 *   2. Every number is formatted for a person, not for a spreadsheet. 262144
 *      is a fact nobody can use at a glance; "256K ngữ cảnh" is.
 */

/** Providers name these differently. Read the first one that is a real number. */
const CONTEXT_KEYS = ['context_length', 'context_window', 'max_context_length', 'max_model_len', 'max_sequence_length', 'max_input_tokens'];
const OUTPUT_KEYS = ['max_completion_tokens', 'max_output_tokens', 'max_tokens', 'max_new_tokens'];
const MODALITY_KEYS = ['modality', 'type', 'capabilities'];

/** Read the first field of `names` that holds a finite, positive number. */
function numFrom(raw, names) {
  for (const name of names) {
    const value = raw?.[name];
    const n = typeof value === 'string' ? Number(value) : value;
    if (Number.isFinite(n) && n > 0) return Math.round(n);
  }
  return null;
}

/**
 * 1234567 -> "1.2M". Rounded to two significant digits, because "1.23M" is
 * precision nobody needs and "1M" would hide a real difference.
 */
export function formatCount(n) {
  if (!Number.isFinite(n) || n <= 0) return null;
  // Context windows are published as powers of two, so 262144 is 256K and
  // 1048576 is 1M. Rounding to the nearest of those keeps the number honest -
  // "262.1K" is more precise than the provider's own data and reads as noise.
  const tidy = nearestPower(n);
  // Context and output limits are powers of two, and every model card in the
  // world writes them the same way: 256K, not 262.1K. So the scale is binary.
  if (tidy >= 1024 ** 3) return trim(tidy / 1024 ** 3) + 'T';
  if (tidy >= 1024 ** 2) return trim(tidy / 1024 ** 2) + 'M';
  if (tidy >= 1024) return trim(tidy / 1024) + 'K';
  return String(Math.round(n));
}

/** Nearest 2^n, but only when it is within ~8% - otherwise the number is real. */
function nearestPower(n) {
  const pow = 2 ** Math.round(Math.log2(n));
  return Math.abs(pow - n) / n < 0.08 ? pow : n;
}

/** 1.5 stays "1.5", 1.0 becomes "1", 12.34 becomes "12.3". */
function trim(n) {
  const rounded = Math.round(n * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1).replace(/\.0$/, '');
}

/**
 * Everything worth showing about one model.
 *
 * Returns nulls for anything the provider did not state, so the caller can tell
 * "not published" apart from "published as zero".
 */
export function modelInfo(model) {
  const raw = model?.metadata ?? {};

  // OpenRouter nests the same limits a second time; either copy is authoritative.
  const top = raw.top_provider ?? {};
  const arch = raw.architecture ?? {};

  const context =
    numFrom(raw, CONTEXT_KEYS) ??
    numFrom(top, CONTEXT_KEYS) ??
    numFrom(arch, CONTEXT_KEYS);

  const maxOutput =
    numFrom(raw, OUTPUT_KEYS) ??
    numFrom(top, OUTPUT_KEYS) ??
    numFrom(arch, OUTPUT_KEYS);

  const modalities = readModalities(raw, arch);
  const parameters = readParameters(raw);
  const released = toDate(raw.created ?? raw.created_at ?? raw.released_at);

  return {
    displayName: model?.displayName && model.displayName !== model.modelId ? model.displayName : null,
    description: firstSentence(raw.description ?? raw.summary ?? raw.info?.description),
    context,
    maxOutput,
    modalities,
    parameters,
    released,
    supportsTools: parameters.includes('tools') || parameters.includes('tool_choice'),
    supportsVision: modalities.some((m) => m === 'image'),
    supportsReasoning: parameters.includes('reasoning') || parameters.includes('include_reasoning'),
    // Raw prices, so a paid model can show what it costs instead of a label.
    inputPrice: numberOrNull(model?.inputPrice),
    outputPrice: numberOrNull(model?.outputPrice),
  };
}

function numberOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) && n !== 0 ? n : null;
}

/** Modalities as short words, taken from whichever shape the provider used. */
function readModalities(raw, arch) {
  const out = new Set();

  const add = (value) => {
    for (const v of String(value).toLowerCase().split(/[+,/]/)) {
      const t = v.trim();
      if (t) out.add(t);
    }
  };

  for (const value of [arch.modality, raw.modality, raw.type]) add(value);
  for (const value of [arch.input_modalities, raw.input_modalities, raw.input_modality]) add(value);
  for (const value of [arch.output_modalities, raw.output_modalities, raw.output_modality]) add(value);

  // Only the parts a person acts on. "text->text" says nothing useful.
  const keep = [...out].filter((m) =>
    ['text', 'image', 'audio', 'video', 'file', 'pdf'].includes(m)
  );
  return keep;
}

/** Supported parameters, kept short and de-duplicated. */
function readParameters(raw) {
  const list = raw.supported_parameters ?? raw.supportedParameters ?? raw.features ?? [];
  if (!Array.isArray(list)) return [];
  return [...new Set(list.map((x) => String(x).toLowerCase()).filter(Boolean))];
}

/** One sentence, trimmed: a description is context, not a paragraph to read. */
function firstSentence(text) {
  if (!text) return null;
  const clean = String(text).replace(/\s+/g, ' ').trim();
  if (!clean) return null;
  const stop = clean.search(/[.!?](\s|$)/);
  const one = stop === -1 ? clean : clean.slice(0, stop + 1);
  return one.length > 220 ? one.slice(0, 217).trimEnd() + '…' : one;
}

function toDate(value) {
  const n = Number(value);
  // Providers publish a unix timestamp in seconds, sometimes in milliseconds.
  const ms = n > 1e12 ? n : n > 1e9 ? n * 1000 : NaN;
  if (!Number.isFinite(ms)) return null;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

/** "3 ngày trước" / "2 tháng trước", for a published date. */
export function ageOf(isoDate) {
  const at = Date.parse(isoDate ?? '');
  if (!Number.isFinite(at)) return null;
  const days = Math.floor((Date.now() - at) / 86400000);
  if (days < 1) return 'mới';
  if (days < 30) return `${days} ngày trước`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} tháng trước`;
  return `${Math.floor(days / 365)} năm trước`;
}

/**
 * Price as a person reads it.
 *
 * Providers publish dollars per token, so 0.0000008 is $0.80 per million - a
 * number that has to be scaled to be meaningful. Zero is "miễn phí" rather than
 * "0", because a paid row showing 0 would be a contradiction.
 */
export function formatPrice(value, { perMillion = true } = {}) {
  if (!Number.isFinite(value)) return null;
  if (value === 0) return '0đ';
  const n = perMillion ? value * 1_000_000 : value;
  if (n >= 1) return `$${n.toFixed(2).replace(/\.00$/, '')}/tr tok`;
  if (n >= 0.01) return `$${n.toFixed(3)}/tr tok`;
  // Below a hundredth of a dollar the decimals stop meaning anything, so the
  // figure is stated as a fraction instead of as noise digits.
  return `$${(n / 1_000_000).toPrecision(2)}/tok`;
}
