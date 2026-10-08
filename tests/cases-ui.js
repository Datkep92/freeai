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
  'filterCount', 'paneKeys', 'paneHealth', 'paneLog', 'paneAI', 'modelDialog', 'modelTitle',
  'modelHint', 'boxUrl', 'boxModel', 'keyRows', 'keyCount', 'btnCheckOne', 'btnAddKey',
  'modelClose', 'keyDialog', 'keyHint', 'keySecret', 'keyConfirm', 'keyCancel',
  'delDialog', 'delHint', 'delSecret', 'delConfirm', 'delRestore', 'delCancel',
  'addUrlDialog', 'urlTitle', 'urlHint', 'urlNewOnly',
  'urlName', 'urlBase', 'urlWebsite', 'urlModels', 'urlKey', 'urlConfirm', 'urlCancel',
  'delUrlDialog', 'delUrlHint', 'delUrlWarn', 'delUrlConfirm', 'delUrlCancel',
  'modelAddDialog', 'manualHint', 'manualModel', 'manualFree', 'manualConfirm', 'manualCancel',
  'sidebar', 'sidebarRoot', 'btnMenu', 'scrim', 'btnAddUrl', 'treeTitle', 'urlSort',
  'urlSearch', 'urlSearchClear', 'urlClass', 'urlSortFree', 'sideHint',
  'scopeBar', 'scopeName', 'scopeUrl', 'scopeClear',
  'btnAddKeyUrl', 'lockAllUrls', 'lockAllKeys', 'btnTestModel',
  'testDialog', 'testHint', 'testClose', 'testUrl', 'testModel', 'testKey',
  'testPrompt', 'testResult', 'testRun', 'btnBulk',
  'bulkDialog', 'bulkHint', 'bulkClose', 'bulkUrl', 'bulkKey', 'bulkLimit',
  'bulkCap', 'bulkEstimate', 'bulkRows', 'bulkProgress', 'bulkRun',
  'bulkStop', 'bulkDismiss',
  'chatField', 'chatKeyName', 'chatLog', 'chatInput', 'chatSend', 'chatDelete',
  'keyList', 'keyListAdd', 'keyForm',
  'manualList', 'manualListAdd', 'manualForm',
  'btnExport', 'exportDialog', 'exportHint', 'exportCount', 'exportFormat',
  'exportOut', 'exportCopy', 'exportDownload', 'exportClose', 'exportDone',
  'rowMenu', 'rowMenuTitle', 'rowMenuSub', 'rowMenuActions', 'rowMenuCancel',
  'aiWho', 'aiBudget', 'aiLog', 'aiInput', 'aiSend', 'aiStop', 'aiClear',
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
    // A real <select> with no explicit value reports the first option's value.
    // A stub that always answers '' makes every picker look empty and silently
    // skips the code path the test was written to reach.
    this._value = '';
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
  get value() {
    if (this._value !== '') return this._value;
    const first = this.tag === 'select' ? this.children.find((c) => c.tag === 'option') : null;
    return first ? (first.value ?? '') : '';
  }
  set value(v) { this._value = v == null ? '' : String(v); }

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
    'modelDialog', 'keyDialog', 'delDialog', 'delUrlDialog', 'addUrlDialog', 'modelAddDialog', 'rowMenu',
    'testDialog', 'bulkDialog',
  ]);
  const nodes = new Map(
    DOM_IDS.map((id) => [id, new El(DIALOG_IDS.has(id) ? 'dialog' : 'div')])
  );
  // Every node the page owns, so a test can reach a control that only exists in
  // the markup - the filter chips, the tab bar - without going through the map.
  globalThis.__allChips = [];
  globalThis.__allClasses = [];
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
  for (const target of ['drawer', 'scan', 'keys', 'health', 'ai']) {
    const btn = new El('button');
    btn.className = 'tabbar-btn';
    btn.dataset.goto = target;
    nodes.set('tabbar-' + target, btn);
  }

  // The filter chips, with the names index.html actually ships. The app reads
  // `dataset.filter` and looks the name up in its own filter table, so a stub
  // inventing names would either crash that lookup or quietly stop exercising
  // it - and the chip set is the thing the tests below are about.
  // Everything about a chip comes out of the markup: its filter name, whether it
  // starts selected, and whether it carries a counter. Hardcoding "all" as the
  // selected one made the stub disagree with the page the moment the default chip
  // was renamed, and a chip the app never marked would look unselected while the
  // app believed otherwise.
  const chipBlocks = [...htmlSource.matchAll(/<button[^>]*data-filter="([^"]+)"[\s\S]*?<\/button>/g)];
  const declared = chipBlocks.map((m) => ({
    level: m[1],
    on: /\bclass="[^"]*\bon\b/.test(m[0]),
    count: m[0].includes('chip-count'),
  }));
  for (const { level, on, count: hasCount } of declared.length
    ? declared
    : [{ level: 'free', on: true, count: true }]) {
    const chip = new El('button');
    chip.className = on ? 'chip on' : 'chip';
    chip.dataset.filter = level;
    const label = new El('span');
    label.className = 'chip-label';
    chip.append(label);
    // The app skips a chip with no counter slot, so the stub has to match the
    // markup or the counting path goes untested.
    if (hasCount) {
      const count = new El('span');
      count.className = 'chip-count';
      chip.append(count);
    }
    globalThis.__allChips.push(chip);
  }
  // Attached to the body so queryStub walks them like any other markup.
  globalThis.document.body.append(...globalThis.__allChips);

  // The URL classification buttons, built from the markup for the same reason
  // as the chips: the class name, the selected state and which class a button
  // stands for all come out of index.html, so the stub cannot pass a suite while
  // the page it is standing in for has drifted somewhere else.
  const classBlocks = [...htmlSource.matchAll(/<button[^>]*data-urlclass="([^"]+)"[^>]*>/g)];
  for (const m of classBlocks) {
    const btn = new El('button');
    btn.className = /\bclass="[^"]*\bon\b/.test(m[0]) ? 'classbtn on' : 'classbtn';
    btn.dataset.urlclass = m[1];
    globalThis.__allClasses.push(btn);
  }
  globalThis.document.body.append(...globalThis.__allClasses);

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

/**
 * Add a model that is free by name and publishes no price.
 *
 * Deliberately separate from `seed`, because most cases count the seeded models
 * and this one changes the count. It is the only kind of model that separates
 * "is free" from "is priced at zero", so the chip cases need it and the rest do
 * not.
 */
async function seedNameOnlyModel() {
  const storage = storageRef;
  const provider = (await storage.list('providers'))[0];
  await new ModelRegistry(storage).upsertDiscovered({
    providerId: provider.id, modelId: 'name-only-free',
  });
  globalThis.__FMH_SEED__.models.push(
    ...(await storage.findMany('models', { where: { modelId: 'name-only-free' } }))
  );
}

/**
 * Add a model with no published price and no hint in its name.
 *
 * This is the one level the main list hides on purpose, so it is the only way to
 * prove that hiding is not the same as discarding: the row has to stay reachable
 * behind its own chip.
 */
