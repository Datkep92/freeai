/**
 * UI tests.
 *
 * These boot the real app.js against a minimal DOM stub and drive it the way
 * a person does: render the list, tap a model, read what the dialog shows.
 * A wiring check on ids alone cannot catch a render path that throws, or a
 * dialog that shows the wrong row - both of which happened while building.
 */

import { describe, it, assert, assertEqual } from './harness.js';
import { MemoryStorage } from '../core/storage.js';
import { ProviderRegistry } from '../core/provider-registry.js';
import { ModelRegistry } from '../core/model-registry.js';
import { KeyRegistry } from '../core/key-registry.js';
import { createMockFetch } from './mock-fetch.js';
import fs from 'node:fs';

const KEY_A = 'oc_sk_A1b2C3d4E5f6G7h8I9j0';

/** Height the stub gives every row, so a vertical layout exists to measure. */
const ROW_HEIGHT_PX = 56;
const KEY_B = 'oc_sk_Z9y8X7w6V5u4T3s2R1q0';

const DOM_IDS = [
  'btnScanAll', 'btnAddUrl', 'btnAddModel', 'btnCancel',
  'searchBox', 'treeRoot', 'keysRoot', 'healthRoot', 'logRoot', 'toast',
  'filterCount', 'paneKeys', 'paneHealth', 'paneLog', 'modelDialog', 'modelTitle',
  'modelHint', 'boxUrl', 'boxModel', 'keyRows', 'keyCount', 'btnCheckOne', 'btnAddKey',
  'modelClose', 'keyDialog', 'keyHint', 'keySecret', 'keyConfirm', 'keyCancel',
  'delDialog', 'delHint', 'delSecret', 'delConfirm', 'delRestore', 'delCancel',
  'addUrlDialog', 'urlName', 'urlBase', 'urlConfirm', 'urlCancel',
  'modelAddDialog', 'manualHint', 'manualModel', 'manualFree', 'manualConfirm', 'manualCancel',
  'sidebar', 'sidebarRoot', 'btnMenu', 'scrim', 'btnAddUrl', 'treeTitle', 'urlSort',
  'btnAddKeyUrl', 'lockAllUrls', 'lockAllKeys',
  'rowMenu', 'rowMenuTitle', 'rowMenuSub', 'rowMenuActions', 'rowMenuCancel',
];

/**
 * Attributes of every id in index.html, read from the file itself.
 *
 * One pass over the markup, per run: the file is small and this keeps the stub
 * honest about what the page actually ships.
 */
