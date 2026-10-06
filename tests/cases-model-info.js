/**
 * Reading what the provider actually published about a model.
 *
 * The scan already stored the whole catalog entry in `metadata`; the UI showed
 * only the model id and its measured speed. These cases pin the reader that
 * turns that stored data into something a person can read, and pin the rule that
 * matters most: a field nobody published stays missing rather than becoming a
 * zero, because "not stated" and "stated as zero" are different claims.
 *
 * The fixtures are trimmed from the live OpenRouter catalog rather than invented,
 * so the field names and nesting are the ones providers actually use.
 */
import { describe, it, assert, assertEqual } from './harness.js';
import { modelInfo, formatCount, formatPrice, ageOf } from '../core/model-info.js';

/** A real OpenRouter entry, with only the fields this reader cares about. */
const OPENROUTER_ENTRY = {
  id: 'inclusionai/ling-3.1-flash',
  name: 'inclusionAI: Ling 3.1 Flash',
  created: 1790950024,
  description:
    'Ling 3.1 Flash is a hybrid reasoning mixture-of-experts model from inclusionAI, with 25B active parameters out of 560B total.',
  context_length: 262144,
  architecture: { modality: 'text->text', input_modalities: ['text'], output_modalities: ['text'] },
  pricing: { prompt: '0', completion: '0' },
  top_provider: { context_length: 262144, max_completion_tokens: 32768 },
  supported_parameters: ['tools', 'tool_choice', 'reasoning', 'temperature', 'max_tokens'],
};

/** A provider that publishes almost nothing, which is the common case. */
const SPARSE_ENTRY = { id: 'weird/thing', name: 'weird/thing', context_length: 8192 };

const asModel = (metadata, extra = {}) => ({
  modelId: metadata.id ?? 'm',
  displayName: metadata.name ?? 'm',
  metadata,
  inputPrice: null,
  outputPrice: null,
  ...extra,
});

export function registerModelInfoCases() {
  describe('MI. What the provider published is what gets shown', () => {
    it('MI1: a full catalog entry yields every field a person reads', () => {
      const info = modelInfo(asModel(OPENROUTER_ENTRY));
      assertEqual(info.displayName, 'inclusionAI: Ling 3.1 Flash');
      assertEqual(info.context, 262144);
      assertEqual(info.maxOutput, 32768);
      assert(info.description.includes('mixture-of-experts'), 'the description is carried');
      assert(info.released, 'and the release date is parsed: ' + info.released);
    });

    it('MI2: capabilities are derived from what is listed, not assumed', () => {
      const info = modelInfo(asModel(OPENROUTER_ENTRY));
      assertEqual(info.supportsTools, true);
      assertEqual(info.supportsReasoning, true);
      assertEqual(info.supportsVision, false, 'no image modality was published');
    });

    it('MI3: a vision model is recognised', () => {
      const info = modelInfo(asModel({
        id: 'dots/note:free',
        name: 'Dots Note',
        architecture: { input_modalities: ['text', 'image'] },
      }));
      assertEqual(info.supportsVision, true);
      assert(info.modalities.includes('image'), 'the modality is listed');
    });

    it('MI4: nothing published means nothing shown', () => {
      const info = modelInfo({ modelId: 'x', displayName: 'x', metadata: {} });
      assertEqual(info.context, null, 'a missing limit stays null, never 0');
      assertEqual(info.maxOutput, null);
      assertEqual(info.description, null);
      assertEqual(info.supportsTools, false, 'no capability is invented');
      assertEqual(info.modalities.length, 0);
    });

    it('MI5: a display name equal to the id is not repeated', () => {
      // Showing "weird/thing" twice on one row wastes the space the real facts
      // need, so an id-shaped name is treated as no name at all.
      const info = modelInfo({ modelId: 'weird/thing', displayName: 'weird/thing', metadata: {} });
      assertEqual(info.displayName, null);
    });

    it('MI6: providers that nest the limits still resolve', () => {
      const info = modelInfo(asModel({ id: 'x', name: 'X', top_provider: { context_length: 32768, max_completion_tokens: 4096 } }));
      assertEqual(info.context, 32768, 'read from the nested block');
      assertEqual(info.maxOutput, 4096);
    });

    it('MI7: alternative field names are understood', () => {
      // Different providers publish the same limit under different names.
      const info = modelInfo(asModel({ id: 'y', name: 'Y', max_model_len: 16384, max_new_tokens: 2048 }));
      assertEqual(info.context, 16384);
      assertEqual(info.maxOutput, 2048);
    });

    it('MI8: a zero or negative limit is ignored', () => {
      // 0 here means "not stated", and rendering it as 0 would claim the model
      // accepts no input at all.
      const info = modelInfo(asModel({ id: 'z', name: 'Z', context_length: 0, max_output_tokens: -1 }));
      assertEqual(info.context, null);
      assertEqual(info.maxOutput, null);
    });

    it('MI9: a long description is cut to one sentence', () => {
      const info = modelInfo(asModel({ id: 'q', name: 'Q', description: 'First sentence. Second sentence. Third one.' }));
      assertEqual(info.description, 'First sentence.');
    });
  });

  describe('MI. Numbers a person can use', () => {
    it('MI10: context windows read as 256K, not 262.1K', () => {
      // Context limits are powers of two and every model card writes them in
      // binary units. "262.1K" is more precise than the provider's own data.
      assertEqual(formatCount(262144), '256K');
      assertEqual(formatCount(1048576), '1M');
      assertEqual(formatCount(32768), '32K');
    });

    it('MI11: a number that is not a round power keeps its value', () => {
      // Rounding a genuine 100000 to 128K would be inventing precision.
      assertEqual(formatCount(100000), '97.7K');
      assertEqual(formatCount(500), '500');
    });

    it('MI12: a missing number formats as nothing', () => {
      assertEqual(formatCount(0), null);
      assertEqual(formatCount(null), null);
      assertEqual(formatCount(NaN), null);
    });

    it('MI13: a free price reads as free, a real one as money', () => {
      assertEqual(formatPrice(0), '0đ');
      assert(formatPrice(0.0000008), 'a sub-cent price is still stated: ' + formatPrice(0.0000008));
      assert(formatPrice(0.003).includes('$'), 'and a normal one too: ' + formatPrice(0.003));
    });

    it('MI14: a release date reads as an age', () => {
      const today = new Date().toISOString().slice(0, 10);
      assertEqual(ageOf(today), 'mới');
      assertEqual(ageOf(null), null);
      assert(ageOf('2020-01-01').includes('năm trước'), 'an old date: ' + ageOf('2020-01-01'));
    });
  });
}
