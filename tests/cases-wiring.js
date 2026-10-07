import { describe, it, assert, assertEqual } from './harness.js';
import fs from 'node:fs';
import { STATUS, STATUS_META } from '../core/statuses.js';
import { FREE, FREE_META } from '../core/free-detector.js';

/**
 * These read index.html / app.js as text.
 *
 * The previous project shipped a button that silently did nothing for a long
 * time, because it filtered on a string that was not a valid status. No unit
 * test caught it: the wiring itself was never checked. These cases do that.
 */
function read(file) {
  return fs.readFileSync(new URL('../' + file, import.meta.url), 'utf8');
}

const appSource = read('app.js');
const htmlSource = read('index.html');

export function registerWiringCases() {
  describe('WR. UI wiring cannot point at nothing', () => {
    it('WR1: every element app.js looks up exists in index.html', () => {
      const used = [...new Set([...appSource.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]))];
      const declared = new Set([...htmlSource.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
      const missing = used.filter((id) => !declared.has(id));
      assertEqual(missing.length, 0, 'missing ids: ' + missing.join(', '));
    });

    it('WR2: every button in index.html is referenced by app.js', () => {
      const buttons = [...htmlSource.matchAll(/<button[^>]*id="([^"]+)"/g)].map((m) => m[1]);
      const orphaned = buttons.filter((id) => !appSource.includes("'" + id + "'"));
      assertEqual(orphaned.length, 0, 'buttons never wired: ' + orphaned.join(', '));
    });

    it('WR3: no filter literal is passed that is not a real status', () => {
      const literals = [...appSource.matchAll(/filterBy\('([^']+)'/g)].map((m) => m[1]);
      const bogus = literals.filter((v) => !Object.values(STATUS).includes(v) && !Object.values(FREE).includes(v));
      assertEqual(bogus.length, 0, 'non-enum filter literals: ' + bogus.join(', '));
    });

    it('WR4: every core status has a legend entry', () => {
      const missing = Object.values(STATUS).filter((s) => !STATUS_META[s]);
      assertEqual(missing.length, 0, 'no legend for: ' + missing.join(', '));
    });

    it('WR5: every free level has a legend entry', () => {
      const missing = Object.values(FREE).filter((s) => !FREE_META[s]);
      assertEqual(missing.length, 0, 'no legend for: ' + missing.join(', '));
    });

    it('WR6: no two statuses share a colour', () => {
      const byEmoji = new Map();
      for (const status of Object.values(STATUS)) {
        const e = STATUS_META[status].emoji;
        byEmoji.set(e, (byEmoji.get(e) ?? []).concat(status));
      }
      const clashes = [...byEmoji.entries()].filter(([, list]) => list.length > 1);
      assertEqual(clashes.length, 0, 'duplicates: ' + clashes.map(([e, l]) => e + '=' + l.join('/')).join(', '));
    });

    it('WR7: the controls the user asked for are present', () => {
      for (const id of ['btnScanAll', 'btnAddUrl', 'appbarAddUrl', 'btnAddKey', 'btnTestModel', 'btnBulk', 'keyDialog', 'addUrlDialog', 'modelDialog', 'urlSearch', 'urlSearchClear', 'urlSortFree', 'scopeClear']) {
        assert(htmlSource.includes('id="' + id + '"'), 'index.html must declare #' + id);
        assert(appSource.includes("'" + id + "'"), 'app.js must wire #' + id);
      }

      // The two URL classes the drawer's classifier offers. They are buttons in
      // the markup rather than a select, because the user asked for a button and
      // because a two-answer question is answered faster by two taps than by
      // opening a list.
      for (const cls of ['nokey', 'needkey']) {
        assert(
          htmlSource.includes('data-urlclass="' + cls + '"'),
          'index.html must offer the "' + cls + '" URL class'
        );
      }
      assert(
        appSource.includes("'.classbtn'"),
        'and every class button has to be wired in app.js'
      );
      // The global paste box and CHECK API were removed on purpose: keys are
      // added per URL, so a second bulk path would only let a key be filed
      // under a URL the user never chose. The two header buttons went the same
      // way for the same class of reason: they acted on "the URL that is open",
      // and the main list no longer has one.
      for (const gone of ['pasteKeys', 'btnCheckAll', 'corsBanner', 'btnAddModel', 'btnAddKeyUrl']) {
        assert(!htmlSource.includes('id="' + gone + '"'), '#' + gone + ' must be gone from index.html');
        assert(!appSource.includes("'" + gone + "'"), 'and nothing in app.js may look it up');
      }
    });

    it('WR8: keys are masked in the tree and only revealed on demand', () => {
      assert(appSource.includes('.masked'), 'the UI renders masked values');
      assert(
        /revealKey|showFullKey|revealSecret/.test(appSource),
        'there must be an explicit reveal path'
      );
    });

    // ------------------------------------------------------------------
    // Encoding. A Vietnamese UI is only readable if the bytes survive.
    //
    // This file previously shipped "lữi" spelled with a Latin-1 control
    // byte (U+0091) sitting inside a run of numeric entities. Every browser
    // renders that as a stray glyph or nothing at all, and no functional test
    // notices. So the checks below are about bytes, not behaviour.
    // ------------------------------------------------------------------

    it('WR9: every shipped file is UTF-8 with no BOM and no replacement char', () => {
      const files = [
        'index.html', 'app.js', 'styles.css', 'sw.js', 'plan.md',
        ...fs.readdirSync(new URL('../core', import.meta.url)).filter((f) => f.endsWith('.js')).map((f) => 'core/' + f),
        ...fs.readdirSync(new URL('../core/adapters', import.meta.url)).filter((f) => f.endsWith('.js')).map((f) => 'core/adapters/' + f),
      ];
      for (const file of files) {
        const bytes = fs.readFileSync(new URL('../' + file, import.meta.url));
        const text = bytes.toString('utf8');

        assert(
          !(bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf),
          file + ' must not start with a BOM'
        );
        assert(!text.includes('\uFFFD'), file + ' must not contain a replacement character');
        // Round-tripping proves the bytes really are valid UTF-8: an invalid
        // sequence decodes to U+FFFD and would not survive this comparison.
        assert(
          Buffer.from(text, 'utf8').equals(bytes),
          file + ' must be valid UTF-8 on disk'
        );
      }
    });

    it('WR10: no stray control characters from a bad Latin-1 conversion', () => {
      // U+0080-U+009F are C1 controls. They are what a UTF-8 file mangled by a
      // Latin-1 round trip looks like, and they are never intentional in UI text.
      for (const file of ['index.html', 'app.js', 'styles.css', 'sw.js']) {
        const text = read(file);
        const bad = [...text.matchAll(/[\u0080-\u009f]/g)];
        assertEqual(
          bad.length,
          0,
          file + ' holds C1 control chars at ' + bad.slice(0, 3).map((m) => 'index ' + m.index).join(', ')
        );
      }
    });

    it('WR11: Vietnamese text is written directly, not as HTML entities', () => {
      // Entities were the original encoding bug: they render inconsistently,
      // break search in the source, and hide the real bytes from a reader.
      const html = read('index.html');
      const entities = [...html.matchAll(/&([a-zA-Z][a-zA-Z0-9]{1,9}|#[0-9]{1,6});/g)].map((m) => m[1]);
      const named = [...new Set(entities)];
      assertEqual(named.length, 0, 'no HTML entities: ' + named.join(' '));

      // And the text a Vietnamese speaker expects must actually be present.
      for (const phrase of ['Quét model 0đ', 'THÊM URL', 'THÊM API', 'Đóng', 'Huỷ', 'Tất cả']) {
        assert(html.includes(phrase), 'index.html must contain ' + JSON.stringify(phrase));
      }
      assert(html.includes('<meta charset="utf-8"'), 'the charset declaration stays');
    });

    it('WR12: the page declares the charset before any visible text', () => {
      const html = read('index.html');
      const charset = html.indexOf('<meta charset="utf-8"');
      // Any visible text element counts, not one exact tag: the header is no
      // longer a bare <h1>, and a probe pinned to it would miss the very thing
      // it is protecting - a charset declaration that arrives too late.
      const firstText = html.search(/<h1|<h2|<p[ >]|<div class="[^"]*sub/);
      assert(charset !== -1, 'a charset meta is required');
      assert(
        charset < firstText,
        'the charset meta has to come first, or the browser guesses before it reads'
      );
    });

    // ------------------------------------------------------------------
    // Zoom. Pinning the scale is a three-part job: the viewport meta, the CSS,
    // and the gesture handlers. Dropping any one of them lets a phone zoom.
    // ------------------------------------------------------------------

    it('WR13: the viewport pins the scale on a phone', () => {
      const html = read('index.html');
      const viewport = html.match(/<meta name="viewport" content="([^"]+)"/)?.[1] ?? '';
      assert(viewport.includes('width=device-width'), 'width must follow the device');
      assert(viewport.includes('initial-scale=1'), 'and start unscaled');
      assert(viewport.includes('user-scalable=no'), 'user-scalable=no is what stops pinch-zoom');
      assert(viewport.includes('maximum-scale=1'), 'maximum-scale=1 closes the other door');
    });

    it('WR14: the CSS removes pinch and the OS text inflation', () => {
      const css = read('styles.css');
      // "manipulation" still allows pinch, so the pan form is the one required.
      assert(
        /touch-action:\s*pan-x\s+pan-y/.test(css),
        'touch-action must be pan-x pan-y; manipulation still permits pinch-zoom'
      );
      assert(css.includes('-webkit-text-size-adjust: 100%'), 'iOS text inflation must be off');
      assert(css.includes('text-size-adjust: 100%'), 'and the standard property too');
    });

    it('WR15: the pinch gestures are cancelled from JS', () => {
      // CSS cannot cancel a Safari gesture event, so app.js has to.
      for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
        assert(appSource.includes(type), 'app.js must handle ' + type);
      }
      const guard = appSource.slice(
        appSource.indexOf('function lockScale'),
        appSource.indexOf('lockScale();')
      );
      assert(guard.includes('preventDefault'), 'and must preventDefault them');
      assert(
        /passive:\s*false/.test(guard),
        'a passive listener cannot preventDefault, so it must be non-passive'
      );
      // One finger must still scroll: only a multi-touch event is a pinch.
      assert(
        guard.includes('touches?.length > 1'),
        'only a two-finger touch may be cancelled, or scrolling breaks'
      );
    });

    // ------------------------------------------------------------------
    // Free-only, and no truncation.
    // ------------------------------------------------------------------

    it('WR16: the paid chip is gone from the filter row', () => {
      // The list is free-only now, so a "Có phí" chip is a promise the
      // UI cannot keep.
      assert(!htmlSource.includes('data-filter="paid"'), 'no paid chip in index.html');
      assert(
        !appSource.includes("filterBy('paid')"),
        'and nothing routes to it either'
      );
    });

    it('WR16b: the filter row offers two tabs, not the old three', () => {
      // "0đ" and "Chắc 0đ" were merged into one Free tab. A leftover "zero"
      // chip would split a set the merge deliberately joined.
      assert(!htmlSource.includes('data-filter="zero"'), 'no zero chip in index.html');
      assert(!appSource.includes("filterBy('zero')"), 'and nothing routes to it either');
      const chips = [...htmlSource.matchAll(/<button[^>]*data-filter="([^"]+)"/g)].map((m) => m[1]);
      assertEqual(chips.length, 2, 'exactly two tabs, got: ' + chips.join(','));
    });

    it('WR17: the main list filters paid models out before anything else', () => {
      const render = appSource.slice(appSource.indexOf('async function render()'), appSource.indexOf('function modelRow'));
      assert(
        render.includes('m.freeStatus !== FREE.PAID'),
        'render() must drop paid models before the user filter runs'
      );
      assert(
        render.indexOf('m.freeStatus !== FREE.PAID') < render.indexOf('matcher(model)'),
        'the paid drop has to come first, or a chip could re-admit them'
      );
      assert(
        render.includes('const matcher = FILTERS[activeFilter]'),
        'and the chip only narrows the set the drop produced'
      );
    });

    it('WR18: no slice or limit truncates the model list', () => {
      // A cap here would hide models the user already scanned for, and the
      // count above the list would stop matching what is on screen.
      const section = appSource.slice(
        appSource.indexOf('function urlSection'),
        appSource.indexOf('function modelRow')
      );
      assert(!/\.slice\(0,\s*\d+/.test(section), 'the rendered list must not take a first-N');
      assert(
        section.includes('for (const model of models) group.append(modelRow(provider, model, keys))'),
        'every surviving row is rendered'
      );
    });
  });
}