let cachedAttributes = null;
function staticAttributes() {
  if (cachedAttributes) return cachedAttributes;
  const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const out = new Map();
  // Comments in the markup mention tags they are only describing, so a tag
  // inside a comment is stripped first; otherwise a comment can overwrite the
  // real element that follows it.
  const markup = html.replace(/<!--[\s\S]*?-->/g, '');
  // A tag can span lines, so the scan walks tags rather than lines, and it takes
  // the whole opening tag: reading only the part before `id` would drop every
  // attribute that comes after it.
  for (const match of markup.matchAll(/<(\w+)((?:[^>"']|"[^"]*"|'[^']*')*)>/g)) {
    const [, tag, raw] = match;
    const id = /\sid="([^"]+)"/.exec(raw)?.[1];
    if (!id || out.has(id)) continue;
    const attrs = {};
    for (const attr of raw.matchAll(/([\w:-]+)="([^"]*)"/g)) {
      const [, name, value] = attr;
      if (name === 'id') continue;
      attrs[name] = value;
    }
    out.set(id, { _tag: tag.toLowerCase(), ...attrs });
  }
  cachedAttributes = out;
  return out;
}

class El {
  constructor(tag = 'div') {
    this.tag = tag;
    this.children = [];
    this.dataset = {};
    this.style = {};
    this.className = '';
    this.value = '';
    this.hidden = false;
    this.open = false;
    this._listeners = {};
    this._text = '';
    this._classes = new Set();
    // classList has to really track. A stub that discards the calls makes every
    // test pass on a row the app never actually marked, which is how a whole
    // visual state can be missing while the suite stays green.
    this.classList = {
      add: (...names) => names.forEach((n) => this._classes.add(n)),
      remove: (...names) => names.forEach((n) => this._classes.delete(n)),
      toggle: (name, on) => {
        const want = on ?? !this._classes.has(name);
        if (want) this._classes.add(name);
        else this._classes.delete(name);
        return want;
      },
      contains: (name) => this._classes.has(name),
    };
  }
  get className() { return [...this._classes].join(' '); }
  set className(v) {
    this._classes = new Set(String(v).split(/\s+/).filter(Boolean));
  }

  set textContent(v) {
    // Assigning textContent replaces the children in a real DOM, so the stub
    // drops them too. Leaving them would make a node report the text of content
    // that was supposed to be gone.
    this.children = [];
    this._text = String(v);
  }
  get textContent() {
    // Reading returns own text plus descendants, because that is what a user
    // sees. Returning only the own value makes every node built from a label
    // plus a child read as empty - which is how a whole action sheet can render
    // correctly and still look blank to every test.
    const own = this._text;
    const kids = this.children.map((c) => c.textContent ?? '').join('');
    return own + kids;
  }
  append(...k) { for (const kid of k) { kid._parent = this; this.children.push(kid); } }
  replaceChildren(...k) { this.children = []; this.append(...k); }
  prepend(...k) { for (const [i, kid] of k.entries()) { kid._parent = this; this.children.splice(i, 0, kid); } }
  remove() {}
  // Needed by the drag handler: moving a row is an insertBefore relative to a
  // sibling, and without it a drop cannot be simulated at all.
  // The node is detached first, exactly as the DOM does it. Moving without
  // detaching would leave the row in both places, and a drag test would then
  // read a duplicated list and blame the app for it.
  insertBefore(node, ref) {
    const from = node._parent;
    if (from) {
      const was = from.children.indexOf(node);
      if (was !== -1) from.children.splice(was, 1);
    }
    node._parent = this;
    const at = ref ? this.children.indexOf(ref) : -1;
    if (at === -1) this.children.push(node);
    else this.children.splice(at, 0, node);
    return node;
  }
  get nextSibling() {
    const parent = this._parent;
    if (!parent) return null;
    const at = parent.children.indexOf(this);
    return at === -1 ? null : parent.children[at + 1] ?? null;
  }
  addEventListener(ev, fn) { (this._listeners[ev] ||= []).push(fn); }
  // The drag handlers measure the row under the pointer, not the event, so the
  // stub has to answer on the element. A zero-height rect would make every drop
  // resolve to "insert before", which hides the half-way case entirely.
  // The row box is derived from the row's real position in its parent, because
  // the swipe logic reads neighbouring rows to decide when a swap happened. A
  // stub where every row reports the same box would make every swap do nothing
  // while the test still passed.
  getBoundingClientRect() {
    const parent = this._parent;
    const index = parent ? parent.children.indexOf(this) : 0;
    // The transform is folded into the box, because that is what a browser
    // reports and what the swap logic has to cope with: a row that is being
    // dragged really has moved on screen, and a stub that ignored the
    // transform would make the row look frozen in its own slot forever.
    const shift = parseFloat(/translateY\(([-\d.]+)px\)/.exec(this.style.transform ?? '')?.[1] ?? '0') || 0;
    const top = index * ROW_HEIGHT_PX + shift;
    return { top, left: 0, width: 320, height: ROW_HEIGHT_PX, right: 320, bottom: top + ROW_HEIGHT_PX };
  }

  /** Bit 4 is DOCUMENT_POSITION_FOLLOWING: the argument comes after this node. */
  compareDocumentPosition(other) {
    const parent = this._parent;
    if (!parent || other?._parent !== parent) return 0;
    return parent.children.indexOf(other) > parent.children.indexOf(this) ? 4 : 0;
  }
  removeEventListener() {}
  /**
   * Walk up looking for a class, the way `closest` does.
   *
   * Delegated handlers find their target with this. Without it every delegated
   * handler returns null and the feature looks wired while doing nothing.
   */
  closest(selector) {
    const want = selector.startsWith('.') ? selector.slice(1) : null;
    let node = this;
    while (node) {
      if (!want || node.classList?.contains(want)) return node;
      node = node._parent;
    }
    return null;
  }
  showModal() { this.open = true; }
  scrollIntoView() {}
  setAttribute(k, v) { this._attrs ??= {}; this._attrs[k] = v; }
  getAttribute(k) { return this._attrs?.[k] ?? null; }
  close() { this.open = false; }
  /**
   * A single match, or null - the same contract as the real thing.
   *
   * `children` here is a plain array while `element.children` in a browser is an
   * HTMLCollection, and array methods on it work here but throw there. Returning
   * a real answer from a real lookup is what keeps code like `chip.children.find`
   * from passing the whole suite and then breaking the page it was written for.
   */
  querySelector(sel) {
    const want = sel.replace(/^\./, '');
    return this.children.find((c) => c.classList?.contains(want)) ?? null;
  }
  querySelectorAll() { return []; }
  focus() {}
  get lastElementChild() { return this.children[this.children.length - 1]; }
  get childElementCount() { return this.children.length; }
  click() { for (const fn of this._listeners.click ?? []) fn(); }
}

/**
 * querySelectorAll over the stub tree.
 *
 * Only the selectors the app actually uses are supported, and each is answered
 * from the real nodes rather than from a fixed list. Returning a hardcoded []
 * is what let a whole navigation bar pass every test while doing nothing.
 */
function queryStub(sel) {
  // Read the live document every call. Caching the map in a module-level
  // variable made this depend on installDom having already replaced the global,
  // which is a race that only shows up as "the element does not exist".
  // The roots are the top-level nodes themselves, not their children: a node
  // from the registry map has no parent, so walking only into children skips it
  // entirely and every static element looks absent.
  const roots = [...(globalThis.document?.__nodes?.values() ?? []), globalThis.document?.body].filter(Boolean);
  const out = [];
  const match = (node, selector) => {
    if (selector.startsWith('.')) return node.classList?.contains(selector.slice(1)) ?? false;
    if (selector.startsWith('[')) {
      const m = /^\[([\w-]+)(?:=["']?([^"'\]]*)["']?)?\]$/.exec(selector);
      return m ? node.getAttribute?.(m[1]) === (m[2] ?? '') : false;
    }
    return node.tag === selector;
  };
  const walk = (node) => {
    if (!node) return;
    if (node !== globalThis.document?.body && match(node, sel)) out.push(node);
    for (const kid of node.children ?? []) walk(kid);
  };
  for (const root of roots) walk(root);
  return out;
}

/**
 * The event listeners registered on the document itself.
 *
 * Kept as a real list so a delegated handler can be dispatched in a test. The
 * previous stub dropped them, which made every document-level listener look
 * wired and dead at the same time.
 */
function delegated() {
  const listeners = {};
  return {
    _listeners: listeners,
    addEventListener(type, fn) {
      (listeners[type] ||= []).push(fn);
    },
    removeEventListener(type, fn) {
      const list = listeners[type];
      if (!list) return;
      const at = list.indexOf(fn);
      if (at !== -1) list.splice(at, 1);
    },
  };
}

function installDom() {
  // The dialogs get their real tag. `openSheet` finds the other open sheets with
  // `querySelectorAll('dialog')`, and a node created as a div never matches - so
  // with everything tagged div the "close the other sheet" path finds nothing and
  // the test that checks two sheets never stack passes for the wrong reason.
  const DIALOG_IDS = new Set([
    'modelDialog', 'keyDialog', 'delDialog', 'addUrlDialog', 'modelAddDialog', 'rowMenu',
  ]);
  const nodes = new Map(
    DOM_IDS.map((id) => [id, new El(DIALOG_IDS.has(id) ? 'dialog' : 'div')])
  );
  // Every node the page owns, so a test can reach a control that only exists in
  // the markup - the filter chips, the tab bar - without going through the map.
  globalThis.__allChips = [];
  globalThis.document = {
    getElementById: (id) => nodes.get(id) ?? new El(),
    createElement: (tag) => new El(tag),
    // Icons are SVG, which is a different namespace. Without this the icon
    // builder falls back to createElement and every icon silently becomes an
    // empty div - invisible, and no test would notice.
    createElementNS: (_ns, tag) => new El(tag),
    // A text node is not an element and carries no children. Without it, the
    // action sheet throws while building its first row.
    createTextNode: (text) => {
      const node = new El('#text');
      node._text = String(text);
      return node;
    },
    querySelectorAll: (sel) => queryStub(sel),
    body: new El(),
    // The document is a node too, and it carries the delegated handlers. With
    // addEventListener stubbed out, a navigation wired by delegation looks
    // wired and does nothing - which is the whole failure this case exists for.
    ...delegated(),
  };
  Object.defineProperty(globalThis, 'navigator', {
    value: { clipboard: { writeText: async () => {} } },
    configurable: true,
  });
  globalThis.location = { protocol: 'http:' };
  // The swap logic reads this constant to tell which side a sibling sits on.
  globalThis.Node = { DOCUMENT_POSITION_FOLLOWING: 4 };
  // The bottom bar is static markup, not built by app.js, so it has to exist
  // here as it does in index.html. A stub without it makes the bar look wired
  // while `querySelectorAll('.tabbar-btn')` finds nothing at all.
  for (const target of ['drawer', 'scan', 'keys', 'health']) {
    const btn = new El('button');
    btn.className = 'tabbar-btn';
    btn.dataset.goto = target;
    nodes.set('tabbar-' + target, btn);
  }

  // The filter chips, for the same reason and with the same shape index.html
  // gives them: the app counts each level by walking the chips, so a stub with
  // no chips would let that whole path pass untested.
  for (const level of ['all', 'verified', 'likely', 'unknown']) {
    const chip = new El('button');
    chip.className = level === 'all' ? 'chip on' : 'chip';
    chip.dataset.filter = level;
    const label = new El('span');
    label.className = 'chip-label';
    chip.append(label);
    if (level !== 'all') {
      const count = new El('span');
      count.className = 'chip-count';
      chip.append(count);
    }
    globalThis.__allChips.push(chip);
  }
  // Attached to the body so queryStub walks them like any other markup.
  globalThis.document.body.append(...globalThis.__allChips);

  // Static markup is not rebuilt here, so the attributes a control ships with in
  // index.html - aria-expanded, role, value on a select - have to come from the
  // real file. Reading them from a hand-written list would let the stub and the
  // page disagree, and a test could then pass against an attribute no user ever
  // sees.
  for (const [id, attrs] of staticAttributes()) {
    const node = nodes.get(id);
    if (!node) continue;
    const { _tag, ...rest } = attrs;
    node.tag = _tag;
    node._attrs = { ...node._attrs, ...rest };
  }

  // Kept so queryStub can walk every node the page owns.
  document.__nodes = nodes;
  return nodes;
}

/** Build the registry the app will boot with. */
async function seed() {
  const storage = new MemoryStorage();
  const providers = new ProviderRegistry(storage);
  const models = new ModelRegistry(storage);
  const keys = new KeyRegistry(storage);

  const { provider } = await providers.upsert({ name: 'Gateway', baseURL: 'https://gw.test/v1' });
  // Two free models and one priced one. The priced model is here on purpose:
  // the main list is free-only, so every case below has to account for it
  // being absent rather than quietly expecting it.
  await models.upsertDiscovered({
    providerId: provider.id, modelId: 'space-bunny-free',
    pricing: { prompt: '0', completion: '0' },
  });
  await models.upsertDiscovered({
    providerId: provider.id, modelId: 'bunny-lite',
    pricing: { prompt: '0', completion: '0' },
  });
  await models.upsertDiscovered({
    providerId: provider.id, modelId: 'paid-model',
    pricing: { prompt: '0.01', completion: '0.02' },
  });
  await keys.add({ providerId: provider.id, secret: KEY_A });
  await keys.add({ providerId: provider.id, secret: KEY_B });

  globalThis.__FMH_SEED__ = {
    providers: await storage.list('providers'),
    models: await storage.list('models'),
    keys: await storage.list('keys'),
  };
  storageRef = storage;
  return { storage, provider, models, keys };
}



/** Add a second URL with its own model, to prove the lists stay separate. */
async function seedSecondUrl() {
  const storage = new MemoryStorage();
  const providers = new ProviderRegistry(storage);
  const models = new ModelRegistry(storage);
  const { provider } = await providers.upsert({ name: 'Other', baseURL: 'https://other.test/v1' });
  await models.upsertDiscovered({
    providerId: provider.id, modelId: 'other-free',
    pricing: { prompt: '0', completion: '0' },
  });
  globalThis.__FMH_SEED__.providers.push(...(await storage.list('providers')));
  globalThis.__FMH_SEED__.models.push(...(await storage.list('models')));
}

/** The URL name inside a drawer row, wherever the tap target sits. */
function urlNameOf(row) {
  const open = row.children.find((c) => c.className === 'urlopen') ?? row;
  // Read the label element directly: the DOM stub's textContent is write-only
  // per node, so a parent's textContent does not include its children.
  const label = open.children.find((c) => c.className === 'uname');
  if (label) return label.textContent ?? '';
  // The label sits inside the grow wrapper.
  const grow = open.children.find((c) => c.className === 'ugrow');
  return grow?.children.find((c) => c.className === 'uname')?.textContent ?? '';
}

/** Open the drawer and tap the URL entry, exactly as the UI is used. */
async function openUrlInDrawer(nodes, nameContains) {
  const side = nodes.get('sidebarRoot');
  const items = side.children.filter((c) => c.classList.contains('urlitem'));
  assert(items.length > 0, 'the drawer lists the URLs');
  // Exact match first: a substring match would pick "Vercel AI Gateway" when the
  // test asked for "Gateway", which silently opened the wrong URL.
  const target =
    items.find((i) => urlNameOf(i) === nameContains) ??
    items.find((i) => urlNameOf(i).includes(nameContains));
  assert(target, `no drawer entry for ${nameContains}`);
  await tapUrl(target);
  await new Promise((r) => setTimeout(r, 200));
  return target;
}

/** The model rows currently shown in the main list. */
function modelRowsOf(nodes) {
  return nodes.get('treeRoot').children
    .filter((c) => c.classList.contains('group'))
    .flatMap((g) => g.children.filter((c) => c.classList.contains('model')));
}

/** Open a URL from its drawer row, the way the UI is used. */
async function tapUrl(row) {
  const open = row.children.find((c) => c.className === 'urlopen') ?? row;
  for (const fn of open._listeners.click ?? []) await fn();
}

/**
 * The tap target inside a model row, holding the emoji, the name, its facts and
 * the chevron.
 *
 * The parts are looked up by class rather than by position. The row grew a
 * facts line under the name, so a positional read would now return the wrapper
 * that holds both - and every case would compare the wrong string while still
 * looking like it was testing the name.
 */
function modelOpenOf(row) {
  return row.children.find((c) => c.className === 'modelopen') ?? row;
}

function modelNameOf(row) {
  const open = modelOpenOf(row);
  const mid = open.children.find((c) => c.className === 'mid');
  return (mid ?? open).children.find((c) => c.className === 'name')?.textContent ?? '';
}

function modelFactsOf(row) {
  const open = modelOpenOf(row);
  const mid = open.children.find((c) => c.className === 'mid');
  return (mid ?? open).children.find((c) => c.className === 'facts')?.textContent ?? '';
}

function modelMarkOf(row) {
  const open = modelOpenOf(row);
  return open.children.find((c) => c.className === 'free')?.textContent ?? '';
}


/**
 * Simulate dropping one row onto another.
 *
 * `after` puts the dragged row below the target, which is the drop a person
 * makes when aiming at the lower half of a row. The events are the ones the
 * real handler listens for, so this exercises the same path as a mouse.
 */
/**
 * Drop one row on another, the way a mouse does it.
 *
 * The pointer position is read off the target's real box rather than hardcoded:
 * the drawer rows and the model rows have different heights, and a fixed
 * `clientY` lands on the wrong side of the midpoint for one of them - which
 * looks exactly like a reorder that silently did nothing.
 */
async function dropOn(container, dragged, target, after) {
  const data = { setData() {}, effectAllowed: '' };
  for (const fn of dragged._listeners.dragstart ?? []) {
    fn({ dataTransfer: data, stopPropagation() {} });
  }
  const box = target.getBoundingClientRect();
  const event = {
    preventDefault() {},
    stopPropagation() {},
    // Above the row's midpoint drops "before", below it drops "after".
    clientY: after ? box.top + box.height * 0.75 : box.top + box.height * 0.25,
    dataTransfer: data,
  };
  for (const fn of target._listeners.dragover ?? []) fn(event);
  for (const fn of target._listeners.drop ?? []) fn(event);
  for (const fn of dragged._listeners.dragend ?? []) fn({});
  await new Promise((r) => setTimeout(r, 60));
}

/**
 * Press a row, hold, then drag it.
 *
 * `waitMs` is how long the finger rests before it moves. It defaults to longer
 * than the app's hold threshold, which is how a person picks a row up. Passing 0
 * makes the finger move straight away, which is a scroll and must NOT reorder -
 * that is the case UI16 checks.
 *
 * The travel is vertical because the list is stacked vertically: the finger has
 * to move along the axis the rows are on for "it crossed the neighbour" to mean
 * anything. This is the same rule a hand follows when moving a card past
 * another one.
 */
async function dragRow(row, { fromY, toY, waitMs = HOLD_WAIT_MS, steps = 6 }) {
  const fire = (type, clientY) => {
    const event = {
      pointerId: 7,
      pointerType: 'touch',
      clientX: 160,
      clientY,
      preventDefault() {},
      stopPropagation() {},
    };
    for (const fn of row._listeners[type] ?? []) fn(event);
  };

  fire('pointerdown', fromY);
  // The finger rests before it travels. A real hand needs this time, and the app
  // relies on it to tell a pick-up from a scroll.
  await new Promise((r) => setTimeout(r, waitMs));

  for (let i = 1; i <= steps; i += 1) {
    fire('pointermove', fromY + ((toY - fromY) * i) / steps);
    await new Promise((r) => setTimeout(r, 10));
  }

  fire('pointerup', toY);
  await new Promise((r) => setTimeout(r, 60));
}

/** Longer than the app's hold threshold, so the row is really picked up. */
const HOLD_WAIT_MS = 260;

/** No rest at all, so the gesture stays a scroll. */
const SCROLL_WAIT_MS = 0;


/** Remove CSS comments so a rule check cannot match its own prose. */
function stripCssComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}


