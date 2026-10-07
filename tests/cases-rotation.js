/**
 * Rotation: locks, order, speed and per-URL settings.
 *
 * These are the rules a user relies on when they lock something or drag a list,
 * so they are tested as behaviour rather than as storage: a lock that does not
 * actually remove a row from rotation is invisible in the data and only shows
 * up when a request goes somewhere the user did not want.
 */
import { describe, it, assert, assertEqual, assertDeepEqual } from './harness.js';
import { MemoryStorage } from '../core/storage.js';
import { Priority, SCOPE, ROTATION, LEVELS, SETTINGS_ID, sortByPriority, partitionByLock, speedOf } from '../core/priority.js';
import { MetricsRegistry, measure, accumulate, readUsage, emptyMetrics, compareBySpeed } from '../core/metrics.js';

const now = new Date().toISOString();

function row(id, extra = {}) {
  return { id, providerId: 'p1', modelId: id, ...extra };
}

function metricsMap(entries) {
  const map = new Map();
  for (const [key, value] of Object.entries(entries)) map.set(key, value);
  return map;
}

export function registerRotationCases() {
  describe('RX. Locks are a skip, not a promotion', () => {
    it('RX1: the three levels are declared lowest first', () => {
      assertEqual(LEVELS.join(','), 'key,model,provider', 'key is the lowest level');
    });

    it('RX2: locking one level does not write locks onto the others', async () => {
      const priority = new Priority(new MemoryStorage());
      await priority.setLocked({ level: 'provider', id: 'url1', locked: true });

      const state = await priority.load();
      // Inheritance, not copying: a lock written onto every descendant would
      // need redoing after each scan and would drift out of sync.
      assertEqual(state.skipped.provider.length, 1, 'the URL is locked');
      assertEqual(state.skipped.model.length, 0, 'no model rows were touched');
      assertEqual(state.skipped.key.length, 0, 'no key rows were touched');
    });

    it('RX3: a lock is inherited by everything below it', async () => {
      const priority = new Priority(new MemoryStorage());
      await priority.setLocked({ level: 'provider', id: 'url1', locked: true });

      assert(await priority.isLocked({ level: 'model', id: 'm1', providerLocked: true }), 'models follow the URL');
      assert(await priority.isLocked({ level: 'key', id: 'k1', providerLocked: true }), 'keys follow the URL');
      assert(!(await priority.isLocked({ level: 'model', id: 'm1' })), 'but not without the parent being locked');
    });

    it('RX4: unlocking a URL leaves a deliberately locked model alone', async () => {
      const priority = new Priority(new MemoryStorage());
      await priority.setLocked({ level: 'provider', id: 'url1', locked: true });
      await priority.setLocked({ level: 'model', id: 'm1', locked: true });

      await priority.setLocked({ level: 'provider', id: 'url1', locked: false });
      assert(!(await priority.isLocked({ level: 'provider', id: 'url1' })), 'the URL is open');
      assert(await priority.isLocked({ level: 'model', id: 'm1' }), 'the model the user locked is still locked');
    });

    it('RX5: a manual unlock opens the whole branch, lowest level first', async () => {
      const priority = new Priority(new MemoryStorage());
      await priority.setLocked({ level: 'provider', id: 'url1', locked: true });
      await priority.setLocked({ level: 'model', id: 'm1', locked: true });
      await priority.setLocked({ level: 'key', id: 'k1', locked: true });

      // The cascade is given the ids that live under this URL, so it knows
      // exactly which locks belong to it.
      await priority.setLocked({
        level: 'provider',
        id: 'url1',
        locked: false,
        exclusive: true,
        descendants: { model: ['m1'], key: ['k1'] },
      });
      const state = await priority.load();
      // Opening one level while the ones below stay blocked would look open and
      // still never run, which is the confusing state this action removes.
      assertEqual(state.skipped.provider.length, 0, 'URL open');
      assertEqual(state.skipped.model.length, 0, 'models open');
      assertEqual(state.skipped.key.length, 0, 'keys open');
    });

    it('RX5b: unlocking a URL leaves locks that belong to another URL', async () => {
      // The bug this pins down: the cascade used to blank every model and key
      // lock in the app, so opening one URL in the drawer silently reopened a
      // model the user had locked somewhere else entirely.
      const priority = new Priority(new MemoryStorage());
      await priority.setLocked({ level: 'model', id: 'mine', locked: true });
      await priority.setLocked({ level: 'model', id: 'theirs', locked: true });
      await priority.setLocked({ level: 'key', id: 'k-mine', locked: true });
      await priority.setLocked({ level: 'key', id: 'k-theirs', locked: true });

      await priority.setLocked({
        level: 'provider',
        id: 'url1',
        locked: false,
        exclusive: true,
        descendants: { model: ['mine'], key: ['k-mine'] },
      });

      const state = await priority.load();
      assertEqual(state.skipped.model.join(','), 'theirs', 'only the other URL model stays locked');
      assertEqual(state.skipped.key.join(','), 'k-theirs', 'and so does its key');
    });

    it('RX5c: with no known subtree nothing below the tapped level is touched', async () => {
      // Better to open one level than to guess: an inherited lock above still
      // applies, and nothing another URL owns can be released by accident.
      const priority = new Priority(new MemoryStorage());
      await priority.setLocked({ level: 'model', id: 'm1', locked: true });

      await priority.setLocked({ level: 'provider', id: 'url1', locked: false, exclusive: true });
      const state = await priority.load();
      assertEqual(state.skipped.provider.length, 0, 'the URL itself opened');
      assertEqual(state.skipped.model.join(','), 'm1', 'a model with no proven owner stays put');
    });

    it('RX6: locked rows are separated out of the rotation', () => {
      const rows = [row('m1'), row('m2'), row('m3')];
      const { free, locked } = partitionByLock(rows, { skipped: new Set(['m2']), scope: SCOPE.MODEL });
      assertEqual(free.length, 2, 'the unlocked rows remain');
      assertEqual(locked.length, 1, 'the locked row is set aside');
      assertEqual(locked[0].id, 'm2');
    });
  });

  describe('RX. Order and speed decide what runs', () => {
    it('RX7: the dragged order outranks the speed rule', () => {
      const rows = [row('slow'), row('fast'), row('mid')];
      const metrics = metricsMap({
        slow: { samples: 3, tokensPerSec: 5, ttftMs: 900 },
        fast: { samples: 3, tokensPerSec: 90, ttftMs: 100 },
        mid: { samples: 3, tokensPerSec: 40, ttftMs: 300 },
      });

      const bySpeed = sortByPriority(rows, {
        scope: SCOPE.MODEL,
        rotation: ROTATION.SPEED,
        metrics,
      });
      assertEqual(bySpeed[0].id, 'fast', 'speed alone puts the fastest model first');

      const dragged = sortByPriority(rows, {
        scope: SCOPE.MODEL,
        rotation: ROTATION.SPEED,
        metrics,
        order: ['slow'],
      });
      assertEqual(dragged[0].id, 'slow', 'an explicitly dragged id wins over speed');
      assertEqual(dragged[1].id, 'fast', 'and the rest still sort by speed');
    });

    it('RX8: an unmeasured model sorts last, not as the slowest', () => {
      const rows = [row('unknown'), row('measured')];
      const metrics = metricsMap({ measured: { samples: 2, tokensPerSec: 20, ttftMs: 400 } });

      const sorted = sortByPriority(rows, { scope: SCOPE.MODEL, rotation: ROTATION.SPEED, metrics });
      assertEqual(
        sorted[sorted.length - 1].id,
        'unknown',
        'never measured must not be ranked as 0 tok/s'
      );
      assertEqual(speedOf(undefined), -1, 'missing metrics score below any real one');
      assertEqual(speedOf({ samples: 0, tokensPerSec: 0 }), -1, 'so does an empty row');
    });

    it('RX9: MANUAL keeps the dragged order and ignores speed', () => {
      const rows = [row('a'), row('b'), row('c')];
      const metrics = metricsMap({
        a: { samples: 2, tokensPerSec: 1 },
        c: { samples: 2, tokensPerSec: 99 },
      });
      const sorted = sortByPriority(rows, {
        scope: SCOPE.MODEL,
        rotation: ROTATION.MANUAL,
        metrics,
        order: ['c', 'a'],
      });
      assertEqual(sorted.map((r) => r.id).join(','), 'c,a,b', 'dragged ids first, rest untouched');
    });

    it('RX10: an order the user set survives a new row appearing', async () => {
      const priority = new Priority(new MemoryStorage());
      await priority.setOrder(SCOPE.MODEL, ['m1', 'm2']);

      const state = await priority.load();
      // A sparse order is the point: a full sequence would freeze m3 at the end
      // forever instead of letting it sort on its own merits.
      assertEqual(state.order.model.length, 2, 'only what was dragged is stored');
      assertEqual(state.order.model.includes('m3'), false, 'an unseen id is not in the order');
    });

    it('RX11: move inserts an id that was never ordered', async () => {
      const priority = new Priority(new MemoryStorage());
      await priority.setOrder(SCOPE.MODEL, ['m1', 'm2']);
      await priority.move(SCOPE.MODEL, 'm3', 0);
      assertEqual((await priority.orderFor(SCOPE.MODEL)).join(','), 'm3,m1,m2');
    });
  });

  describe('RX. Per-URL settings override the global ones', () => {
    it('RX12: a URL with no settings follows the global rule', async () => {
      const priority = new Priority(new MemoryStorage());
      await priority.setRotation(ROTATION.ROUND_ROBIN);
      const view = await priority.forProvider({ id: 'url1' });
      assertEqual(view.rotation, ROTATION.ROUND_ROBIN, 'the global rule applies');
      assert(view.isGlobal, 'and it is reported as inherited');
    });

    it('RX13: a URL override replaces the rule for that URL only', async () => {
      const priority = new Priority(new MemoryStorage());
      await priority.setRotation(ROTATION.SPEED);

      const provider = { id: 'url1', priority: { rotation: ROTATION.MANUAL } };
      const view = await priority.forProvider(provider);
      assertEqual(view.rotation, ROTATION.MANUAL, 'the override wins');
      assert(!(await priority.forProvider({ id: 'url2' })).isGlobal === false, 'a null override is inherited');
    });

    it('RX14: a null override falls back to the global value', async () => {
      const priority = new Priority(new MemoryStorage());
      await priority.setRotation(ROTATION.ROUND_ROBIN);
      const view = await priority.forProvider({ id: 'url1', priority: { rotation: null } });
      assertEqual(view.rotation, ROTATION.ROUND_ROBIN, 'clearing the override restores the global rule');
    });

    it('RX15: a per-URL model lock adds to the global locks', async () => {
      const priority = new Priority(new MemoryStorage());
      await priority.setSkipped(SCOPE.MODEL, 'global-locked');

      const view = await priority.forProvider({ id: 'url1', priority: { skipped: { models: ['local-locked'] } } });
      assert(view.skippedModels.has('global-locked'), 'the global lock still applies here');
      assert(view.skippedModels.has('local-locked'), 'and the URL adds its own');
    });

    it('RX15b: the priority settings are stored in the shape the schema declares', async () => {
      // The settings store is a key/value store: `{ id, value }`. A row written
      // with the fields flat is the other shape, and having both in one store is
      // how a reader ends up guessing which one it is looking at.
      const storage = new MemoryStorage();
      const priority = new Priority(storage);
      await priority.setSkipped(SCOPE.MODEL, 'm1');

      const row = await storage.get('settings', SETTINGS_ID);
      assertEqual(row.id, SETTINGS_ID);
      assert(Array.isArray(row.value?.skipped?.[SCOPE.MODEL]), 'the payload lives under `value`');
      assertEqual(row.rotation, undefined, 'and not duplicated onto the row');
      assert(Number.isFinite(Date.parse(row.updatedAt)), 'with a timestamp');
      assertDeepEqual(row.value.skipped[SCOPE.MODEL], ['m1'], 'and the lock it was asked to set');
    });

    it('RX15c: a settings row written flat is still read', async () => {
      // A database written before `value` existed, or one that went through the
      // migration on an older build. Reading only `value` would drop the user's
      // lock list on upgrade, which is the worst possible time to lose it.
      const storage = new MemoryStorage();
      await storage.put('settings', {
        id: SETTINGS_ID,
        rotation: ROTATION.ROUND_ROBIN,
        skipped: { [SCOPE.MODEL]: ['kept-from-before'] },
        order: { [SCOPE.MODEL]: [] },
        updatedAt: now,
      });

      const state = await new Priority(storage).load();
      assertEqual(state.rotation, ROTATION.ROUND_ROBIN, 'the old row is understood');
      assertEqual(state.skipped[SCOPE.MODEL][0], 'kept-from-before', 'and so is the lock list');
      assert(Array.isArray(state.skipped[SCOPE.KEY]), 'with the other scopes filled in behind it');

      // And writing over it replaces it with the declared shape.
      await new Priority(storage).setSkipped(SCOPE.KEY, 'k1');
      const rewritten = await storage.get('settings', SETTINGS_ID);
      assert(rewritten.value?.skipped?.[SCOPE.KEY]?.includes('k1'), 'the new row is the declared shape');
      assertEqual(rewritten.skipped, undefined, 'the flat fields are gone');
    });

    it('RX16: clearing the settings keeps the rest of the provider row', async () => {
      const storage = new MemoryStorage();
      await storage.put('providers', {
        id: 'url1', name: 'Test', baseURL: 'https://t.test/v1', status: 'OK',
        priority: { rotation: ROTATION.MANUAL, skipped: null, order: null },
      });

      const priority = new Priority(storage);
      await priority.setProviderPriority('url1', { rotation: null });
      const row = await storage.get('providers', 'url1');
      assertEqual(row.status, 'OK', 'live state is untouched');
      assertEqual(row.name, 'Test', 'and so is the identity');
      assertEqual(row.priority.rotation, null, 'the override is cleared');
    });

    it('RX17: settings for a URL that does not exist change nothing', async () => {
      const priority = new Priority(new MemoryStorage());
      assertEqual(await priority.setProviderPriority('missing', { rotation: ROTATION.MANUAL }), null);
    });
  });

  describe('MX. Measurements are only stored for real successes', () => {
    it('MX1: token counts are read from every provider field name', () => {
      const openai = readUsage({ usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 } });
      assertEqual(openai.promptTokens, 12);
      assertEqual(openai.completionTokens, 8);

      const gemini = readUsage({ usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 7 } });
      assertEqual(gemini.promptTokens, 5, 'Gemini camelCase is read');
      assertEqual(gemini.completionTokens, 7);

      const none = readUsage({});
      assertEqual(none.promptTokens, null, 'a missing field is null, never 0');
      assertEqual(none.completionTokens, null);
    });

    it('MX2: speed uses generation time, not total request time', () => {
      // 1000ms total with a 500ms first token means 500ms of generation, so
      // 20 tokens over that window is 40 tok/s - not 20 tok/s over the whole
      // request, which would penalise every model with a slow prompt.
      const measured = measure({
        totalMs: 1000,
        ttftMs: 500,
        usage: { promptTokens: 10, completionTokens: 20 },
      });
      assertEqual(measured.tokensPerSec, 40);
      assertEqual(measured.ttftMs, 500);
    });

    it('MX3: speed is not computed without both a count and a duration', () => {
      const noUsage = measure({ totalMs: 1000, ttftMs: 200 });
      assertEqual(noUsage.tokensPerSec, null, 'no token count means no speed figure');

      const zeroTokens = measure({ totalMs: 1000, ttftMs: 200, usage: { completionTokens: 0 } });
      assertEqual(zeroTokens.tokensPerSec, null, 'an empty answer has no speed');

      const noTtf = measure({ totalMs: 800, usage: { completionTokens: 10 } });
      assertEqual(noTtf.tokensPerSec, null, 'without ttft the generation window is unknown');
      assertEqual(noTtf.totalMs, 800, 'but the total is still recorded');
    });

    it('MX4: a failure with no timings is never recorded', async () => {
      const storage = new MemoryStorage();
      const metrics = new MetricsRegistry(storage);
      assertEqual(await metrics.record('p1', 'm1', { totalMs: null, ttftMs: null }), null);
      assertEqual((await storage.list('metrics')).length, 0, 'no row that would read as measured');
    });

    it('MX5: repeated runs average instead of overwriting', () => {
      let row = emptyMetrics();
      row = accumulate(row, { ttftMs: 100, tokensPerSec: 40, totalMs: 300 });
      row = accumulate(row, { ttftMs: 300, tokensPerSec: 60, totalMs: 500 });

      assertEqual(row.samples, 2, 'both runs counted');
      assertEqual(row.ttftMs, 200, 'the average, so one fast run does not define the model');
      assertEqual(row.tokensPerSec, 50);
      assertEqual(row.bestTtftMs, 100, 'the best is remembered');
      assertEqual(row.worstTtftMs, 300, 'and the worst');
      assertEqual(row.bestTokensPerSec, 60);
    });

    it('MX6: two URLs offering one model are measured apart', async () => {
      const storage = new MemoryStorage();
      const metrics = new MetricsRegistry(storage);
      await metrics.record('url1', 'shared', { ttftMs: 100, tokensPerSec: 50, totalMs: 200 });
      await metrics.record('url2', 'shared', { ttftMs: 800, tokensPerSec: 10, totalMs: 900 });

      const slow = await metrics.get('url2', 'shared');
      const fast = await metrics.get('url1', 'shared');
      assertEqual(slow.ttftMs, 800, 'a slow gateway does not drag the fast one down');
      assertEqual(fast.ttftMs, 100);
    });

    it('MX7: metrics for a removed URL are dropped', async () => {
      const storage = new MemoryStorage();
      const metrics = new MetricsRegistry(storage);
      await metrics.record('url1', 'm1', { ttftMs: 100, totalMs: 200 });
      await metrics.record('url2', 'm2', { ttftMs: 100, totalMs: 200 });

      assertEqual(await metrics.removeForProvider('url1'), 1);
      assertEqual((await storage.list('metrics')).length, 1, 'only the other URL is left');
    });

    it('MX8: an unmeasured model sorts after a measured one', () => {
      const measured = { samples: 2, tokensPerSec: 5, ttftMs: 2000 };
      assert(compareBySpeed({ samples: 2, tokensPerSec: 90, ttftMs: 100 }, measured) < 0, 'faster first');
      assert(compareBySpeed(emptyMetrics(), measured) > 0, 'unmeasured last');
    });
  });
}