async function seedUnknownModel() {
  const storage = storageRef;
  const provider = (await storage.list('providers'))[0];
  await new ModelRegistry(storage).upsertDiscovered({
    providerId: provider.id, modelId: 'bi-an-1',
  });
  globalThis.__FMH_SEED__.models.push(
    ...(await storage.findMany('models', { where: { modelId: 'bi-an-1' } }))
  );
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

/**
 * The URL blocks of the main list.
 *
 * The list is flat and holds every URL at once, so one URL stays readable as a
 * block: a sticky header with the URL, then that URL's group of model rows.
 * Every lookup below goes through these helpers, so a change to the nesting
 * cannot leave one case reading the old shape while another reads the new one.
 */
function urlBlocksOf(nodes) {
  return nodes.get('treeRoot').children.filter((c) => c.classList.contains('urlblock'));
}

/** The group of model rows inside one URL's block. */
function modelGroupOf(block) {
  return block?.children.find((c) => c.classList.contains('group'));
}

/** The first URL block, which is the one the drawer's first entry points at. */
function firstBlock(nodes) {
  return urlBlocksOf(nodes)[0];
}

/** The model rows of one URL block. */
function rowsOfBlock(block) {
  return (modelGroupOf(block)?.children ?? []).filter((c) => c.classList.contains('model'));
}

/** Every model row on screen, across every URL. */
function modelRowsOf(nodes) {
  return urlBlocksOf(nodes).flatMap((block) => rowsOfBlock(block));
}

/** One URL's sticky header. */
function blockHeaderOf(block) {
  return block.children.find((c) => c.classList.contains('urlhead'));
}

/** The copy target on a URL header. */
function blockCopyOf(block) {
  return blockHeaderOf(block)?.children.find((c) => c.className === 'urlcopy');
}

/** The ⋮ on a URL header, which opens that URL's own menu. */
function blockMenuOf(block) {
  return blockHeaderOf(block)?.children.find((c) => c.className === 'iconbtn');
}

/**
 * The block whose header mentions this fragment of a URL.
 *
 * The list is flat, so "the models of one URL" has to be said by finding that
 * URL's block. Reading `modelRowsOf(nodes)[0]` would silently mean "the first
 * block", which is whichever URL the rotation happens to put first.
 */
function blockWithUrl(nodes, fragment) {
  return urlBlocksOf(nodes).find((b) => (blockCopyOf(b)?.textContent ?? '').includes(fragment));
}

/** Open a URL from its drawer row, the way the UI is used. */
async function tapUrl(row) {
  const open = row.children.find((c) => c.className === 'urlopen') ?? row;
  for (const fn of open._listeners.click ?? []) await fn();
}

/**
 * Undo a URL pick, the way the bar's button does.
 *
 * A URL tapped in the drawer narrows the list to that URL now, so a case that
 * has to see a second URL again goes through the same control the user would.
 */
async function clearScope(nodes) {
  await tap(nodes.get('scopeClear'));
  await new Promise((r) => setTimeout(r, 200));
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
  return rowsOfBlock(firstBlock(nodes)).map((c) => c.dataset.sortId);
}

/** Tap any control, the way a person taps it. */
async function tap(node) {
  for (const fn of node?._listeners?.click ?? []) await fn({ stopPropagation() {}, preventDefault() {} });
}

/**
 * Open a model's card, the way a person does: on the ⓘ beside its row.
 *
 * Tapping the row itself copies the model id now, so the card is reached from
 * the one control that is not the copy target - which is what the ⓘ is for.
 */
/**
 * Open a model's card, the way a person does: a tap on the row itself.
 *
 * The row stopped copying and started opening the card, so the card is reached
 * the same way as every other row of the app - one tap on the row it belongs
 * to. The ✓ beside it is what runs a check, and that has its own helper.
 */
async function tapModel(row) {
  const open = modelOpenOf(row);
  for (const fn of open._listeners.click ?? []) await fn();
}

/** Tap the row itself. Same target as tapModel; kept for older cases. */
async function tapModelRow(row) {
  const open = modelOpenOf(row);
  for (const fn of open._listeners.click ?? []) await fn();
}

/** Tap the ✓ on a model row, which checks the model against the URL's keys. */
async function tapModelCheck(row) {
  const check = row.children.find((c) => c.className === 'iconbtn' && (c.title ?? '').includes('Check nhanh'));
  for (const fn of check?._listeners?.click ?? []) await fn();
  return check;
}

/** The API chips on a model row, in the order they are drawn. */
function apiChipsOf(row) {
  const box = row.children.find((c) => c.className === 'apichips');
  return box?.children ?? [];
}

/**
 * The URL classification buttons, as index.html ships them.
 *
 * Read from the same markup the stub builds its nodes from, so a class renamed
 * on the page cannot leave a test tapping a button that no longer exists.
 */
function classButton(name) {
  return globalThis.__allClasses.find((b) => b.dataset.urlclass === name);
}

/** Every URL name currently drawn in the drawer, in screen order. */
function drawerNames(nodes) {
  return nodes.get('sidebarRoot').children
    .filter((c) => c.classList.contains('urlitem'))
    .map(urlNameOf);
}

/** One drawer row by the name on it. */
function drawerRow(nodes, name) {
  return nodes
    .get('sidebarRoot')
    .children.find((c) => c.classList.contains('urlitem') && urlNameOf(c) === name);
}

/**
 * Two URLs that a scan has already classified, one of each class.
 *
 * The verdict is what the classification buttons read, so a URL nobody has
 * scanned cannot stand in for either side: it is "chưa kiểm tra", which has no
 * button of its own and is only reachable through "Tất cả".
 */
async function seedClassifiedUrls() {
  const providers = new ProviderRegistry(storageRef);
  const models = new ModelRegistry(storageRef);

  const { provider: open } = await providers.upsert({ name: 'Open Gate', baseURL: 'https://open.test/v1' });
  await providers.update(open.id, { keyRequirement: 'NONE' });
  await models.upsertDiscovered({
    providerId: open.id, modelId: 'open-free',
    pricing: { prompt: '0', completion: '0' },
  });

  const { provider: locked } = await providers.upsert({ name: 'Locked Gate', baseURL: 'https://locked.test/v1' });
  await providers.update(locked.id, { keyRequirement: 'REQUIRED' });
  await models.upsertDiscovered({
    providerId: locked.id, modelId: 'locked-free',
    pricing: { prompt: '0', completion: '0' },
  });

  globalThis.__FMH_SEED__.providers = await storageRef.list('providers');
  globalThis.__FMH_SEED__.models = await storageRef.list('models');
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
const htmlSource = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');

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

    it('UI2: every URL is listed at once, and nothing has to be opened first', async () => {
      const nodes = installDom();
      await seed();
      await seedSecondUrl();
      globalThis.fetch = createMockFetch({
        '/models': { body: { data: [] } },
        '/chat/completions': { body: { choices: [{ message: { content: 'OK' } }] } },
      });
      await bootApp();

      // No picker step. The first paint is the answer to "what can I use for
      // nothing", across every URL the user owns.
      const shown = modelRowsOf(nodes).map(modelNameOf);
      assert(shown.length > 0, 'the list is drawn without opening anything first');
      assertEqual(shown.includes('paid-model'), false, 'and the priced one is never in it');
      assertEqual(
        nodes.get('treeTitle').textContent,
        'Tất cả model 0đ',
        'the title says what the list is rather than which URL'
      );

      // Each URL keeps its own header, so a flat list can still say which URL a
      // row belongs to.
      const heads = urlBlocksOf(nodes).map((b) => blockCopyOf(b)?.textContent ?? '');
      assert(
        heads.some((h) => h.includes('https://gw.test/v1')),
        'the Gateway URL is on its own header: ' + heads.join(' | ')
      );
      assert(
        heads.some((h) => h.includes('https://other.test/v1')),
        'and so is the second URL: ' + heads.join(' | ')
      );
    });

    it('UI3: each URL keeps its own block, and no URL models leak into another', async () => {
      const nodes = installDom();
      await seed();
      await seedSecondUrl();
      globalThis.fetch = createMockFetch({
        '/models': { body: { data: [] } },
        '/chat/completions': { body: { choices: [{ message: { content: 'OK' } }] } },
      });
      await bootApp();

      const first = rowsOfBlock(blockWithUrl(nodes, 'gw.test')).map(modelNameOf);
      assertEqual(first.length, 2, 'the first URL has two free models');

      const second = rowsOfBlock(blockWithUrl(nodes, 'other.test')).map(modelNameOf);
      assertEqual(second.length, 1, 'the second URL has one');
      assertEqual(second.includes('space-bunny-free'), false, "the other URL's models do not leak in");
    });

    it('UI4a: each tab narrows the list to its own claim', async () => {
      const nodes = installDom();
      await seed();
      globalThis.fetch = createMockFetch({
        '/models': { body: { data: [] } },
        '/chat/completions': { body: { choices: [{ message: { content: 'OK' } }] } },
      });
      await bootApp();

      const chip = (level) => globalThis.__allChips.find((c) => c.dataset.filter === level);
      const names = () => modelRowsOf(nodes).map(modelNameOf);

      // The merge is the point: "0đ" and "Chắc 0đ" used to be two chips over
      // overlapping sets. They are one tab now, so there are exactly two.
      assertEqual(globalThis.__allChips.length, 2, 'two tabs: Free and Null');

      // Two free models and one priced one. Both free ones are priced at zero,
      // which is the interesting case: the merged Free tab has to keep them.
      assertEqual(names().length, 2, 'both free models are listed, the priced one is not');
      assertEqual(chip('free').classList.contains('on'), true, 'and Free is the tab that is on');

      // Null is the way back to the models nobody priced. It must not re-admit
      // anything with a price.
      await tap(chip('unknown'));
      await new Promise((r) => setTimeout(r, 200));
      assertEqual(names().length, 0, 'Null holds nothing here, and admits no priced model');
      assertEqual(chip('unknown').classList.contains('on'), true, 'and the tab shows it is on');

      await tap(chip('free'));
      await new Promise((r) => setTimeout(r, 200));
      assertEqual(names().length, 2, 'and Free brings both back');
      assertEqual(chip('free').classList.contains('on'), true, 'and marks itself as the one on');
    });

    it('UI4a2: the merged Free tab keeps a model that is free only by name', async () => {
      // A model whose free status comes from its name rather than a published
      // price is the case the old "Chắc 0đ" chip excluded. Now that the two
      // chips are one, Free must hold it, and Null - which means "price
      // unknown" - must not.
      const nodes = installDom();
      await seed();
      await seedNameOnlyModel();
      globalThis.fetch = createMockFetch({ '/models': { body: { data: [] } } });
      await bootApp();
      await openUrlInDrawer(nodes, 'Gateway');

      const chip = (level) => globalThis.__allChips.find((c) => c.dataset.filter === level);
      const names = () => modelRowsOf(nodes).map(modelNameOf);

      assertEqual(names().length, 3, 'the name-only model is listed too');
      assertEqual(
        names().includes('name-only-free'), true,
        'a model whose name says free is still a model the user can use'
      );

      await tap(chip('unknown'));
      await new Promise((r) => setTimeout(r, 200));
      assertEqual(
        names().includes('name-only-free'), false,
        'and Null, which is only for unknown prices, does not hold it'
      );
      assertEqual(names().length, 0);

      await tap(chip('free'));
      await new Promise((r) => setTimeout(r, 200));
      assertEqual(names().length, 3, 'and Free brings it back');
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

      // Free counts every free model and Null counts the unpriced ones, so the
      // two numbers describe the whole list and nothing behind it. What has to
      // hold is that no tab counts a paid model.
      assertEqual(countOf('free'), '2', 'both models are free');
      assertEqual(countOf('unknown'), '', 'and neither is an unknown price');

      // There is no tab for paid models, and that is deliberate rather than an
      // oversight: a "0đ" list that offered a paid row behind a filter would be
      // offering money for nothing.
      assert(
        !globalThis.__allChips.some((c) => c.dataset.filter === 'paid'),
        'no tab offers paid models'
      );
      assertEqual(globalThis.__allChips.length, 2, 'Free and Null, nothing else');
    });

    it('UI4b2: a chip with nothing behind it shows no number', async () => {
      const nodes = installDom();
      await seed();
      await seedNameOnlyModel();
      globalThis.fetch = createMockFetch({ '/models': { body: { data: [] } } });
      await bootApp();
      await openUrlInDrawer(nodes, 'Gateway');

      const chip = (level) => globalThis.__allChips.find((c) => c.dataset.filter === level);
      const countOf = (level) =>
        chip(level).children.find((c) => c.classList.contains('chip-count')).textContent;


      // The name-only model is free, so it widens Free to three; it is not an
      // unknown price, so Null stays empty and shows no number at all. The
      // numbers have to move with the list, or the tabs and the models on
      // screen disagree.
      assertEqual(countOf('free'), '3', 'all three are free');
      assertEqual(countOf('unknown'), '', 'and none of them is an unknown price');
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
      const group = modelGroupOf(firstBlock(nodes));
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

      const group = modelGroupOf(blockWithUrl(nodes, 'gw.test'));
      const rows = group.children.filter((c) => c.classList.contains('model'));
      await dropOn(group, rows[0], rows[1], true);
      await new Promise((r) => setTimeout(r, 250));

      // A global order would reorder the other URL's list too, which the user
      // never asked for: the same model id can exist on several URLs. The list
      // is narrowed to Gateway after the pick, so step back out to see it.
      await clearScope(nodes);
      const other = rowsOfBlock(blockWithUrl(nodes, 'other.test')).map(modelNameOf);
      assertEqual(other.length, 1, 'the other URL still lists its own model');
      assertEqual(other[0], 'other-free', 'and its order was not rewritten by the first URL');
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

      const group = modelGroupOf(firstBlock(nodes));
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

      const group = modelGroupOf(firstBlock(nodes));
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

      const group = modelGroupOf(firstBlock(nodes));
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

      const group = modelGroupOf(firstBlock(nodes));
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

    it('UI20: a model has no long press left - a tap opens the card, the ✓ is the fast action', async () => {
      const nodes = installDom();
      await seed();
      globalThis.fetch = createMockFetch({
        '/models': { body: { data: [] } },
        '/chat/completions': { body: { choices: [{ message: { content: 'OK' } }] } },
      });
      await bootApp();
      await openUrlInDrawer(nodes, 'Gateway');

      const row = modelRowsOf(nodes)[0];

      // The press that used to open an action sheet must do nothing now: the
      // row's own tap is the card, and the ✓ is the fast action. A sheet here
      // would mean the gesture was never really removed.
      await longPressRow(row);
      assertEqual(nodes.get('rowMenu').open, false, 'no action sheet on a model');

      // The square beside the row is a check, not an info button: its name is
      // what tells the two apart on a row that no longer has either label.
      const check = row.children.find((c) => c.className === 'iconbtn');
      assert(check && check.title.includes('Check nhanh'), 'the row carries a check button: ' + check?.title);

      await tapModel(row);
      await new Promise((r) => setTimeout(r, 120));
      assertEqual(nodes.get('modelDialog').open, true, 'the tap opens the card');
      // The per-model actions that the long press used to hold live on the card.
      const foot = ['btnTestModel', 'btnBulk', 'btnCheckOne'].filter((id) => nodes.get(id));
      assertEqual(foot.length, 3, 'try-this / bulk / check-all are on the card');
    });

    it('UI21: a long press on a URL lists models and APIs instead of separate add buttons', async () => {
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
      assert(all.includes('Quét nhiều model'), 'batch check: ' + all);
      assert(all.includes('Danh sách model free'), 'the model list: ' + all);
      assert(all.includes('Danh sách API'), 'the API list: ' + all);
      // The old separate entries are gone: each list carries its own add, so a
      // third entry for the same job would only make the menu longer.
      assertEqual(all.includes('Thêm API key'), false, 'no separate add-key entry');
      assertEqual(all.includes('Thêm model thủ công'), false, 'no separate add-model entry');
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

    it('UI38: the manual test names the URL, the model and the key before it runs', async () => {
      const nodes = installDom();
      await seed();
      globalThis.fetch = createMockFetch({
        '/models': { body: { data: [] } },
        '/chat/completions': { body: { choices: [{ message: { content: 'OK' } }] } },
      });
      await bootApp();
      await openUrlInDrawer(nodes, 'Gateway');
      await tapModel(modelRowsOf(nodes)[0]);

      await tap(nodes.get('btnTestModel'));
      await new Promise((r) => setTimeout(r, 200));

      assertEqual(nodes.get('testDialog').open, true, 'the test sheet opened');
      // All three parts of the call are on screen before it is made. A test whose
      // target is only visible afterwards cannot be trusted when it fails.
      assertEqual(nodes.get('testUrl').textContent, 'https://gw.test/v1', 'the URL is shown');
      assertEqual(
        nodes.get('testModel').textContent,
        modelRowsOf(nodes).map(modelNameOf)[0],
        'and the model that was tapped'
      );
      assertEqual(nodes.get('testResult').textContent.includes('Chưa chạy'), true, 'and nothing has run yet');

      // Both keys of the URL are offered, each with its status, so picking
      // between two masked keys is not guesswork.
      const options = nodes.get('testKey').children;
      assertEqual(options.length, 2, 'both keys of the URL are listed');
      assert(options[0].textContent.includes('oc_s'), 'each showing its masked form: ' + options[0].textContent);
    });

    it('UI39: running the test sends one request naming that exact model', async () => {
      const nodes = installDom();
      await seed();
      const mock = createMockFetch({
        '/models': { body: { data: [] } },
        '/chat/completions': { body: { choices: [{ message: { content: 'OK' } }] } },
      });
      globalThis.fetch = mock;
      await bootApp();
      await openUrlInDrawer(nodes, 'Gateway');
      await tapModel(modelRowsOf(nodes)[0]);

      const wanted = modelRowsOf(nodes).map(modelNameOf)[0];
      await tap(nodes.get('btnTestModel'));
      await new Promise((r) => setTimeout(r, 200));
      mock.reset();

      await tap(nodes.get('testRun'));
      await new Promise((r) => setTimeout(r, 400));

      const sent = mock.calls.filter((c) => c.url.includes('/chat/completions'));
      assertEqual(sent.length, 1, 'exactly one request: a manual test must not retry');
      assertEqual(
        JSON.parse(sent[0].body).model,
        wanted,
        'and it names the model that was tapped, not the first one on the URL'
      );
      assertEqual(
        nodes.get('testResult').className.includes('testresult-ok'),
        true,
        'the result reads as healthy'
      );
      assert(
        nodes.get('testResult').textContent.includes('Khỏe'),
        'and says so in words, not only in colour: ' + nodes.get('testResult').textContent
      );
    });

    it('UI40: a manual test writes nothing to the key or the model', async () => {
      const nodes = installDom();
      await seed();
      globalThis.fetch = createMockFetch({
        '/models': { body: { data: [] } },
        '/chat/completions': { body: { choices: [{ message: { content: 'OK' } }] } },
      });
      await bootApp();
      await openUrlInDrawer(nodes, 'Gateway');
      await tapModel(modelRowsOf(nodes)[0]);
      await tap(nodes.get('btnTestModel'));
      await new Promise((r) => setTimeout(r, 200));

      const before = await storageRef.list('keys');
      await tap(nodes.get('testRun'));
      await new Promise((r) => setTimeout(r, 400));
      const after = await storageRef.list('keys');

      // A manual test is a question, not a verdict. Overwriting a key's status
      // from one hand-typed prompt would make the health list claim something
      // the app does not actually know.
      assertEqual(
        after.map((k) => k.status).join(','),
        before.map((k) => k.status).join(','),
        'every key keeps the status it had'
      );
    });

    it('UI41: a URL with no key cannot be tested, and says why', async () => {
      const nodes = installDom();
      await seed();
      await seedSecondUrl();
      globalThis.fetch = createMockFetch({ '/models': { body: { data: [] } } });
      await bootApp();
      await tapModel(rowsOfBlock(blockWithUrl(nodes, 'other.test'))[0]);
      await tap(nodes.get('btnTestModel'));
      await new Promise((r) => setTimeout(r, 200));

      assertEqual(nodes.get('testDialog').open, true, 'the sheet still opens');
      // "No keys" and "keys not loaded" must not look the same to someone
      // deciding whether to add a key or wait.
      assertEqual(
        nodes.get('testKey').children[0].textContent,
        'URL này chưa có API key',
        'and the reason is on the key picker'
      );
      assertEqual(nodes.get('testRun').disabled, true, 'the run button is disabled');
    });

    it('UI42: the bulk sheet names the URL and the key before it runs', async () => {
      const nodes = installDom();
      await seed();
      globalThis.fetch = createMockFetch({
        '/models': { body: { data: [] } },
        '/chat/completions': { body: { choices: [{ message: { content: 'OK' } }] } },
      });
      await bootApp();
      await openUrlInDrawer(nodes, 'Gateway');
      await tapModel(modelRowsOf(nodes)[0]);

      await tap(nodes.get('btnBulk'));
      await new Promise((r) => setTimeout(r, 200));

      assertEqual(nodes.get('bulkDialog').open, true, 'the bulk sheet opened');
      assertEqual(nodes.get('bulkUrl').textContent, 'https://gw.test/v1', 'the URL is on screen');
      // Both keys, each with its status: picking between two masked keys that
      // look alike is otherwise guesswork.
      const options = nodes.get('bulkKey').children;
      assertEqual(options.length, 3, 'every key plus the "all" option');
      assert(options[0].textContent.includes('Tất cả API'), 'the default is every key: ' + options[0].textContent);
      assertEqual(nodes.get('bulkKey').value, '__all__', 'and it is the selected one');
      assertEqual(nodes.get('bulkRun').disabled, false, 'and the run is possible');
    });

    it('UI43: the estimate states the cost before anything is sent', async () => {
      const nodes = installDom();
      await seed();
      globalThis.fetch = createMockFetch({
        '/models': { body: { data: [] } },
        '/chat/completions': { body: { choices: [{ message: { content: 'OK' } }] } },
      });
      await bootApp();
      await openUrlInDrawer(nodes, 'Gateway');
      await tapModel(modelRowsOf(nodes)[0]);
      await tap(nodes.get('btnBulk'));
      await new Promise((r) => setTimeout(r, 200));

      const estimate = nodes.get('bulkEstimate').textContent;
      assert(estimate.includes('20 request'), 'the default limit is stated: ' + estimate);
      assert(estimate.includes('160'), 'and so is the token cost: ' + estimate);
      assert(estimate.includes('có phí'), 'plus the fact that paid models are skipped: ' + estimate);

      nodes.get('bulkLimit').value = '80';
      for (const fn of nodes.get('bulkLimit')._listeners.input ?? []) fn({ target: nodes.get('bulkLimit') });

      const heavy = nodes.get('bulkEstimate').textContent;
      assert(heavy.includes('80 request'), 'a new number gives a new estimate: ' + heavy);
      // Past this the user is spending a real quota, and that is said in a
      // different colour rather than left to be inferred from the digits.
      assertEqual(nodes.get('bulkEstimate').className.includes('warn'), true, 'and it is flagged');
    });

    it('UI44: a limit past the cap is capped, not obeyed', async () => {
      const nodes = installDom();
      await seed();
      globalThis.fetch = createMockFetch({ '/models': { body: { data: [] } } });
      await bootApp();
      await openUrlInDrawer(nodes, 'Gateway');
      await tapModel(modelRowsOf(nodes)[0]);
      await tap(nodes.get('btnBulk'));
      await new Promise((r) => setTimeout(r, 200));

      nodes.get('bulkLimit').value = '5000';
      for (const fn of nodes.get('bulkLimit')._listeners.input ?? []) fn({ target: nodes.get('bulkLimit') });

      // A run that takes longer than anyone will sit through is not a run, so
      // the number is bounded rather than trusted.
      assert(
        nodes.get('bulkEstimate').textContent.includes('200 request'),
        'five thousand is read as two hundred: ' + nodes.get('bulkEstimate').textContent
      );
    });

    it('UI45: the run asks before spending, and paints one row per model', async () => {
      const nodes = installDom();
      await seed();
      const mock = createMockFetch({
        '/models': { body: { data: [] } },
        '/chat/completions': { body: { choices: [{ message: { content: 'OK' } }] } },
      });
      globalThis.fetch = mock;
      await bootApp();
      await openUrlInDrawer(nodes, 'Gateway');
      await tapModel(modelRowsOf(nodes)[0]);
      await tap(nodes.get('btnBulk'));
      await new Promise((r) => setTimeout(r, 200));

      nodes.get('bulkLimit').value = '2';
      for (const fn of nodes.get('bulkLimit')._listeners.input ?? []) fn({ target: nodes.get('bulkLimit') });

      let asked = false;
      globalThis.confirm = () => { asked = true; return true; };
      mock.reset();

      await tap(nodes.get('bulkRun'));
      await new Promise((r) => setTimeout(r, 400));

      assertEqual(asked, true, 'the cost was confirmed before the first request');
      const sent = mock.calls.filter((c) => c.url.includes('/chat/completions'));
      assertEqual(sent.length, 2, 'exactly the requested number of requests');
      assertEqual(
        nodes.get('bulkRows').children.filter((c) => c.classList.contains('bulk-row')).length,
        2,
        'one row per model'
      );
      assert(
        nodes.get('bulkProgress').textContent === '2/2',
        'and the progress counter agrees: ' + nodes.get('bulkProgress').textContent
      );
    });

    it('UI46: declining the confirmation sends nothing', async () => {
      const nodes = installDom();
      await seed();
      const mock = createMockFetch({
        '/models': { body: { data: [] } },
        '/chat/completions': { body: { choices: [{ message: { content: 'OK' } }] } },
      });
      globalThis.fetch = mock;
      await bootApp();
      await openUrlInDrawer(nodes, 'Gateway');
      await tap(nodes.get('btnBulk'));
      await new Promise((r) => setTimeout(r, 200));
      mock.reset();

      globalThis.confirm = () => false;
      await tap(nodes.get('bulkRun'));
      await new Promise((r) => setTimeout(r, 250));

      assertEqual(
        mock.calls.filter((c) => c.url.includes('/chat/completions')).length,
        0,
        'saying no costs nothing'
      );
    });

    it('UI47: a URL with no key cannot be bulk probed, and says why', async () => {
      const nodes = installDom();
      await seed();
      await seedSecondUrl();
      globalThis.fetch = createMockFetch({ '/models': { body: { data: [] } } });
      await bootApp();
      await tapModel(rowsOfBlock(blockWithUrl(nodes, 'other.test'))[0]);
      await tap(nodes.get('btnBulk'));
      await new Promise((r) => setTimeout(r, 200));

      assertEqual(nodes.get('bulkDialog').open, true, 'the sheet still opens');
      assertEqual(nodes.get('bulkRun').disabled, true, 'the run button is disabled');
      assert(
        nodes.get('bulkRows').textContent.includes('chưa có API key'),
        'and the reason is on screen: ' + nodes.get('bulkRows').textContent
      );
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

    it('UI23: the ⓘ still opens a model, so the long press did not eat the tap', async () => {
      const nodes = installDom();
      await seed();
      globalThis.fetch = createMockFetch({
        '/models': { body: { data: [] } },
        '/chat/completions': { body: { choices: [{ message: { content: 'OK' } }] } },
      });
      await bootApp();

      const tapped = modelRowsOf(nodes).map(modelNameOf)[0];
      await tapModel(modelRowsOf(nodes)[0]);
      await new Promise((r) => setTimeout(r, 120));

      assertEqual(nodes.get('modelDialog').open, true, 'the sheet opened');
      assertEqual(nodes.get('modelTitle').textContent, tapped, 'for the tapped model');
    });

    // ---------------------------------------------------------------- copy list

    it('UI48: tapping a model row opens its card and copies nothing', async () => {
      const nodes = installDom();
      await seed();
      globalThis.fetch = createMockFetch({ '/models': { body: { data: [] } } });
      await bootApp();

      const copied = [];
      globalThis.navigator.clipboard.writeText = async (text) => { copied.push(text); };

      const row = modelRowsOf(nodes)[0];
      const id = modelNameOf(row);
      await tapModelRow(row);
      await new Promise((r) => setTimeout(r, 120));

      // A tap used to copy and leave nothing on screen. It now opens the card -
      // which is where the id is copied from - so the shortcut moved one step
      // deeper rather than disappearing.
      assertEqual(copied.length, 0, 'a tap copies nothing by itself');
      assertEqual(nodes.get('modelDialog').open, true, 'it opens the card');
      assertEqual(nodes.get('boxModel').textContent, id, 'and names the model that was tapped');
    });

    it('UI49: the API chips are on the row, masked, and tapping one reveals and copies', async () => {
      const nodes = installDom();
      await seed();
      globalThis.fetch = createMockFetch({ '/models': { body: { data: [] } } });
      await bootApp();

      const copied = [];
      globalThis.navigator.clipboard.writeText = async (text) => { copied.push(text); };

      const row = modelRowsOf(nodes)[0];
      const chips = apiChipsOf(row);
      assert(chips.length >= 1, 'the URL keys are on the row, not only inside the card');
      assertEqual(
        chips.some((c) => c.textContent.includes(KEY_A) || c.textContent.includes(KEY_B)),
        false,
        'no full key is on screen before a tap: ' + chips.map((c) => c.textContent).join(' | ')
      );

      await tap(chips[0]);
      await new Promise((r) => setTimeout(r, 120));

      assert(
        [KEY_A, KEY_B].includes(copied[0]),
        'tapping copies the whole key, not the masked form: ' + copied[0]
      );
      const after = apiChipsOf(modelRowsOf(nodes)[0])[0];
      assertEqual(
        after.textContent.includes(copied[0]),
        true,
        'and the key that was copied is the one revealed on the row'
      );
    });

    it('UI50: the URL header carries the URL, copies it, and is sticky', async () => {
      const nodes = installDom();
      await seed();
      globalThis.fetch = createMockFetch({ '/models': { body: { data: [] } } });
      await bootApp();

      const copied = [];
      globalThis.navigator.clipboard.writeText = async (text) => { copied.push(text); };

      const head = blockCopyOf(firstBlock(nodes));
      assert(head, 'every block has a URL header');
      assertEqual(
        head.textContent.includes('https://gw.test/v1'),
        true,
        'the header carries the URL: ' + head.textContent
      );

      await tap(head);
      await new Promise((r) => setTimeout(r, 60));
      assertEqual(copied[0], 'https://gw.test/v1', 'and one tap copies it');

      // Sticky is what makes the URL readable at the moment it is needed: the
      // header has to stop below the app bar, not scroll away with its rows.
      const css = fs.readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
      assert(
        /\.urlhead\s*\{[^}]*position:\s*sticky/.test(css),
        'the URL header must be sticky'
      );
      assert(
        /\.urlhead\s*\{[^}]*top:\s*var\(--appbar-h\)/.test(css),
        'and it must stop below the app bar rather than under it'
      );
    });

    it('UI51: a model nobody priced is hidden by default and reachable behind its own chip', async () => {
      const nodes = installDom();
      await seed();
      await seedUnknownModel();
      globalThis.fetch = createMockFetch({ '/models': { body: { data: [] } } });
      await bootApp();

      const chip = (level) => globalThis.__allChips.find((c) => c.dataset.filter === level);
      const names = () => modelRowsOf(nodes).map(modelNameOf);

      assertEqual(names().includes('bi-an-1'), false, 'no price and no hint: not in the 0đ list');
      assertEqual(names().length, 2, 'the two models priced at zero are');

      // Hiding it is not discarding it, and the count is what says so: a list
      // that quietly dropped a scanned model would read as a broken scan.
      const count = nodes.get('filterCount').textContent;
      assert(count.includes('1'), 'the count names how many are hidden: ' + count);
      assert(count.includes('chưa rõ giá'), 'and says what kind they are: ' + count);

      await tap(chip('unknown'));
      await new Promise((r) => setTimeout(r, 200));
      assertEqual(names().includes('bi-an-1'), true, 'its own chip is the way back to it');
      assertEqual(names().length, 1, 'and that chip shows only that kind');
    });

    it('UI52: the URL menu still holds everything that used to sit on the block', async () => {
      const nodes = installDom();
      await seed();
      globalThis.fetch = createMockFetch({ '/models': { body: { data: [] } } });
      await bootApp();

      await tap(blockMenuOf(firstBlock(nodes)));
      await new Promise((r) => setTimeout(r, 80));

      const labels = nodes.get('rowMenuActions').children.map((c) => c.textContent).join(' | ');
      for (const wanted of [
        'Quét lại URL này',
        'Quét nhiều model',
        'Danh sách model free',
        'Danh sách API',
        'Quay vòng',
        'Khoá model ở URL này',
        'Xoá cấu hình riêng',
        'Chép base URL',
      ]) {
        assert(labels.includes(wanted), `the URL menu must offer "${wanted}": ${labels}`);
      }
      assertEqual(nodes.get('rowMenu').open, true, 'and the menu is open');
    });

    // ------------------------------------------------- find and classify a URL

    it('UI53: the drawer search narrows the URL list by name and by address', async () => {
      const nodes = installDom();
      await seed();
      await seedSecondUrl();
      globalThis.fetch = createMockFetch({ '/models': { body: { data: [] } } });
      await bootApp();

      // The built-in providers ship with the app, so the drawer is never only
      // the URLs a test made. Both test URLs being present is the fact that
      // matters here, not the exact length of the list.
      assert(
        drawerNames(nodes).includes('Gateway') && drawerNames(nodes).includes('Other'),
        'both test URLs are listed to begin with: ' + drawerNames(nodes)
      );

      const listBefore = modelRowsOf(nodes).length;
      const box = nodes.get('urlSearch');
      const type = async (value) => {
        box.value = value;
        for (const fn of box._listeners.input ?? []) await fn({ target: box });
        await new Promise((r) => setTimeout(r, 120));
      };

      await type('other');
      assertEqual(drawerNames(nodes).join(','), 'Other', 'only the matching URL is drawn: ' + drawerNames(nodes));

      // The address counts too, not only the label: two entries can share a name
      // and then the URL is the only thing that tells them apart.
      await type('gw.test');
      assertEqual(drawerNames(nodes).join(','), 'Gateway', 'the address is searched as well: ' + drawerNames(nodes));

      // The main list is untouched: the URL search narrows the drawer and
      // nothing else, so the list under the title still holds what it held. A
      // URL filter that punched holes in it would make the count under the
      // title disagree with the rows beneath it.
      assertEqual(modelRowsOf(nodes).length, listBefore, 'the main list is not filtered by the URL search');

      // Clearing is its own control. A search box on a phone that can only be
      // undone by typing the whole thing backwards is a trap.
      await type('zzz');
      assertEqual(drawerNames(nodes).length, 0, 'a search that matches nothing draws nothing');
      await tap(nodes.get('urlSearchClear'));
      await new Promise((r) => setTimeout(r, 120));
      assert(
        drawerNames(nodes).includes('Gateway') && drawerNames(nodes).includes('Other'),
        'and clearing brings every URL back: ' + drawerNames(nodes)
      );
      assert(nodes.get('urlSearch').value === '', 'with the box emptied, not left holding the old word');
    });

    it('UI54: the class buttons split the drawer by what a URL needs', async () => {
      const nodes = installDom();
      await seed();
      await seedClassifiedUrls();
      globalThis.fetch = createMockFetch({ '/models': { body: { data: [] } } });
      await bootApp();

      // Both classes are on screen first, because no class has been chosen.
      assertEqual(drawerRow(nodes, 'Open Gate').draggable, true, 'rows are draggable while nothing is filtered');
      assert(
        drawerNames(nodes).includes('Open Gate') && drawerNames(nodes).includes('Locked Gate'),
        'both classes are listed to begin with'
      );

      await tap(classButton('nokey'));
      await new Promise((r) => setTimeout(r, 200));
      assert(drawerNames(nodes).includes('Open Gate'), 'the URL usable without a key stays: ' + drawerNames(nodes));
      assertEqual(drawerNames(nodes).includes('Locked Gate'), false, 'and the one that needs a key is gone');
      assertEqual(classButton('nokey').classList.contains('on'), true, 'and the button shows it is on');
      assertEqual(
        drawerRow(nodes, 'Open Gate').draggable !== true,
        true,
        'a narrowed list is a view, so it is not draggable'
      );
      // The line under the list is the only place the gesture is named, so it
      // has to stop promising a drag the list no longer accepts.
      assert(
        nodes.get('sideHint').textContent.includes('Đang lọc'),
        'the legend says dragging is off: ' + nodes.get('sideHint').textContent
      );

      await tap(classButton('needkey'));
      await new Promise((r) => setTimeout(r, 200));
      assert(drawerNames(nodes).includes('Locked Gate'), 'then the one that needs a key: ' + drawerNames(nodes));
      assertEqual(drawerNames(nodes).includes('Open Gate'), false, 'and the open one is gone');
      assertEqual(classButton('nokey').classList.contains('on'), false, 'and only one class can be on');

      // Pressing the class that is already on is the way back to every URL: two
      // classes leave no room for a third "tất cả" answer on a phone line.
      await tap(classButton('needkey'));
      await new Promise((r) => setTimeout(r, 200));
      assert(
        drawerNames(nodes).includes('Open Gate') && drawerNames(nodes).includes('Locked Gate'),
        'and off means everything again: ' + drawerNames(nodes)
      );
      assertEqual(drawerRow(nodes, 'Open Gate').draggable, true, 'with dragging back on');
      assertEqual(
        nodes.get('sideHint').textContent.includes('kéo'),
        true,
        'and the drag hint comes back with the unfiltered list'
      );
    });

    it('UI55: the free-count order is one button, and the select agrees with it', async () => {
      const nodes = installDom();
      await seed();
      // A URL with no models, named so the count and the alphabet disagree: a
      // button that only repainted itself would pass the state checks below and
      // fail right here.
      await new ProviderRegistry(storageRef).upsert({ name: 'Aaa', baseURL: 'https://aaa.test/v1' });
      globalThis.__FMH_SEED__.providers = await storageRef.list('providers');
      globalThis.fetch = createMockFetch({ '/models': { body: { data: [] } } });
      await bootApp();

      // Compared by where the two names sit relative to each other, not by the
      // head of the list: the built-in providers are in there too, and pinning
      // the first row would make this a test of their names.
      const names = () => drawerNames(nodes);
      const btn = nodes.get('urlSortFree');

      assert(
        names().indexOf('Aaa') < names().indexOf('Gateway'),
        'by default the two sit in the order the user arranged: ' + names().slice(0, 6)
      );

      await tap(btn);
      await new Promise((r) => setTimeout(r, 200));
      assert(
        names().indexOf('Gateway') < names().indexOf('Aaa'),
        'the button leads with the URL holding the most free models: ' + names().slice(0, 6)
      );
      assertEqual(nodes.get('urlSort').value, 'models', 'and the select reads the same order');
      assertEqual(btn.classList.contains('on'), true, 'with the button marked as on');

      await tap(btn);
      await new Promise((r) => setTimeout(r, 200));
      assertEqual(btn.classList.contains('on'), false, 'pressing it again turns it off');
      assertEqual(nodes.get('urlSort').value, 'manual', 'and the select goes back with it, not its own way');
      assert(
        names().indexOf('Aaa') < names().indexOf('Gateway'),
        'and the list is back in the order it started in'
      );
    });

    it('UI56: "khoá tất cả" can be undone from the same button', async () => {
      const nodes = installDom();
      await seed();
      globalThis.fetch = createMockFetch({ '/models': { body: { data: [] } } });
      await bootApp();

      const slot = nodes.get('lockAllUrls');
      const allBtn = () => slot.children[0];
      assert(allBtn(), 'the drawer mounts a lock-all control');

      const rows = () => nodes.get('sidebarRoot').children.filter((c) => c.classList.contains('urlitem'));
      const lockedCount = () => rows().filter((c) => c.classList.contains('locked')).length;
      const total = rows().length;

      assertEqual(lockedCount(), 0, 'nothing is locked to begin with');
      assertEqual(allBtn().textContent, 'khoá tất cả', 'and the button offers to lock');

      await tap(allBtn());
      assertEqual(lockedCount(), total, `one tap locks every URL (${lockedCount()}/${total})`);

      // The label has to follow the state it just changed. A control still
      // reading "khoá tất cả" while everything is locked can only lock again, so
      // the second tap looks like it did nothing - which is exactly the trap
      // this case exists for.
      assertEqual(allBtn().textContent, 'mở khoá tất cả', 'and it now offers the way back');

      await tap(allBtn());
      assertEqual(lockedCount(), 0, 'tapping it again unlocks everything');
      assertEqual(allBtn().textContent, 'khoá tất cả', 'and the label comes back with the state');
    });

    it('UI57: picking a URL narrows the list to it, and the bar is the way back', async () => {
      const nodes = installDom();
      await seed();
      await seedSecondUrl();
      globalThis.fetch = createMockFetch({ '/models': { body: { data: [] } } });
      await bootApp();

      // Every URL on one screen to begin with, and no bar, because there is
      // nothing to clear yet.
      assertEqual(urlBlocksOf(nodes).length, 2, 'both URLs are listed at once');
      assertEqual(nodes.get('scopeBar').hidden, true, 'and the scope bar is hidden');

      await openUrlInDrawer(nodes, 'Gateway');
      assertEqual(urlBlocksOf(nodes).length, 1, 'picking one URL leaves only its block');
      assert(
        blockCopyOf(firstBlock(nodes)).textContent.includes('gw.test'),
        'and it is the one that was picked: ' + blockCopyOf(firstBlock(nodes)).textContent
      );
      assertEqual(nodes.get('scopeBar').hidden, false, 'the bar appears with the pick');
      assertEqual(nodes.get('scopeName').textContent, 'Gateway', 'and names the URL that is open');

      // The tabs count what is on screen, so a count over a narrowed list cannot
      // promise rows this view is hiding behind it.
      const count = nodes.get('filterCount').textContent;
      assert(count.includes('1 URL'), 'the count says one URL: ' + count);

      await clearScope(nodes);
      assertEqual(urlBlocksOf(nodes).length, 2, 'clearing brings every URL back');
      assertEqual(nodes.get('scopeBar').hidden, true, 'and hides the bar again');
    });

    it('UI58: the URL menu opens the model list, and each row can be edited or deleted', async () => {
      const nodes = installDom();
      await seed();
      globalThis.fetch = createMockFetch({ '/models': { body: { data: [] } } });
      await bootApp();

      await tap(blockMenuOf(firstBlock(nodes)));
      await new Promise((r) => setTimeout(r, 80));
      const item = nodes
        .get('rowMenuActions')
        .children.find((c) => c.textContent.includes('Danh sách model free'));
      assert(item, 'the URL menu offers the model list');
      await tap(item);
      await new Promise((r) => setTimeout(r, 120));

      assertEqual(nodes.get('modelAddDialog').open, true, 'the model list sheet opened');
      assertEqual(nodes.get('manualList').hidden, false, 'the list is shown, not the form');
      const rows = nodes.get('manualList').children.filter((c) => c.classList.contains('listrow'));
      assertEqual(rows.length, 2, 'every 0đ model of the URL is listed');
      // Each row carries an edit and a delete, which is what "click vào để
      // sửa/xoá" means concretely.
      const titles = rows[0].children.map((c) => c.title ?? '');
      assert(titles.some((t) => t.includes('Sửa')), 'an edit control: ' + titles.join(' | '));
      assert(titles.some((t) => t.includes('Xoá')), 'a delete control');

      // "+ Thêm model" steps into the form rather than opening a second sheet.
      await tap(nodes.get('manualListAdd'));
      await new Promise((r) => setTimeout(r, 60));
      assertEqual(nodes.get('manualForm').hidden, false, 'the add form appears');
      assertEqual(nodes.get('manualList').hidden, true, 'and the list steps aside');
    });

    it('UI59: the URL menu opens the API list with working status and per-row controls', async () => {
      const nodes = installDom();
      await seed();
      globalThis.fetch = createMockFetch({ '/models': { body: { data: [] } } });
      await bootApp();

      await tap(blockMenuOf(firstBlock(nodes)));
      await new Promise((r) => setTimeout(r, 80));
      const item = nodes
        .get('rowMenuActions')
        .children.find((c) => c.textContent.includes('Danh sách API'));
      assert(item, 'the URL menu offers the API list');
      await tap(item);
      await new Promise((r) => setTimeout(r, 120));

      assertEqual(nodes.get('keyDialog').open, true, 'the API list sheet opened');
      const rows = nodes.get('keyList').children.filter((c) => c.classList.contains('listrow'));
      assertEqual(rows.length, 2, 'both keys of the URL are listed');
      const text = rows[0].textContent;
      assert(text.includes('…') || text.includes('oc_'), 'a masked name is shown: ' + text);
      const titles = rows[0].children.map((c) => c.title ?? '');
      assert(titles.some((t) => t.includes('Đổi key')), 'an edit control: ' + titles.join(' | '));
      assert(titles.some((t) => t.includes('Xoá API')), 'a delete control');
    });

    it('UI60: tapping an API in the card opens a chat that sends and logs the reply', async () => {
      const nodes = installDom();
      await seed();
      const mock = createMockFetch({
        '/models': { body: { data: [] } },
        '/chat/completions': { body: { choices: [{ message: { content: 'Xin chào từ model' } }] } },
      });
      globalThis.fetch = mock;
      await bootApp();
      await openUrlInDrawer(nodes, 'Gateway');
      await tapModel(modelRowsOf(nodes)[0]);
      await new Promise((r) => setTimeout(r, 120));

      assertEqual(nodes.get('chatField').hidden, true, 'the chat starts hidden');

      const keyRow = nodes.get('keyRows').children.find((c) => c.classList.contains('keyrow'));
      const flex = keyRow.children.find((c) => c.className === 'kflex');
      await tap(flex);
      await new Promise((r) => setTimeout(r, 60));
      assertEqual(nodes.get('chatField').hidden, false, 'tapping an API opens the chat');

      nodes.get('chatInput').value = 'Chào bạn';
      mock.reset();
      await tap(nodes.get('chatSend'));
      await new Promise((r) => setTimeout(r, 200));

      const sent = mock.calls.filter((c) => c.url.includes('/chat/completions'));
      assertEqual(sent.length, 1, 'one send is one request');
      assert(
        String(sent[0].body).includes('Chào bạn'),
        'and it carries the typed message: ' + sent[0].body
      );
      const log = nodes.get('chatLog').textContent;
      assert(log.includes('Chào bạn'), 'the log shows what was asked: ' + log);
      assert(log.includes('Xin chào từ model'), 'and what came back: ' + log);
    });

    it('UI61: the ✓ on a model row checks it against the URL keys without opening the card', async () => {
      const nodes = installDom();
      await seed();
      const mock = createMockFetch({
        '/models': { body: { data: [] } },
        '/chat/completions': { body: { choices: [{ message: { content: 'OK' } }] } },
      });
      globalThis.fetch = mock;
      await bootApp();
      await openUrlInDrawer(nodes, 'Gateway');
      mock.reset();

      const row = modelRowsOf(nodes)[0];
      const id = modelNameOf(row);
      await tapModelCheck(row);
      await new Promise((r) => setTimeout(r, 200));

      assertEqual(nodes.get('modelDialog').open, false, 'the card stayed shut');
      const sent = mock.calls.filter((c) => c.url.includes('/chat/completions'));
      assert(sent.length >= 1, 'at least one request was sent');
      assertEqual(JSON.parse(sent[0].body).model, id, 'and it named the model that was checked');
    });

    it('UI62: every row of the API list carries its own check button', async () => {
      const nodes = installDom();
      await seed();
      globalThis.fetch = createMockFetch({ '/models': { body: { data: [] } } });
      await bootApp();

      await tap(blockMenuOf(firstBlock(nodes)));
      await new Promise((r) => setTimeout(r, 80));
      const item = nodes
        .get('rowMenuActions')
        .children.find((c) => c.textContent.includes('Danh sách API'));
      await tap(item);
      await new Promise((r) => setTimeout(r, 120));

      const rows = nodes.get('keyList').children.filter((c) => c.classList.contains('listrow'));
      assert(rows.length >= 1, 'there is at least one API row');
      // A check per row: the list is where a key is judged, so it needs the
      // action that produces the judgement, not only edit and delete.
      for (const row of rows) {
        const titles = row.children.map((c) => c.title ?? '');
        assert(titles.some((t) => t.includes('Check API')), 'a check control: ' + titles.join(' | '));
      }
    });

    it('UI63: the export sheet writes the working configuration in the chosen format', async () => {
      const nodes = installDom();
      await seed();
      globalThis.fetch = createMockFetch({
        '/models': { body: { data: [] } },
        '/chat/completions': { body: { choices: [{ message: { content: 'OK' } }] } },
      });
      await bootApp();

      // Prove one model of the URL works, which is what makes it exportable.
      await openUrlInDrawer(nodes, 'Gateway');
      const row = modelRowsOf(nodes)[0];
      const id = modelNameOf(row);
      await tapModelCheck(row);
      await new Promise((r) => setTimeout(r, 200));

      await tap(nodes.get('btnExport'));
      await new Promise((r) => setTimeout(r, 200));

      assertEqual(nodes.get('exportDialog').open, true, 'the export sheet opened');
      const env = nodes.get('exportOut').textContent;
      assert(env.includes('OPENAI_BASE_URL=https://gw.test/v1'), 'the .env names the working URL: ' + env);
      assert(env.includes(id), 'and the model that was checked: ' + env);
      assert(env.includes('OPENAI_API_KEY='), 'and a key line');

      // Flipping the format repaints from the same data, in a shape a tool can
      // parse rather than a second .env.
      nodes.get('exportFormat').value = 'json';
      for (const fn of nodes.get('exportFormat')._listeners.change ?? []) fn({ target: nodes.get('exportFormat') });
      await new Promise((r) => setTimeout(r, 40));
      const parsed = JSON.parse(nodes.get('exportOut').textContent);
      assertEqual(parsed.default.baseURL, 'https://gw.test/v1', 'the json default is the working URL');
    });

    it('UI64: the AI tab streams an answer into its bubble and counts the tokens it spent', async () => {
      const nodes = installDom();
      await seed();
      // The reply is longer than one SSE chunk, so the painter is exercised on
      // the same path a real provider drives rather than on a single blob.
      globalThis.fetch = createMockFetch({
        '/models': { body: { data: [] } },
        '/chat/completions': {
          body: {
            choices: [{ message: { content: 'Chao ban, toi la tro ly cua hub.' } }],
            usage: { total_tokens: 42 },
          },
        },
      });
      await bootApp();

      // Reached the way a person reaches it: the bar is delegated, so a handler
      // bound to the button itself would not exist and calling one would prove
      // nothing about the wiring that ships.
      const aiBtn = document.querySelectorAll('.tabbar-btn').find((c) => c.dataset?.goto === 'ai');
      assert(aiBtn, 'the bottom bar has an AI button');
      for (const fn of document._listeners.click ?? []) await fn({ target: aiBtn });
      assertEqual(nodes.get('paneAI').hidden, false, 'the AI pane is the one on screen');

      // No mapping means no candidate, so the turn has to be set up exactly the
      // way the app would: one model proven to answer, which is what creates the
      // mapping the router rotates over.
      await openUrlInDrawer(nodes, 'Gateway');
      const row = modelRowsOf(nodes)[0];
      const modelId = modelNameOf(row);
      await tapModelCheck(row);
      await new Promise((r) => setTimeout(r, 200));

      const budgetBefore = nodes.get('aiBudget').textContent;
      assert(budgetBefore.includes('20.000'), 'a fresh session opens with the full budget: ' + budgetBefore);

      nodes.get('aiInput').value = 'Xin chao';
      await tap(nodes.get('aiSend'));

      const bubbles = nodes.get('aiLog').children;
      assertEqual(bubbles.length, 2, 'one question, one answer');
      assert(bubbles[0].classList.contains('you'), 'the first bubble is the question');
      assertEqual(bubbles[0].textContent.includes('Xin chao'), true, 'the question is in it');
      assert(bubbles[1].classList.contains('ai'), 'the second bubble is the answer');
      assertEqual(
        bubbles[1].textContent.includes('Chao ban'),
        true,
        'the model answer landed in the bubble: ' + bubbles[1].textContent
      );

      // The budget is the whole reason the session is a class: it has to move by
      // what the provider reported, not stay at its opening number.
      const budgetAfter = nodes.get('aiBudget').textContent;
      assert(budgetAfter.includes('19.958'), 'the 42 reported tokens were subtracted: ' + budgetAfter);
      assertEqual(nodes.get('aiWho').textContent.includes(modelId), true, 'the header names what answered');

      // And clearing the log starts the conversation over without refilling the
      // budget - the tokens were spent whether or not they are still on screen.
      await tap(nodes.get('aiClear'));
      assertEqual(nodes.get('aiLog').children.length, 0, 'the log is empty again');
      assert(nodes.get('aiBudget').textContent.includes('19.958'), 'and the spend was not refunded');
    });

    it('UI65: a long press on a URL offers to edit it and to delete it', async () => {
      const nodes = installDom();
      await seed();
      globalThis.fetch = createMockFetch({ '/models': { body: { data: [] } } });
      await bootApp();

      const row = drawerRow(nodes, 'Gateway');
      await longPressRow(row);

      const all = nodes.get('rowMenuActions').children.map((c) => c.textContent).join(' | ');
      assert(all.includes('Sửa URL'), 'edit: ' + all);
      // Named after the thing being deleted rather than "Xoá", which the same
      // sheet also carries for the URL's own settings - two entries that differ
      // only by their sub-line are how the wrong one gets tapped.
      assert(all.includes('Xoá URL này'), 'delete: ' + all);

      const del = nodes.get('rowMenuActions').children.find((c) => c.textContent.includes('Xoá URL này'));
      assert(del.classList.contains('danger'), 'the delete row is the red one');
    });

    it('UI66: editing a URL rewrites the same row and leaves its data alone', async () => {
      const nodes = installDom();
      const { provider, models } = await seed();
      globalThis.fetch = createMockFetch({ '/models': { body: { data: [] } } });
      await bootApp();
      const modelsBefore = (await models.list(provider.id)).length;

      const row = drawerRow(nodes, 'Gateway');
      await longPressRow(row);
      const edit = nodes.get('rowMenuActions').children.find((c) => c.textContent.includes('Sửa URL'));
      await tap(edit);

      assertEqual(nodes.get('addUrlDialog').open, true, 'the sheet opened');
      assertEqual(nodes.get('urlTitle').textContent, 'Sửa URL', 'and it is in edit shape');
      assertEqual(nodes.get('urlConfirm').textContent, 'Lưu', 'the confirm says save, not add');
      // The creation-only fields have to be gone rather than blank: a visible
      // "API key ban đầu" on an edit invites a second key for the same URL.
      assertEqual(nodes.get('urlNewOnly').hidden, true, 'the creation-only fields are not offered');
      assertEqual(nodes.get('urlName').value, 'Gateway', 'the name is prefilled');
      assertEqual(nodes.get('urlBase').value, provider.baseURL, 'and so is the base URL');

      nodes.get('urlName').value = 'Gateway da sua';
      await tap(nodes.get('urlConfirm'));
      await new Promise((r) => setTimeout(r, 350));

      assertEqual(nodes.get('addUrlDialog').open, false, 'the sheet closed on save');
      const names = drawerNames(nodes);
      assert(names.includes('Gateway da sua'), 'the drawer shows the new name: ' + names.join(','));
      assertEqual(names.includes('Gateway'), false, 'and not the old one');

      // The seed store is only where the fixture was built; the app writes to
      // its own storage, and reading the fixture back would let a rename that
      // never happened pass this.
      const store = globalThis.__FMH_STORAGE__;
      const stored = await store.list('providers');
      const mine = stored.filter((p) => p.id === provider.id);
      assertEqual(mine.length, 1, 'and it is still one URL, not a second one');
      assertEqual(mine[0].name, 'Gateway da sua', 'the rename is in storage');
      const rows = (await store.list('models')).filter((m) => m.providerId === provider.id);
      assertEqual(rows.length, modelsBefore, 'the models were not touched by a rename');
    });

    it('UI67: deleting a URL takes its models and keys with it, and only after a confirm', async () => {
      const nodes = installDom();
      const { provider } = await seed();
      globalThis.fetch = createMockFetch({ '/models': { body: { data: [] } } });
      await bootApp();

      const row = drawerRow(nodes, 'Gateway');
      await longPressRow(row);
      const del = nodes.get('rowMenuActions').children.find((c) => c.textContent.includes('Xoá URL này'));
      await tap(del);

      // Nothing is gone yet: the tap only asks.
      const store = () => globalThis.__FMH_STORAGE__;
      const mine = async () => (await store().list('providers')).filter((p) => p.id === provider.id);
      assertEqual(nodes.get('delUrlDialog').open, true, 'a confirm sheet opens first');
      assertEqual((await mine()).length, 1, 'and nothing is removed by opening it');
      const warn = nodes.get('delUrlWarn').textContent;
      assert(warn.includes('3 model'), 'the sheet counts the models that go with it: ' + warn);
      assert(warn.includes('2 API key'), 'and the keys: ' + warn);
      assert(warn.includes('Không có thùng rác'), 'and says it is permanent: ' + warn);

      await tap(nodes.get('delUrlCancel'));
      assertEqual((await mine()).length, 1, 'cancel leaves everything in place');

      await tap(nodes.get('delUrlConfirm'));
      await new Promise((r) => setTimeout(r, 400));
      assertEqual(nodes.get('delUrlDialog').open, false, 'the sheet closed');
      assertEqual((await mine()).length, 0, 'the URL is gone');
      const modelsLeft = (await store().list('models')).filter((m) => m.providerId === provider.id);
      assertEqual(modelsLeft.length, 0, 'its models went with it');
      const keysLeft = (await store().list('keys')).filter((k) => k.providerId === provider.id);
      assertEqual(keysLeft.length, 0, 'its keys went with it');
      assertEqual(
        drawerNames(nodes).includes('Gateway'),
        false,
        'and the drawer no longer lists it: ' + drawerNames(nodes).join(',')
      );
    });
  });
}