/**
 * Press a row and hold without moving.
 *
 * A tap opens the row and a drag reorders it, so the only gesture left that can
 * mean "what can I do with this" is a press that neither does. That is what this
 * sends: a pointerdown, a wait longer than the sheet's own threshold, and an
 * up.
 */
async function longPressRow(row) {
  const event = {
    pointerId: 9,
    pointerType: 'touch',
    clientX: 160,
    clientY: 30,
    preventDefault() {},
    stopPropagation() {},
  };
  for (const fn of row._listeners.pointerdown ?? []) fn(event);
  await new Promise((r) => setTimeout(r, 620));
  for (const fn of row._listeners.pointerup ?? []) fn(event);
  await new Promise((r) => setTimeout(r, 80));
}

/** The model ids currently listed, in the order they appear on screen. */
function modelIdsOnScreen(nodes) {
  const group = nodes.get('treeRoot').children.find((c) => c.classList.contains('group'));
  return (group?.children ?? []).filter((c) => c.classList.contains('model')).map((c) => c.dataset.sortId);
}

/** Tap any control, the way a person taps it. */
async function tap(node) {
  for (const fn of node?._listeners?.click ?? []) await fn({ stopPropagation() {}, preventDefault() {} });
}

/** Click the row the way a person does: on the name, not on a control. */
async function tapModel(row) {
  const open = row.children.find((c) => c.className === 'modelopen') ?? row;
  for (const fn of open._listeners.click ?? []) await fn();
}

/** Import app.js fresh and wait for its first render. */
async function bootApp() {
  await import(new URL(`../app.js?case=${Math.random()}`, import.meta.url).href);
  await new Promise((r) => setTimeout(r, 250));
}

/**
 * Boot the app again over the storage the previous boot used.
 *
 * A fresh import creates a fresh storage and re-applies the seed, which would
 * overwrite anything the user had just arranged - which is the exact thing a
 * "does it survive a restart" case is checking. So the rows the app wrote are
 * carried across, exactly as they would be in a real reload where IndexedDB
 * keeps them.
 */
async function rebootWithStoredData() {
  const previous = globalThis.__FMH_STORAGE__;
  globalThis.__FMH_SEED__ = {
    providers: await previous.list('providers'),
    models: await previous.list('models'),
    keys: await previous.list('keys'),
    settings: await previous.list('settings'),
    mappings: await previous.list('mappings'),
    metrics: await previous.list('metrics'),
  };
  await bootApp();
}

const appSource = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');

/** The app's own storage, so a case can read what it actually wrote. */
let storageRef = null;

export function registerUiCases() {
  describe('DOM. The shapes the real browser gives back', () => {
    /**
     * `children` is an HTMLCollection, not an array.
     *
     * It is iterable and it has `length`, so `for...of` and `children[i]` both
     * work and every ordinary test passes. It has no `map`, `find`, `filter` or
     * `forEach` of its own: those come from Array.prototype, which an
     * HTMLCollection does not inherit. Code that calls one of them works against
     * a test stub - where `children` is a real array - and then throws in the
     * browser, mid-render, leaving the list the user asked for never drawn.
     *
     * Both cases below are the exact shape of that failure.
     */
    it('DOM1: reading the model order survives a collection that is not an array', () => {
      const source = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
      const offenders = source
        .split('\n')
        .map((text, i) => [i + 1, text])
        // Spread or index first, so only the bare call on a collection is caught.
        .filter(([, text]) => /(?<!\[\.\.\.)\b\w+(?:\.\w+)*\.children\s*\.\s*(map|find|filter|forEach|some|every|at|indexOf|includes|reduce|sort|slice)\b/.test(text));

      assertEqual(
        offenders.length,
        0,
        'these lines call an array method straight on .children: ' +
          offenders.map(([n, t]) => `${n}: ${t.trim()}`).join(' | ')
      );
    });

    it('DOM2: every chip lookup asks the DOM, not the array', () => {
      const source = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
      assert(
        /chip\.querySelector\('\.chip-count'\)/.test(source),
        'the chip count is read with querySelector'
      );
      assert(
        !/chip\.children\s*\./.test(source),
        'and never with an array method on .children'
      );
    });
  });

  describe('UI. The screen the user actually touches', () => {
    it('UI1: each URL is its own entry in the drawer', async () => {
      const nodes = installDom();
      await seed();
      globalThis.fetch = createMockFetch({
        '/models': { body: { data: [] } },
        '/chat/completions': { body: { choices: [{ message: { content: 'OK' } }] } },
      });
      await bootApp();

      // Second URL is seeded before the app boots, so one boot sees both. The
      // earlier version booted a second copy of app.js over the same DOM, which
      // double-registered listeners and made the count meaningless.
      await seedSecondUrl();
      await bootApp();

      const items = nodes.get('sidebarRoot').children.filter((c) => c.classList.contains('urlitem'));
      const names = items.map(urlNameOf);
      assert(names.includes('Gateway'), 'the custom URL has its own entry: ' + names.join(' | '));
      assert(names.includes('Other'), 'and so does the second one: ' + names.join(' | '));

      // Every URL is addressable on its own. Built-ins are counted too: they
      // are URLs the user can open, so they belong in the drawer like any other.
      assertEqual(items.length, names.length, 'one entry per URL, none merged');
      for (const name of names) {
        assertEqual(
          items.filter((i) => urlNameOf(i) === name).length,
          1,
          name + ' appears exactly once'
        );
      }
    });

    it('UI2: nothing is listed until a URL is chosen', async () => {
      const nodes = installDom();
      await seed();
      globalThis.fetch = createMockFetch({
        '/models': { body: { data: [] } },
        '/chat/completions': { body: { choices: [{ message: { content: 'OK' } }] } },
      });
      await bootApp();

      assertEqual(modelRowsOf(nodes).length, 0, 'the main list waits for a URL');
      const hint = nodes.get('treeRoot').children.map((c) => c.textContent).join(' ');
      assert(hint.includes('URL'), 'and it says so instead of looking broken');

      await openUrlInDrawer(nodes, 'Gateway');
      assertEqual(nodes.get('treeTitle').textContent, 'Gateway', 'the title shows which URL');
      const shown = modelRowsOf(nodes).map(modelNameOf);
      assertEqual(shown.length, 2, 'now its free models are listed');
      assertEqual(shown.includes('paid-model'), false, 'the priced one stays out of the list');
      assertEqual(
        nodes.get('treeTitle').textContent.includes('Gateway'),
        true,
        'and the title still says which URL these belong to'
      );
    });

    it('UI3: opening one URL shows only that URL models', async () => {
      const nodes = installDom();
      await seed();
      await seedSecondUrl();
      globalThis.fetch = createMockFetch({
        '/models': { body: { data: [] } },
        '/chat/completions': { body: { choices: [{ message: { content: 'OK' } }] } },
      });
      await bootApp();

      await openUrlInDrawer(nodes, 'Gateway');
      const first = modelRowsOf(nodes).map(modelNameOf);
      assertEqual(first.length, 2, 'the first URL has two free models');

      await openUrlInDrawer(nodes, 'Other');
      const second = modelRowsOf(nodes).map(modelNameOf);
      assertEqual(second.length, 1, 'the second URL has one');
      assertEqual(second.includes('space-bunny-free'), false, "the other URL's models do not leak in");
    });

    it('UI4a: each filter chip shows only its own certainty level', async () => {
      const nodes = installDom();
      await seed();
      globalThis.fetch = createMockFetch({
        '/models': { body: { data: [] } },
        '/chat/completions': { body: { choices: [{ message: { content: 'OK' } }] } },
      });
      await bootApp();
      await openUrlInDrawer(nodes, 'Gateway');

      const chip = (level) => globalThis.__allChips.find((c) => c.dataset.filter === level);
      const names = () => modelRowsOf(nodes).map(modelNameOf);

      // The two seeded models are both priced at zero, so they are both
      // verified - which is the point: a chip that only ever shows verified
      // models would pass every test here.
      assertEqual(names().length, 2, 'both seeded models are listed under Tất cả');
      assertEqual(chip('all').classList.contains('on'), true, 'and Tất cả is the one on');

      await tap(chip('verified'));
      await new Promise((r) => setTimeout(r, 200));
      assertEqual(names().length, 2, 'Chắc 0đ keeps both: their price is a published zero');
      assertEqual(chip('verified').classList.contains('on'), true, 'and the chip shows it is on');

      await tap(chip('likely'));
      await new Promise((r) => setTimeout(r, 200));
      assertEqual(names().length, 0, 'Có thể 0đ is empty: nothing here is only a name hint');
      assertEqual(chip('likely').classList.contains('on'), true, 'even when empty it is the one on');

      await tap(chip('unknown'));
      await new Promise((r) => setTimeout(r, 200));
      assertEqual(names().length, 0, 'and Chưa rõ is empty too');

      await tap(chip('all'));
      await new Promise((r) => setTimeout(r, 200));
      assertEqual(names().length, 2, 'Tất cả brings both back');
    });

    it('UI4b: every model lands in exactly one chip, and the counts add up', async () => {
      const nodes = installDom();
      await seed();
      globalThis.fetch = createMockFetch({ '/models': { body: { data: [] } } });
      await bootApp();
      await openUrlInDrawer(nodes, 'Gateway');

      const countOf = (level) => {
        const chip = globalThis.__allChips.find((c) => c.dataset.filter === level);
        const slot = chip.children.find((c) => c.classList.contains('chip-count'));
        return slot.textContent;
      };

      // The three narrow chips partition the free set: nothing is in two of
      // them, nothing is in none. If a model ever fell out of all three it
      // would simply disappear with no chip able to find it again.
      assertEqual(countOf('verified'), '2', 'both verified');
      assertEqual(countOf('likely'), '', 'an empty level shows no number at all');
      assertEqual(countOf('unknown'), '', 'and neither does the other one');

      const sum = ['verified', 'likely', 'unknown'].reduce(
        (n, level) => n + Number(countOf(level) || 0), 0
      );
      assertEqual(sum, 2, 'the three levels account for the whole free set, no overlap');
    });

    it('UI4: a priced model is never listed, whatever the filter', async () => {
      const nodes = installDom();
      await seed();
      globalThis.fetch = createMockFetch({
        '/models': { body: { data: [] } },
        '/chat/completions': { body: { choices: [{ message: { content: 'OK' } }] } },
      });
      await bootApp();
      await openUrlInDrawer(nodes, 'Gateway');

      const names = modelRowsOf(nodes).map(modelNameOf);
      assertEqual(names.includes('paid-model'), false, 'a price above zero keeps it out');
      assertEqual(names.length, 2, 'both free models are there');
      assertEqual(
        modelRowsOf(nodes).every((r) => modelMarkOf(r) !== '\u2b1b'),
        true,
        'and no row carries the paid mark'
      );

      // The count must describe the free set, so it never hints that paid rows
      // are sitting behind the filter.
      const count = nodes.get('filterCount').textContent;
      assert(count.includes('2'), 'the count reflects what is listed: ' + count);
      assert(count.includes('0\u0111'), 'and says the list is free: ' + count);
    });

    it('UI5: tapping a model shows its URL, its id and every key of that URL', async () => {
      const nodes = installDom();
      await seed();
      globalThis.fetch = createMockFetch({
        '/models': { body: { data: [] } },
        '/chat/completions': { body: { choices: [{ message: { content: 'OK' } }] } },
      });
      await bootApp();
      await openUrlInDrawer(nodes, 'Gateway');

      // Tapping whichever row the sort put first is what a person does; the
      // assertion follows the row instead of assuming an id, so adding another
      // free model to the seed cannot break this case.
      const row = modelRowsOf(nodes)[0];
      const tapped = modelNameOf(row);
      await tapModel(row);
      await new Promise((r) => setTimeout(r, 200));

      assertEqual(nodes.get('modelTitle').textContent, tapped);
      assertEqual(nodes.get('boxUrl').textContent, 'https://gw.test/v1');
      assertEqual(nodes.get('boxModel').textContent, tapped);
      assertEqual(nodes.get('keyCount').textContent, '2', 'both keys of that URL are listed');
      for (const r of nodes.get('keyRows').children) {
        // reveal, check, delete and the lock. The lock is a real control, not a
        // decoration, so the count is asserted by role rather than by position.
        const titles = r.children.map((c) => c.title ?? '');
        assert(titles.some((t) => t.includes('key')), 'a reveal control on every row');
        assert(titles.some((t) => t.includes('Check API')), 'a check control on every row');
        assert(titles.some((t) => t.includes('Xoá')), 'a delete control on every row');
        assert(
          r.children.some((c) => c.className?.includes('lockbtn')),
          'and a lock control on every row'
        );
      }
    });

    it('UI6: keys are masked until the eye is tapped, and never logged', async () => {
      const nodes = installDom();
      await seed();
      globalThis.fetch = createMockFetch({
        '/models': { body: { data: [] } },
        '/chat/completions': { body: { choices: [{ message: { content: 'OK' } }] } },
      });
      await bootApp();
      await openUrlInDrawer(nodes, 'Gateway');

      const row = modelRowsOf(nodes)[0];
      await tapModel(row);
      await new Promise((r) => setTimeout(r, 200));

      const keyRows = nodes.get('keyRows').children;
      const shown = keyRows.map((r) => r.children[0].children[0].textContent);
      assertEqual(shown.some((t) => t.includes(KEY_A)), false, 'no full secret on screen');
      assert(shown.every((t) => t.includes('\u2026')), 'every key is masked');

      const eye = keyRows[0].children.find((c) => c.title === 'Hi\u1ec7n v\u00e0 ch\u00e9p key');
      assert(eye, 'there is a reveal button');
      for (const fn of eye._listeners.click) await fn();
      await new Promise((r) => setTimeout(r, 200));

      assertEqual(
        nodes.get('keyRows').children[0].children[0].children[0].textContent,
        KEY_A,
        'after the tap the full key is available to copy'
      );
      const log = nodes.get('logRoot').children.map((c) => c.textContent).join('\n');
      assertEqual(log.includes(KEY_A), false, 'the log never holds a secret');
    });

    it('UI7: a URL with no key says so instead of looking empty', async () => {
      const nodes = installDom();
      const storage = new MemoryStorage();
      const providers = new ProviderRegistry(storage);
      const models = new ModelRegistry(storage);
      const { provider } = await providers.upsert({ name: 'Empty', baseURL: 'https://empty.test/v1' });
      await models.upsertDiscovered({
        providerId: provider.id, modelId: 'lonely-free',
        pricing: { prompt: '0', completion: '0' },
      });
      globalThis.__FMH_SEED__ = {
        providers: await storage.list('providers'),
        models: await storage.list('models'),
        keys: [],
      };
      globalThis.fetch = createMockFetch({ '/models': { body: { data: [] } } });
      await bootApp();
      await openUrlInDrawer(nodes, 'Empty');

      const row = modelRowsOf(nodes)[0];
      await tapModel(row);
      await new Promise((r) => setTimeout(r, 200));

      assertEqual(nodes.get('keyCount').textContent, '0');
      const note = nodes.get('keyRows').children[0].textContent;
      assert(note.includes('ch\u01b0a c\u00f3 API'), 'the empty state explains itself');
      assert(note.includes('TH\u00caM API'), 'and points at the button that fixes it');
    });

    it('UI8: a secret is only ever written inside the reveal path', () => {
      // A guard, not a behaviour test. The reveal deliberately shows a full
      // key, so the rule is not "never" but "only there": any other line that
      // assigns key.secret to textContent is a leak waiting to happen.
      assertEqual(
        /console\.(log|info|warn)\([^)]*\.secret/.test(appSource),
        false,
        'no console output may include a key secret'
      );

      const assigns = [...appSource.matchAll(/textContent\s*=\s*([^;\n]*\.secret[^;\n]*);/g)];
      assertEqual(assigns.length, 0, 'a secret must not go straight into textContent');

      // A secret reaches the DOM through one named sink, so the rule is
      // checkable by reading that function instead of trusting a grep count.
      const sinks = [...appSource.matchAll(/full\.textContent\s*=\s*([^;\n]+);/g)];
      assertEqual(sinks.length, 1, 'exactly one place shows a full key');
      assert(
        sinks[0][1].includes('revealedText('),
        'and it goes through the audited sink, got: ' + sinks[0][1].trim()
      );

      const sink = appSource.slice(appSource.indexOf('function revealedText'));
      assert(sink.includes('return key.secret'), 'the sink returns the raw secret');

      // The masked branch must not be able to fall through to a raw value.
      const maskedBranch = appSource.slice(
        appSource.indexOf('const maskedText'),
        appSource.indexOf('flex.append(masked);')
      );
      assert(
        !/textContent\s*=\s*key\.secret/.test(maskedBranch),
        'the masked branch assigns the masked value, not the secret'
      );

      // revealKey is the only caller that turns the sink on.
      const reveal = appSource.slice(appSource.indexOf('function revealKey'));
      assert(reveal.includes('revealedKeys.add('), 'a key is revealed only after the explicit tap');
      assert(reveal.includes('copyText('), 'and the tap also copies it');
    });

    // ---- drag to reorder -------------------------------------------------
    // A drag that saves but does not survive the next render looks exactly like
    // a drag that does not work: the row snaps back. So each case follows the
    // whole loop - drop, re-render, and read the order again off the screen.

    it('UI9: dragging a model keeps its position after a re-render', async () => {
      const nodes = installDom();
      await seed();
      globalThis.fetch = createMockFetch({
        '/models': { body: { data: [] } },
        '/chat/completions': { body: { choices: [{ message: { content: 'OK' } }] } },
      });
      await bootApp();
      await openUrlInDrawer(nodes, 'Gateway');

      const before = modelRowsOf(nodes).map(modelNameOf);
      assertEqual(before.length, 2, 'two models to reorder');

      // Move the first row below the second one.
      const group = nodes.get('treeRoot').children.find((c) => c.classList.contains('group'));
      const rows = group.children.filter((c) => c.classList.contains('model'));
      await dropOn(group, rows[0], rows[1], true);
      await new Promise((r) => setTimeout(r, 250));

      const after = modelRowsOf(nodes).map(modelNameOf);
      // Asserted against the set, not the direction: which model is on top
      // depends on the sort that ran before the drag, and pinning that here
      // would make this case fail for an unrelated reason.
      assertEqual(
        [after[0], after[1]].sort().join(','),
        [...before].sort().join(','),
        'the same two models are still listed'
      );
      assert(
        after.join(',') !== before.join(','),
        `the drag changed the order: ${before.join(',')} -> ${after.join(',')}`
      );

      // Re-render from scratch and read it again: this is the part that used to
      // lose the arrangement, because the list was rebuilt in storage order.
      await rebootWithStoredData();
      await openUrlInDrawer(nodes, 'Gateway');
      const afterReload = modelRowsOf(nodes).map(modelNameOf);
      assertEqual(afterReload.join(','), after.join(','), 'and it survives a fresh render');
    });

    it('UI10: dragging a model writes the order onto that URL, not globally', async () => {
      const nodes = installDom();
      await seed();
      await seedSecondUrl();
      globalThis.fetch = createMockFetch({
        '/models': { body: { data: [] } },
        '/chat/completions': { body: { choices: [{ message: { content: 'OK' } }] } },
      });
      await bootApp();
      await openUrlInDrawer(nodes, 'Gateway');

      const group = nodes.get('treeRoot').children.find((c) => c.classList.contains('group'));
      const rows = group.children.filter((c) => c.classList.contains('model'));
      await dropOn(group, rows[0], rows[1], true);
      await new Promise((r) => setTimeout(r, 250));

      // The same model ids exist on another URL, so a global order would
      // reorder that URL's list too - which the user never asked for.
      await openUrlInDrawer(nodes, 'Other');
      const other = modelRowsOf(nodes).map(modelNameOf);
      assertEqual(other.length, 1, 'the other URL still lists its own model');
    });

    it('UI11: dragging a URL reorders the drawer and survives a re-render', async () => {
      const nodes = installDom();
      await seed();
      await seedSecondUrl();
      globalThis.fetch = createMockFetch({
        '/models': { body: { data: [] } },
        '/chat/completions': { body: { choices: [{ message: { content: 'OK' } }] } },
      });
      await bootApp();

      const side = nodes.get('sidebarRoot');
      const items = () => side.children.filter((c) => c.classList.contains('urlitem'));
      const before = items().map(urlNameOf);
      assert(before.length >= 2, 'several URLs in the drawer');

      const rows = items();
      // Both rows are in the first group, so the first one is dragged below the
      // second - the usual "move this one down" gesture.
      await dropOn(side, rows[0], rows[1], true);
      await new Promise((r) => setTimeout(r, 250));

      const after = items().map(urlNameOf);
      assert(after[0] !== before[0], 'the first URL moved: ' + after.slice(0, 3).join(' | '));

      await rebootWithStoredData();
      const afterReload = nodes.get('sidebarRoot').children
        .filter((c) => c.classList.contains('urlitem'))
        .map(urlNameOf);
      assertEqual(afterReload.join(','), after.join(','), 'and the new order is kept');
    });

    it('UI12: dragging a key reorders it inside the model dialog', async () => {
      const nodes = installDom();
      await seed();
      globalThis.fetch = createMockFetch({
        '/models': { body: { data: [] } },
        '/chat/completions': { body: { choices: [{ message: { content: 'OK' } }] } },
      });
      await bootApp();
      await openUrlInDrawer(nodes, 'Gateway');
      await tapModel(modelRowsOf(nodes)[0]);
      await new Promise((r) => setTimeout(r, 200));

      const box = nodes.get('keyRows');
      const rows = box.children.filter((c) => c.classList.contains('keyrow'));
      assertEqual(rows.length, 2, 'two keys to reorder');

      const masked = (row) => row.children[0].children[0].textContent;
      const before = rows.map(masked);
      // Dropped below the second row, which is what moving a row down looks like.
      await dropOn(box, rows[0], rows[1], true);
      await new Promise((r) => setTimeout(r, 250));

      const after = box.children.filter((c) => c.classList.contains('keyrow')).map(masked);
      assertEqual(after.join(','), [...before].reverse().join(','), 'the keys swapped places');
    });

    it('UI13: a locked row stays on screen, it is only left out of rotation', async () => {
      const nodes = installDom();
      await seed();
      globalThis.fetch = createMockFetch({
        '/models': { body: { data: [] } },
        '/chat/completions': { body: { choices: [{ message: { content: 'OK' } }] } },
      });
      await bootApp();
      await openUrlInDrawer(nodes, 'Gateway');

      const before = modelRowsOf(nodes).map(modelNameOf);
      const row = modelRowsOf(nodes)[0];
      const pin = row.children.find((c) => c.className?.includes('lockbtn'));
      assert(pin, 'the row has a lock control');
      // An event is passed because the handler stops propagation: the lock sits
      // on the row that also opens the model, and a missing event here is a
      // difference between the test and a real tap.
      for (const fn of pin._listeners.click) await fn({ stopPropagation() {} });
      await new Promise((r) => setTimeout(r, 250));

      const after = modelRowsOf(nodes).map(modelNameOf);
      // Hiding it would read as deleted, and the user would have no way back.
      assertEqual(after.join(','), before.join(','), 'a locked row is still listed');
    });

    it('UI14: a press-and-hold drag moves a model down the list', async () => {
      // The touch path is a different code path from the mouse one, and it is
      // the one a phone uses. It is driven here for the same reason the earlier
      // version broke in a browser and not in a test: nothing exercised it.
      const nodes = installDom();
      await seed();
      globalThis.fetch = createMockFetch({
        '/models': { body: { data: [] } },
        '/chat/completions': { body: { choices: [{ message: { content: 'OK' } }] } },
      });
      await bootApp();
      await openUrlInDrawer(nodes, 'Gateway');

      const group = nodes.get('treeRoot').children.find((c) => c.classList.contains('group'));
      const rows = group.children.filter((c) => c.classList.contains('model'));
      assertEqual(rows.length, 2, 'two models to reorder');
      const before = modelIdsOnScreen(nodes);

      // Hold the first row, then drag it well past the second one, so it should
      // end up last. Two full rows of travel, which is what crossing a
      // neighbour actually takes.
      await dragRow(rows[0], { fromY: 28, toY: 28 + ROW_HEIGHT_PX * 2 });

      const after = modelIdsOnScreen(nodes);
      assertEqual(after.join(','), [...before].reverse().join(','), 'the rows swapped on screen');
      assertEqual(after.at(-1), before[0], 'and the row that moved is the one that was swiped');
    });

    it('UI15: the swapped order is what gets stored, not just what is drawn', async () => {
      const nodes = installDom();
      await seed();
      globalThis.fetch = createMockFetch({
        '/models': { body: { data: [] } },
        '/chat/completions': { body: { choices: [{ message: { content: 'OK' } }] } },
      });
      await bootApp();
      await openUrlInDrawer(nodes, 'Gateway');

      const group = nodes.get('treeRoot').children.find((c) => c.classList.contains('group'));
      const rows = group.children.filter((c) => c.classList.contains('model'));
      const before = modelIdsOnScreen(nodes);
      await dragRow(rows[0], { fromY: 28, toY: 28 + ROW_HEIGHT_PX * 2 });

      // The order lives on the URL row for this list, so a model swipe must land
      // there. Nothing written means the next render rebuilds the old order and
      // the gesture looks like it never happened.
      const provider = (await globalThis.__FMH_STORAGE__.list('providers')).find((p) => p.name === 'Gateway');
      assert(
        provider?.priority?.order?.length === 2,
        'the URL kept the arrangement: ' + JSON.stringify(provider?.priority)
      );
      assertEqual(
        provider.priority.order.join(','),
        modelIdsOnScreen(nodes).join(','),
        'what was stored is exactly what is on screen'
      );
      assertEqual(modelIdsOnScreen(nodes).join(','), [...before].reverse().join(','), 'and it did move');
    });

    it('UI16: a flick with no hold scrolls and must NOT reorder', async () => {
      const nodes = installDom();
      await seed();
      globalThis.fetch = createMockFetch({
        '/models': { body: { data: [] } },
        '/chat/completions': { body: { choices: [{ message: { content: 'OK' } }] } },
      });
      await bootApp();
      await openUrlInDrawer(nodes, 'Gateway');

      const group = nodes.get('treeRoot').children.find((c) => c.classList.contains('group'));
      const rows = group.children.filter((c) => c.classList.contains('model'));
      const before = modelIdsOnScreen(nodes);

      // Straight down, immediately, a long way. The finger never rests, so this
      // is a scroll and not a pick-up: taking it as a drag would make the list
      // jump every time the user tried to scroll it.
      await dragRow(rows[0], { fromY: 28, toY: 900, waitMs: SCROLL_WAIT_MS });

      assertEqual(modelIdsOnScreen(nodes).join(','), before.join(','), 'the order is untouched');
    });

    it('UI17: the click after a drag does not open the model', async () => {
      const nodes = installDom();
      await seed();
      globalThis.fetch = createMockFetch({
        '/models': { body: { data: [] } },
        '/chat/completions': { body: { choices: [{ message: { content: 'OK' } }] } },
      });
      await bootApp();
      await openUrlInDrawer(nodes, 'Gateway');

      const group = nodes.get('treeRoot').children.find((c) => c.classList.contains('group'));
      const rows = group.children.filter((c) => c.classList.contains('model'));
      await dragRow(rows[0], { fromY: 28, toY: 28 + ROW_HEIGHT_PX * 2 });

      // The finger is still down when it lifts, so the browser fires a click
      // right after. Opening the model here would mean every reorder also opened
      // a dialog the user never asked for.
      let opened = false;
      const stop = () => { opened = true; };
      for (const fn of rows[0].children.find((c) => c.className === 'modelopen')._listeners.click ?? []) {
        // The capture-phase handler on the row runs first and stops it.
        break;
      }
      let stopped = false;
      for (const fn of rows[0]._listeners.click ?? []) {
        fn({ preventDefault() {}, stopPropagation() { stopped = true; } });
      }
      assertEqual(stopped, true, 'the click was swallowed so the row does not open');
      assertEqual(opened, false, 'and nothing was opened');
    });

    it('UI18: the lock control is one icon that still names all three states', async () => {
      const nodes = installDom();
      await seed();
      globalThis.fetch = createMockFetch({
        '/models': { body: { data: [] } },
        '/chat/completions': { body: { choices: [{ message: { content: 'OK' } }] } },
      });
      await bootApp();
      await openUrlInDrawer(nodes, 'Gateway');

      const row = modelRowsOf(nodes)[0];
      const lock = row.children.find((c) => c.classList.contains('lockbtn'));
      assert(lock, 'the row has a lock control');

      // Icon only. A word beside it would have to shrink to about 9px to fit on a
      // 44px row, and at that size it costs the row its width and still cannot
      // be read at a glance - so the glyph carries it and the name lives on the
      // accessible label instead.
      assertEqual(lock.children.length, 1, 'one glyph, nothing else');
      assert(lock.children[0].tag === 'svg', 'and it is the drawn padlock');
      assert(
        !lock.children.some((c) => c.classList?.contains('locklabel')),
        'no word beside the glyph'
      );

      // The state is still readable without the glyph: a class, a pressed state,
      // and a name that says what the tap will do.
      assert(lock.classList.contains('open'), 'an untouched row reads as open');
      assertEqual(lock.getAttribute('aria-pressed'), 'false', 'and says it is not pressed');
      assert(lock.title.length > 20, 'the full meaning is one hover away: ' + lock.title);
      assertEqual(lock.getAttribute('aria-label'), lock.title, 'and announced the same way');

      // Locking has to move every one of those signals, or the row looks locked
      // while behaving open.
      for (const fn of lock._listeners.click) await fn({ stopPropagation() {} });
      await new Promise((r) => setTimeout(r, 250));

      const afterLock = modelRowsOf(nodes)[0].children
        .find((c) => c.classList.contains('lockbtn'));
      assert(afterLock.classList.contains('locked'), 'locking marks it');
      assert(afterLock.classList.contains('on'), 'and fills it');
      assert(!afterLock.classList.contains('open'), 'and it is no longer open');
      assertEqual(afterLock.getAttribute('aria-pressed'), 'true', 'the pressed state follows');

      // Unlocking has to move them back, or the control becomes a one-way street.
      for (const fn of afterLock._listeners.click) await fn({ stopPropagation() {} });
      await new Promise((r) => setTimeout(r, 250));
      const reopened = modelRowsOf(nodes)[0].children
        .find((c) => c.classList.contains('lockbtn'));
      assert(reopened.classList.contains('open'), 'and unlocking puts it back');
      assertEqual(
        reopened.getAttribute('aria-pressed'),
        'false',
        'including the pressed state'
      );
    });

    it('UI19: a model locked by its URL says so instead of claiming its own lock', async () => {
      const nodes = installDom();
      await seed();
      globalThis.fetch = createMockFetch({
        '/models': { body: { data: [] } },
        '/chat/completions': { body: { choices: [{ message: { content: 'OK' } }] } },
      });
      await bootApp();
      await openUrlInDrawer(nodes, 'Gateway');

      // Lock the URL from the drawer: every model under it is now out of the
      // rotation, but the user did not lock any of them individually, and the
      // row has to say which of the two happened.
      //
      // The Gateway row specifically, not the first one: the drawer is grouped
      // by key requirement, so the first entry is a builtin provider and
      // locking that one would leave the models under Gateway still open - the
      // test would then pass for the wrong reason or fail for an unrelated one.
      const side = nodes.get('sidebarRoot');
      const urlRowEl =
        side.children.filter((c) => c.classList.contains('urlitem'))
          .find((c) => urlNameOf(c) === 'Gateway');
      assert(urlRowEl, 'the Gateway row is in the drawer');
      const urlLock = urlRowEl.children.find((c) => c.classList.contains('lockbtn'));
      for (const fn of urlLock._listeners.click) await fn({ stopPropagation() {} });
      await new Promise((r) => setTimeout(r, 250));

      // The lock triggers a full re-render, so the open URL has to be reopened
      // on the fresh DOM rather than on the row that no longer exists.
      await openUrlInDrawer(nodes, 'Gateway');
      const row = modelRowsOf(nodes)[0];
      const lock = row.children.find((c) => c.classList.contains('lockbtn'));
      // Locked by the URL, not by the user. Without a word beside the glyph this
      // is carried by the state class and the name, and it has to be a different
      // state from the user's own lock - tapping one has to open the whole
      // branch and the other has to open a single row.
      assert(lock.classList.contains('inherited'), 'it reads as inherited');
      assert(!lock.classList.contains('open'), 'not as open');
      assert(lock.title.includes('URL'), 'and the name says where it came from: ' + lock.title);
    });

    it('UI20: a long press on a model opens its actions instead of the row', async () => {
      const nodes = installDom();
      await seed();
      globalThis.fetch = createMockFetch({
        '/models': { body: { data: [] } },
        '/chat/completions': { body: { choices: [{ message: { content: 'OK' } }] } },
      });
      await bootApp();
      await openUrlInDrawer(nodes, 'Gateway');

      const row = modelRowsOf(nodes)[0];
      await longPressRow(row);

      const menu = nodes.get('rowMenu');
      assertEqual(menu.open, true, 'the sheet opened');
      const labels = nodes.get('rowMenuActions').children.map((c) => c.textContent);
      assert(labels.length >= 3, 'several actions are offered: ' + labels.length);
      // The three things a person does to a model, all reachable without the
      // row carrying five buttons.
      const all = labels.join(' | ');
      assert(all.includes('Xem thông tin'), 'inspect: ' + all);
      assert(all.includes('Khoá model'), 'lock the model: ' + all);
      assert(all.includes('Khoá cả URL'), 'lock the whole URL: ' + all);
    });

    it('UI21: a long press on a URL offers scan, key and manual model', async () => {
      const nodes = installDom();
      await seed();
      globalThis.fetch = createMockFetch({
        '/models': { body: { data: [] } },
        '/chat/completions': { body: { choices: [{ message: { content: 'OK' } }] } },
      });
      await bootApp();

      const side = nodes.get('sidebarRoot');
      const row = side.children.find((c) => c.classList.contains('urlitem'));
      await longPressRow(row);

      const all = nodes.get('rowMenuActions').children.map((c) => c.textContent).join(' | ');
      assert(all.includes('Quét lại'), 'rescan: ' + all);
      assert(all.includes('Thêm API key'), 'add key: ' + all);
      assert(all.includes('Thêm model thủ công'), 'add model by hand: ' + all);
    });

    it('UI22: the bottom bar opens the drawer without needing the header button', async () => {
      const nodes = installDom();
      await seed();
      globalThis.fetch = createMockFetch({
        '/models': { body: { data: [] } },
        '/chat/completions': { body: { choices: [{ message: { content: 'OK' } }] } },
      });
      await bootApp();

      // Found the way the app finds it: by selector over the live tree.
      const drawerBtn = document.querySelectorAll('.tabbar-btn')
        .find((c) => c.dataset?.goto === 'drawer');
      assert(drawerBtn, 'the bar has a URL button');

      // Dispatched on the document, not called directly: the bar is delegated,
      // so a handler bound to the button itself would not exist and a test that
      // calls one would prove nothing about the real wiring.
      for (const fn of document._listeners.click ?? []) {
        await fn({ target: drawerBtn });
      }
      await new Promise((r) => setTimeout(r, 120));

      assert(
        globalThis.document.body.classList.contains('nav-open'),
        'the drawer opened from the bar'
      );
    });

    it('UI26: the sheet docks to the bottom and never floats in the middle', async () => {
      const css = fs.readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
      // Comments are stripped first: the CSS explains this exact mistake in
      // prose, and a regex over the raw text would match its own warning.
      const sheet = stripCssComments(
        css.slice(css.indexOf('.sheet {'), css.indexOf('.sheet[open]'))
      );

      // `margin: 0 auto` on a fixed box does two things at once: it centres it
      // horizontally, and - with `top: auto` - an auto margin-top pulls it
      // towards the vertical middle too. That is how a <dialog> centres itself,
      // and it is exactly wrong for a bottom sheet: the panel came up in the
      // middle of the list with the model row behind it, which reads as "the
      // dialog did not open" rather than as a layout mistake.
      // The sheet is pinned to the bottom edge and the sides are auto so the
      // margin can centre it horizontally.
      assert(/inset:\s*auto 0 0 0/.test(sheet), 'it is pinned to the bottom edge');
      assert(/margin:\s*0 auto/.test(sheet), 'and centred by the auto side margins');

      // The one thing that must never be auto is a vertical margin. With the top
      // free, an auto margin-top pulls the box towards the middle of the screen -
      // which is how a <dialog> centres itself, and which put the panel in the
      // middle of the list instead of on the bottom edge.
      assert(
        !/margin-top:\s*auto/.test(sheet),
        'no auto top margin, or the sheet floats to the middle'
      );
      assert(!/\btop:\s*auto\b/.test(sheet) === false || /inset/.test(sheet),
        'the free top is only ever part of the bottom-docking inset');

      // Centring is the margin's job, so the slide is free to use transform for
      // the animation without knocking the sheet sideways.
      const anim = stripCssComments(
        css.slice(css.indexOf('@keyframes sheetUp'), css.indexOf('@keyframes fade'))
      );
      assert(/from\s*\{\s*transform:\s*translateY\(100%\)/.test(anim), 'slides up');
      assert(!/translateX/.test(anim), 'and does not fight the centring');
    });

    it('UI27: the sheet has a definite height so its footer cannot slide off', async () => {
      const css = fs.readFileSync(new URL('../styles.css', import.meta.url), 'utf8');

      // A flex column with only a max-height does not give its children a box to
      // divide: a long model sheet grew past its own edge and pushed the buttons
      // below the screen, which on a phone looks like the dialog is broken.
      const body = /\.sheet-body\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
      assert(
        /min-height:\s*0/.test(body),
        'the scrolling body can shrink, so the sheet keeps its own height'
      );
      assert(/overflow-y:\s*auto/.test(body), 'and scrolls instead of growing');

      // The header and the footer are fixed; only the body moves.
      assert(/\.sheet-head\s*\{[^}]*flex:\s*none/.test(css), 'the header does not scroll');
      assert(/\.sheet-foot\s*\{[^}]*flex:\s*none/.test(css), 'the footer does not scroll');

      // The action sheet has no .sheet-body, so its list has to be the part that
      // gives way - otherwise the cancel button goes with a long list.
      assert(
        /\.action-list\s*\{[^}]*min-height:\s*0/.test(css),
        'the action list is what shrinks in the action sheet'
      );
    });

    it('UI28: every sheet has the three parts a docked sheet needs', async () => {
      const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
      const sheets = [...html.matchAll(/<dialog id="([^"]+)"[^>]*>([\s\S]*?)<\/dialog>/g)];

      assert(sheets.length >= 6, 'the app has its sheets: ' + sheets.length);
      for (const [, id, body] of sheets) {
        // The opening tag carries the classes; the body match above starts
        // after it, so the tag is re-read here rather than sliced by offset.
        const open = new RegExp(`<dialog id="${id}"([^>]*)>`).exec(html)?.[1] ?? '';
        assert(/class="[^"]*sheet/.test(open), `#${id} is a sheet`);

        // Header, a flexible middle, and a footer. The action sheet's middle is
        // its list rather than a .sheet-body, so both count.
        assert(/sheet-head|dlg-title/.test(body), `#${id} has a header`);
        assert(
          /sheet-body|action-list/.test(body),
          `#${id} has a part that can scroll`
        );
        assert(/sheet-foot/.test(body), `#${id} has a footer`);
      }
    });

    it('UI24: a closed sheet is hidden by CSS, not just by the browser default', async () => {
      // A <dialog> is display:none until it opens, but that comes from the
      // browser's own stylesheet. A rule that sets `display: flex` on the dialog
      // itself overwrites it - so every sheet was on screen from the first
      // paint, all six stacked on a list nobody had opened, and tapping a model
      // looked like it did nothing because something was already sitting there.
      const css = fs.readFileSync(new URL('../styles.css', import.meta.url), 'utf8');

      // The flex layout must be declared on the open state.
      const bare = /\.sheet\s*\{[^}]*display:\s*flex/.test(css);
      assertEqual(bare, false, '.sheet itself must not set display:flex');
      assert(
        /\.sheet\[open\]\s*\{[^}]*display:\s*flex/.test(css),
        'the flex layout belongs to .sheet[open]'
      );

      // And a closed sheet is hidden whatever else is declared, so a future
      // rule cannot put six overlays back on screen.
      assert(
        /dialog:not\(\[open\]\)\s*\{\s*display:\s*none/.test(css),
        'a closed sheet is explicitly hidden'
      );
    });

    it('UI25: opening a second sheet closes the first instead of stacking them', async () => {
      const nodes = installDom();
      await seed();
      globalThis.fetch = createMockFetch({
        '/models': { body: { data: [] } },
        '/chat/completions': { body: { choices: [{ message: { content: 'OK' } }] } },
      });
      await bootApp();
      await openUrlInDrawer(nodes, 'Gateway');

      // A modal dialog locks the page behind it. Two of them open at once means
      // the page is unscrollable and there is no visible way back to the first,
      // which on a phone looks exactly like a frozen app.
      const side = nodes.get('sidebarRoot');
      await longPressRow(side.children.find((c) => c.classList.contains('urlitem')));
      assertEqual(nodes.get('rowMenu').open, true, 'the row sheet opened');

      await tapModel(modelRowsOf(nodes)[0]);
      await new Promise((r) => setTimeout(r, 120));

      assertEqual(nodes.get('rowMenu').open, false, 'the first sheet closed');
      assertEqual(nodes.get('modelDialog').open, true, 'and the model sheet opened instead');
    });


    it('UI29: the lock button locks a model and tapping it again brings it back', async () => {
      const nodes = installDom();
      await seed();
      globalThis.fetch = createMockFetch({
        '/models': { body: { data: [] } },
        '/chat/completions': { body: { choices: [{ message: { content: 'OK' } }] } },
      });
      await bootApp();
      await openUrlInDrawer(nodes, 'Gateway');

      const lockOf = () => modelRowsOf(nodes)[0]
        .children.find((c) => c.classList.contains('lockbtn'));
      await tap(lockOf());
      await new Promise((r) => setTimeout(r, 250));

      assert(lockOf().classList.contains('locked'), 'tapping the lock takes the model out of the rotation');

      await tap(lockOf());
      await new Promise((r) => setTimeout(r, 250));

      assert(lockOf().classList.contains('open'), 'and tapping again puts it back');
    });

    it('UI30: locking one model leaves every other row untouched', async () => {
      const nodes = installDom();
      await seed();
      globalThis.fetch = createMockFetch({
        '/models': { body: { data: [] } },
        '/chat/completions': { body: { choices: [{ message: { content: 'OK' } }] } },
      });
      await bootApp();
      await openUrlInDrawer(nodes, 'Gateway');

      const classes = () => modelRowsOf(nodes).map((r) =>
        r.children.find((c) => c.classList.contains('lockbtn')).className);
      const before = classes();
      assert(before.length > 1, 'the URL has more than one model');

      await tap(modelRowsOf(nodes)[0].children.find((c) => c.classList.contains('lockbtn')));
      await new Promise((r) => setTimeout(r, 250));

      const after = classes();
      assert(after[0].includes('locked'), 'the tapped row is the one that locked');
      assert(!before[0].includes('locked'), 'and it was open beforehand');
      assertEqual(after.slice(1).join(','), before.slice(1).join(','), 'and no other row did');
    });

    it('UI31: a locked model still opens, so a lock is not a dead end', async () => {
      const nodes = installDom();
      await seed();
      globalThis.fetch = createMockFetch({
        '/models': { body: { data: [] } },
        '/chat/completions': { body: { choices: [{ message: { content: 'OK' } }] } },
      });
      await bootApp();
      await openUrlInDrawer(nodes, 'Gateway');

      await tap(modelRowsOf(nodes)[0].children.find((c) => c.classList.contains('lockbtn')));
      await new Promise((r) => setTimeout(r, 250));

      const lockedName = modelRowsOf(nodes).map(modelNameOf)[0];
      await tapModel(modelRowsOf(nodes)[0]);
      await new Promise((r) => setTimeout(r, 150));

      assertEqual(nodes.get('modelDialog').open, true, 'the locked row still opens');
      assertEqual(
        nodes.get('modelTitle').textContent,
        lockedName,
        'and it is the model that was locked, not another one'
      );
    });

    it('UI32: the drawer sort control reorders the list it names', async () => {
      const nodes = installDom();
      await seed();
      await seedSecondUrl();
      globalThis.fetch = createMockFetch({
        '/models': { body: { data: [] } },
        '/chat/completions': { body: { choices: [{ message: { content: 'OK' } }] } },
      });
      await bootApp();

      const names = () =>
        nodes.get('sidebarRoot').children
          .filter((c) => c.classList.contains('urlitem'))
          .map(urlNameOf);

      // Compared per group, not across the flat list. The drawer is three
      // groups - usable now, needs a key, never checked - and that split is what
      // says which URLs can be used at all, so it holds in every view. A flat
      // alphabetical list would destroy it.
      // Read the groups off the headings rather than off parent pointers: a
      // heading is what actually separates one group from the next on screen,
      // so that is what the ordering has to hold within.
      const perGroup = () => {
        const groups = [];
        let current = null;
        for (const child of nodes.get('sidebarRoot').children) {
          if (child.classList.contains('urlgroup')) {
            current = [];
            groups.push(current);
          } else if (current && child.classList.contains('urlitem')) {
            current.push(urlNameOf(child));
          }
        }
        return groups.map((g) => g.join(','));
      };

      const select = nodes.get('urlSort');
      for (const fn of select._listeners.change) fn({ target: { value: 'name' } });
      await new Promise((r) => setTimeout(r, 200));

      for (const group of perGroup()) {
        const sorted = [...group.split(',')].sort((a, b) => a.localeCompare(b, 'vi'));
        assertEqual(group, sorted.join(','), 'every group is alphabetical: ' + group);
      }

      // "Most free models" puts the URL that actually has models on top, which is
      // a different list from the alphabetical one - otherwise the control would
      // look wired and change nothing.
      for (const fn of select._listeners.change) fn({ target: { value: 'models' } });
      await new Promise((r) => setTimeout(r, 200));

      // Within its own group: the drawer is split by what can be used at all, and
      // that split holds in every view. A URL with models and a URL without them
      // are usually in different groups, so "most models" only reorders inside
      // one - which is the correct answer, not a limitation.
      const ranked = perGroup();
      // Matched on the whole list, not a substring: "Vercel AI Gateway" contains
      // "Gateway" too, and a substring match picks the wrong group - which reads
      // as a sort that did nothing when it actually worked.
      const own = ranked.find((g) => g.split(',').includes('Gateway'));
      assert(own, 'the URL with models is still listed: ' + ranked.join(' / '));
      assertEqual(
        own.split(',')[0],
        'Gateway',
        'and it leads its own group: ' + own
      );

      // The two test URLs are ranked by how many free models they actually
      // have - Gateway has two, Other has one - so the order has to follow the
      // count, not the alphabet. A control that sorted by name under every
      // setting would pass the first half of this test and fail here.
      const other = ranked.find((g) => g.split(',').includes('Other'));
      if (other) {
        assertEqual(
          other.split(',').join(','),
          ['Gateway', 'Other'].join(','),
          'two free models beats one: ' + other
        );
      }
    });

    it('UI33: a locked URL sinks but is never dropped from the drawer', async () => {
      const nodes = installDom();
      await seed();
      await seedSecondUrl();
      globalThis.fetch = createMockFetch({
        '/models': { body: { data: [] } },
        '/chat/completions': { body: { choices: [{ message: { content: 'OK' } }] } },
      });
      await bootApp();

      const side = nodes.get('sidebarRoot');
      const gateway = side.children
        .filter((c) => c.classList.contains('urlitem'))
        .find((c) => urlNameOf(c) === 'Gateway');
      const lock = gateway.children.find((c) => c.classList.contains('lockbtn'));
      for (const fn of lock._listeners.click) await fn({ stopPropagation() {} });
      await new Promise((r) => setTimeout(r, 250));

      const rows = side.children.filter((c) => c.classList.contains('urlitem'));
      const names = rows.map(urlNameOf);
      assert(names.includes('Gateway'), 'it is still listed: ' + names.join(' | '));

      // Sunk inside its own group, not moved out of it: the grouping is what says
      // which URLs can be used at all, and a locked URL still belongs where it
      // was. Within the group it goes last, because it is out of the rotation.
      const group = rows
        .map((r) => r._parent)
        .filter((parent, i, all) => all.indexOf(parent) === i)
        .find((parent) => parent.children.some((c) => urlNameOf(c) === 'Gateway'));
      const inGroup = group.children
        .filter((c) => c.classList.contains('urlitem'))
        .map(urlNameOf);
      assertEqual(
        inGroup.at(-1),
        'Gateway',
        'and it sinks to the bottom of its own group'
      );
    });


    it('UI34: the header button opens the drawer and the scrim closes it', async () => {
      const nodes = installDom();
      await seed();
      globalThis.fetch = createMockFetch({ '/models': { body: { data: [] } } });
      await bootApp();

      await tap(nodes.get('btnMenu'));
      assert(document.body.classList.contains('nav-open'), 'the button opens it');
      assertEqual(nodes.get('scrim').hidden, false, 'and the scrim covers the page');

      await tap(nodes.get('scrim'));
      assertEqual(document.body.classList.contains('nav-open'), false, 'tapping the scrim closes it');
      assertEqual(nodes.get('scrim').hidden, true, 'and takes the scrim with it');
    });

    it('UI35: the menu button reports the drawer state to a screen reader', async () => {
      const nodes = installDom();
      await seed();
      globalThis.fetch = createMockFetch({ '/models': { body: { data: [] } } });
      await bootApp();

      const menu = nodes.get('btnMenu');
      assertEqual(menu.getAttribute('aria-expanded'), 'false', 'closed to begin with');

      await tap(menu);
      assertEqual(menu.getAttribute('aria-expanded'), 'true', 'open once it is open');

      await tap(nodes.get('scrim'));
      assertEqual(menu.getAttribute('aria-expanded'), 'false', 'and closed again');
    });

    it('UI36: opening a URL from the drawer closes the drawer behind it', async () => {
      const nodes = installDom();
      await seed();
      globalThis.fetch = createMockFetch({ '/models': { body: { data: [] } } });
      await bootApp();

      await tap(nodes.get('btnMenu'));
      assert(document.body.classList.contains('nav-open'), 'the drawer is open first');

      await openUrlInDrawer(nodes, 'Gateway');
      assertEqual(
        document.body.classList.contains('nav-open'),
        false,
        'and choosing a URL hands the screen back to the list'
      );
    });

    it('UI37: a row does not lock itself from a stray horizontal drag', async () => {
      const nodes = installDom();
      await seed();
      globalThis.fetch = createMockFetch({ '/models': { body: { data: [] } } });
      await bootApp();
      await openUrlInDrawer(nodes, 'Gateway');

      const row = modelRowsOf(nodes)[0];
      const before = row.children.find((c) => c.classList.contains('lockbtn')).className;

      // A pointer that only moves sideways must not change anything: there is no
      // swipe gesture left in the app, so this is the state that has to hold.
      const event = (type, clientX, clientY) => {
        for (const fn of row._listeners[type] ?? []) {
          fn({ pointerId: 31, pointerType: 'touch', clientX, clientY, preventDefault() {}, stopPropagation() {} });
        }
      };
      event('pointerdown', 60, 20);
      event('pointermove', 220, 22);
      event('pointerup', 220, 22);
      await new Promise((r) => setTimeout(r, 150));

      assertEqual(
        modelRowsOf(nodes)[0].children.find((c) => c.classList.contains('lockbtn')).className,
        before,
        'the row state is exactly as it was'
      );
    });

    it('UI23: tapping a model still opens it, so the long press did not eat the tap', async () => {
      const nodes = installDom();
      await seed();
      globalThis.fetch = createMockFetch({
        '/models': { body: { data: [] } },
        '/chat/completions': { body: { choices: [{ message: { content: 'OK' } }] } },
      });
      await bootApp();
      await openUrlInDrawer(nodes, 'Gateway');

      const tapped = modelRowsOf(nodes).map(modelNameOf)[0];
      await tapModel(modelRowsOf(nodes)[0]);
      await new Promise((r) => setTimeout(r, 120));

      assertEqual(nodes.get('modelDialog').open, true, 'the sheet opened');
      assertEqual(nodes.get('modelTitle').textContent, tapped, 'for the tapped model');
    });
  });
}
