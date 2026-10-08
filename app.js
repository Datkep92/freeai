/**
 * Free Model Hub - UI.
 *
 * All business logic lives in core/. This file renders and forwards intent.
 *
 * The main screen lists free models grouped by URL. Tapping a model opens its
 * URL, its model id, and every API key stored on that URL, where each row has
 * its own copy / check / delete action.
 */

import { createStorage } from './core/storage.js';
import { ProviderRegistry } from './core/provider-registry.js';
import { ModelRegistry, MODEL_SOURCE } from './core/model-registry.js';
import { KeyRegistry } from './core/key-registry.js';
import { Mapper } from './core/mapper.js';
import { Scanner } from './core/scanner.js';
import { KeyVerifier } from './core/key-verifier.js';
import { BulkProbe, STOP } from './core/bulk-probe.js';
import { CONFIG } from './core/config.js';
import { Router } from './core/router.js';
import { STATUS, STATUS_META } from './core/statuses.js';
import { FREE, FREE_META, isFreeModel, isUnknownPrice } from './core/free-detector.js';
import { fingerprintSecret, maskSecret } from './core/util.js';
import { Priority, SCOPE, ROTATION, sortByPriority } from './core/priority.js';
import { MetricsRegistry, formatMetric } from './core/metrics.js';
import { KEY_REQ, KEY_REQ_META, groupByRequirement, requirementOf } from './core/key-requirement.js';
import { modelInfo, formatCount, ageOf, formatPrice } from './core/model-info.js';
import { buildExport, formatExport } from './core/export-config.js';
import { Agent } from './core/agent.js';

const $ = (id) => document.getElementById(id);

/** A clock that works in a browser and in a test. */
function performanceNow() {
  return globalThis.performance?.now?.() ?? Date.now();
}

/**
 * An icon as an inline SVG.
 *
 * Drawn rather than typed as an emoji for two reasons. An emoji renders at a
 * different size and baseline on every platform, so a row of them never lines
 * up; and an emoji cannot inherit the row's colour, so a locked row and an open
 * row end up looking identical. The paths inherit `currentColor`, so one icon
 * follows whatever state the row is in.
 */
const ICONS = {
  lock: '<rect x="4" y="10.5" width="16" height="10" rx="2.5"/><path d="M8 10.5V7a4 4 0 1 1 8 0v3.5"/>',
  unlock: '<rect x="4" y="10.5" width="16" height="10" rx="2.5"/><path d="M8 10.5V7a4 4 0 0 1 7.5-1.9"/>',
  eye: '<path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z"/><circle cx="12" cy="12" r="2.8"/>',
  eyeOff: '<path d="M4 4l16 16"/><path d="M9.9 5.7A9.9 9.9 0 0 1 12 5.5c6.4 0 10 6.5 10 6.5a17 17 0 0 1-3.3 4.1M6.3 7.9A16.7 16.7 0 0 0 2 12s3.6 6.5 10 6.5a10 10 0 0 0 3.3-.6"/>',
  check: '<path d="M20 6L9 17l-5-5"/>',
  trash: '<path d="M3 6h18M8 6V4.5A1.5 1.5 0 0 1 9.5 3h5A1.5 1.5 0 0 1 16 4.5V6m3 0v13.5A1.5 1.5 0 0 1 17.5 21h-11A1.5 1.5 0 0 1 5 19.5V6M10 11v6M14 11v6"/>',
  grip: '<circle cx="9" cy="6" r="1.4"/><circle cx="15" cy="6" r="1.4"/><circle cx="9" cy="12" r="1.4"/><circle cx="15" cy="12" r="1.4"/><circle cx="9" cy="18" r="1.4"/><circle cx="15" cy="18" r="1.4"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3.2 9h17.6M3.2 15h17.6M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 7.8v.2"/>',
  dots: '<circle cx="12" cy="5.2" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="12" cy="18.8" r="1.7"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  scan: '<path d="M21 12a9 9 0 1 1-3-6.7M21 3v6h-6"/>',
  refresh: '<path d="M20 11A8 8 0 0 0 6.3 6.3L4 8.5M4 13a8 8 0 0 0 13.7 4.7L20 15.5"/><path d="M4 4v4.5h4.5M20 20v-4.5h-4.5"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2.5"/><path d="M15 5.5A2.5 2.5 0 0 0 12.5 3h-6A2.5 2.5 0 0 0 4 5.5v6A2.5 2.5 0 0 0 6.5 14"/>',
  key: '<circle cx="8" cy="12" r="4"/><path d="M12 12h9M17 12v3.5M20 12v2.5"/>',
  wrench: '<path d="M14.7 6.3a4 4 0 0 0 5.3 5.3l-8 8a2.8 2.8 0 0 1-4-4l8-8z"/>',
  up: '<path d="M12 19V5M5 12l7-7 7 7"/>',
  down: '<path d="M12 5v14M5 12l7 7 7-7"/>',
};

/** Build an <svg> node for one of the paths above. */
function icon(name) {
  const el = document.createElementNS?.('http://www.w3.org/2000/svg', 'svg');
  // The DOM stub has no createElementNS, so fall back to createElement there.
  const node = el ?? document.createElement('svg');
  node.setAttribute?.('viewBox', '0 0 24 24');
  node.setAttribute?.('aria-hidden', 'true');
  node.innerHTML = ICONS[name] ?? '';
  return node;
}

/**
 * An icon button with a tooltip, used for every per-row control.
 *
 * The glyph is drawn rather than typed, and `title` carries the meaning so a
 * long press on desktop still explains the button.
 */
function iconButton(name, title, onClick, className = 'iconbtn') {
  const btn = document.createElement('button');
  btn.className = className;
  btn.title = title;
  btn.setAttribute?.('aria-label', title);
  btn.append(icon(name));
  btn.addEventListener('click', onClick);
  return btn;
}

// A test harness may hand over pre-seeded rows before the app boots. In the
// browser nothing sets this, so the app simply starts empty.
const storage = createStorage();
// Exposed for the test harness: a case has to be able to read back what the UI
// actually wrote, and there is no other handle on this instance.
globalThis.__FMH_STORAGE__ = storage;
if (globalThis.__FMH_SEED__) {
  for (const [store, rows] of Object.entries(globalThis.__FMH_SEED__)) {
    for (const row of rows) await storage.put(store, row);
  }
}
const providers = new ProviderRegistry(storage);
const models = new ModelRegistry(storage);
const keys = new KeyRegistry(storage);
const mapper = new Mapper(storage);
const scanner = new Scanner(storage, { providers, models });
const verifier = new KeyVerifier(storage, { providers, models, mapper });
const bulkProber = new BulkProbe(storage, { providers, models, mapper });
const priority = new Priority(storage);
const metrics = new MetricsRegistry(storage);
// The router is given the same rules the UI edits, so a locked row really is
// left out of the rotation instead of only looking locked on screen.
const router = new Router(storage, { providers, models, mapper, priority, metrics });

// The rules the user set, read once per render so every list on screen sorts by
// the same priority instead of each list re-reading storage on its own.
let priorityState = null;
// Metrics are read once per render; every list on screen then shows the same
// numbers, so a model cannot look fast in the drawer and slow in the list.
let metricsMap = new Map();
// Counts for the drawer, computed once per render and read by urlRow. Kept at
// module level so the row builder needs only the provider.
let modelCountByProvider = new Map();
let keyCountByProvider = new Map();
// Every free model of each URL, kept for the URL menu: "lock every model of this
// URL" has to name the ids, and that menu is built without reading storage.
let modelIdsByProvider = new Map();

let activeFilter = 'free';
let searchTerm = '';
let busy = false;
let currentRun = null;
let currentModel = null;   // { providerId, modelId }, set when a model dialog opens
// The URL the drawer last jumped to. It marks a block and scrolls to it.
let focusProviderId = null;
// The URL the main list is narrowed to, or null for "every URL". Picking a URL
// in the drawer sets it: the drawer answers "which URL", and the list below then
// answers "what is in this one". `focusProviderId` only marks and scrolls; this
// one is what actually hides the other URLs.
let urlScope = null;
// Which URL and model a sheet is asking about. Both sheets can be opened from a
// row that is not "the current model", so neither may read `currentModel`: a
// manual test opened from a model's action sheet would otherwise run against
// whichever model was opened last - or against nothing at all.
let testTarget = null;     // { providerId, modelId }
let bulkProviderId = null; // whose key list the bulk sheet is showing
let URL_SORT = 'manual';  // how the drawer is ordered; see URL_SORTS
// What the drawer is narrowed to. Separate from the model search because the two
// answer different questions: `searchTerm` picks models out of the flat list,
// while these pick URLs out of the drawer. Sharing one would make typing a URL
// name in the drawer silently hide models from the list behind it.
let urlSearchTerm = '';
let urlClass = 'all';     // 'all' | 'nokey' | 'needkey'; see URL_CLASSES
let revealedKeys = new Set();
// The AI tab: one conversation and one budget. `aiHistory` holds the turns that
// were actually answered; an in-flight turn joins it only on success, so a
// failed call can never poison the next prompt with a half-written reply.
let aiHistory = [];
let aiRun = null;
const aiAgent = new Agent(router);

// ---------------------------------------------------------------- helpers

function toast(text) {
  const el = $('toast');
  el.textContent = text;
  el.classList.add('on');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('on'), 2200);
}

function log(text) {
  const root = $('logRoot');
  const line = document.createElement('div');
  line.textContent = text;
  root.prepend(line);
  while (root.childElementCount > 200) root.lastElementChild.remove();
}

function setBusy(value) {
  busy = value;
  for (const id of ['btnScanAll', 'btnAddUrl', 'appbarAddUrl']) {
    const el = $(id);
    if (el) el.disabled = value;
  }
  // The bottom bar's scan button runs the same job, so it has to be disabled
  // too. A second scan started while one is running would race on the same
  // provider rows and leave half of them written twice.
  for (const btn of document.querySelectorAll('.tabbar-btn')) {
    if (btn.dataset.goto === 'scan') btn.disabled = value;
  }
  $('btnCancel').hidden = !value;
}

async function copyText(text, label = 'Đã chép') {
  try {
    await navigator.clipboard.writeText(text);
    toast(label);
  } catch {
    // Clipboard API needs a secure context; the fallback keeps copy working
    // when the page is opened from a plain file:// or a bare IP.
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.append(ta);
    ta.select();
    try {
      document.execCommand('copy');
      toast(label);
    } catch {
      toast('Không chép được');
    }
    ta.remove();
  }
}

function timeAgo(iso) {
  const at = Date.parse(iso ?? '');
  if (!Number.isFinite(at)) return 'chưa quét';
  const mins = Math.floor((Date.now() - at) / 60000);
  if (mins < 1) return 'vừa xong';
  if (mins < 60) return `${mins} phút trước`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} giờ trước`;
  return `${Math.floor(hours / 24)} ngày trước`;
}

// ---------------------------------------------------------------- tree

/**
 * Every model shown in the main list is a 0đ one.
 *
 * "0đ" means exactly two things, and both are evidence rather than a guess: the
 * provider published a price of zero, or the model's name says free. That rule
 * lives in core/free-detector.js so the list, the chips and every count that
 * reads "N model 0đ" answer the same question the same way.
 *
 * A model whose price nobody published is not in this list. A model with a price
 * above zero is not in it under any chip: the screen exists to answer "what can I
 * use for nothing", and a paid row inside it is a trap.
 */

/**
 * The two tabs.
 *
 * "0đ" and "Chắc 0đ" used to be two chips, but a model priced at zero is also
 * free, so the two sets overlapped and telling them apart was a rule the user
 * had to learn. They are one tab now - `free` - meaning exactly what the list
 * means: a published price of zero, or a name that says free.
 *
 * `unknown` (shown as "Null") deliberately includes a record with no
 * `freeStatus` at all - one written by an older version of the app, or by a
 * provider that published no status - because an equality test would drop such
 * a row from every tab and leave it invisible with no way to find it. It is the
 * way back to the models the default list hides, and hiding them is not the
 * same as throwing them away.
 */
const FILTERS = {
  free: (m) => isFreeModel(m),
  unknown: (m) => isUnknownPrice(m),
};

// Kept so a stale bookmarked chip name cannot silently widen the list.
FILTERS.paid = () => false;
FILTERS.all = FILTERS.free;
// A chip named "zero" may survive in a cached shell; folding it into `free`
// keeps an old bookmark from crashing the render it was written to open.
FILTERS.zero = FILTERS.free;

/** What the count under the title calls the rows it is counting. */
const FILTER_LABEL = {
  free: 'model 0đ',
  unknown: 'model chưa rõ giá',
};
FILTER_LABEL.zero = FILTER_LABEL.free;

function filterBy(filter) {
  activeFilter = FILTERS[filter] ? filter : 'free';
  for (const chip of document.querySelectorAll('.chip')) {
    chip.classList.toggle('on', chip.dataset.filter === activeFilter);
  }
  render();
}

/**
 * The panes the tab row and the bottom bar both switch between.
 *
 * One map, so the two navigation surfaces cannot end up pointing at different
 * panes - which is what makes "API" open something on one and "Sức khoẻ" open
 * something else on the other.
 */
const TAB_PANES = { keys: 'paneKeys', health: 'paneHealth', log: 'paneLog', ai: 'paneAI' };

/** Show one pane and mark the matching tab. */
function showTab(name) {
  for (const [tab, id] of Object.entries(TAB_PANES)) $(id).hidden = tab !== name;
  for (const t of document.querySelectorAll('.tab')) {
    t.classList.toggle('on', t.dataset.tab === name);
  }
}

/** Mark one bottom-bar button, so the bar answers "where am I" on its own. */
function markTabBar(target) {
  for (const btn of document.querySelectorAll('.tabbar-btn')) {
    btn.classList.toggle('on', btn.dataset.goto === target);
  }
}

/**
 * Drawer: every URL is its own entry, and the main list shows the free models
 * of whichever one is open. The lists are never merged into a single block -
 * a URL is a thing the user owns, so it stays addressable.
 */
function openDrawer(open) {
  document.body.classList.toggle('nav-open', open);
  $('scrim').hidden = !open;
  // The button ships with aria-expanded, so a screen reader is told the drawer is
  // closed from the first paint - but nothing was ever keeping it true. A
  // control that claims a state it never updates is worse than one with no
  // state at all, because the announcement is now wrong rather than absent.
  $('btnMenu')?.setAttribute?.('aria-expanded', String(open));
}

function toggleDrawer() {
  openDrawer(!document.body.classList.contains('nav-open'));
}

/**
 * Draw the bar that names the URL the list is narrowed to.
 *
 * It is the label and the way back in one object: the URL being shown, and the
 * button that stops showing it. `null` hides it, because with every URL on
 * screen there is nothing to clear.
 */
function renderScopeBar(provider) {
  const bar = $('scopeBar');
  if (!bar) return;
  bar.hidden = !provider;
  if (!provider) return;
  const name = $('scopeName');
  const url = $('scopeUrl');
  if (name) name.textContent = provider.name;
  if (url) url.textContent = provider.baseURL;
}

/**
 * Scroll the flat list to one URL's block.
 *
 * Walked from the drawn children rather than by a CSS attribute selector: a
 * provider id is generated, and a selector built from it would be one quoting
 * mistake away from throwing on every tap.
 */
function scrollToProvider(providerId) {
  const root = $('treeRoot');
  const section = [...(root?.children ?? [])].find((el) => el.dataset?.providerId === providerId);
  section?.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
}

/**
 * How the drawer is ordered.
 *
 * `manual` is the arrangement the user dragged, and it is the default because a
 * hand-made order is itself a decision: choosing which URL to try first is the
 * whole point of having a drawer. The other three are read-only views over the
 * same list, for when the question is "which one is worth opening" rather than
 * "which one did I put first".
 *
 * Only `manual` reads the stored order. Letting a name or count order inherit a
 * dragged arrangement would mix two different answers into one list.
 */
const URL_SORTS = {
  name: (a, b) => a.name.localeCompare(b.name, 'vi'),
  models: (a, b) =>
    (modelCountByProvider.get(b.id) ?? 0) - (modelCountByProvider.get(a.id) ?? 0) ||
    a.name.localeCompare(b.name, 'vi'),
  keys: (a, b) =>
    (keyCountByProvider.get(b.id) ?? 0) - (keyCountByProvider.get(a.id) ?? 0) ||
    a.name.localeCompare(b.name, 'vi'),
};

/**
 * The two URL classes, plus the way back to all of them.
 *
 * This is a different question from how the list is ordered, and it gets a
 * different control: "cần key" and "không cần key" are facts about a URL that
 * a scan already decided, while the order is only how those facts are read.
 *
 * The third class a URL can hide in - "chưa kiểm tra" - has no button on
 * purpose. It is not a kind of URL the user chose; it is a scan that has not
 * happened yet, and offering it as a peer of the other two would make "chưa
 * biết" look like a standing classification instead of a gap to close.
 */
const URL_CLASSES = {
  all: () => true,
  nokey: (p) => requirementOf(p) === KEY_REQ.NONE,
  needkey: (p) => requirementOf(p) === KEY_REQ.REQUIRED,
};

/** Does this URL match what the drawer's search box was given? */
function urlMatchesSearch(provider, needle) {
  if (!needle) return true;
  return (
    provider.name.toLowerCase().includes(needle) ||
    String(provider.baseURL ?? '').toLowerCase().includes(needle)
  );
}

/**
 * The drawer is narrowed to something.
 *
 * A narrowed drawer is a view, not the list the user arranged: the drag order is
 * read back from whatever rows are on screen, so dragging while a filter hides
 * half the URLs would write an order that silently dropped the hidden half.
 * Dragging is therefore offered only when every URL is drawn.
 */
function urlsFiltered() {
  return urlSearchTerm.trim() !== '' || urlClass !== 'all';
}

/**
 * Paint the state of the URL controls: which class is on, whether the free-count
 * order is on, and whether the search box has anything to clear.
 *
 * Called from the render and from every handler, so the buttons show the state
 * the app is actually in even when a render was triggered by something else.
 */
function markUrlControls() {
  for (const btn of document.querySelectorAll('.classbtn')) {
    const on = btn.dataset.urlclass === urlClass;
    btn.classList.toggle('on', on);
    btn.setAttribute?.('aria-pressed', String(on));
  }
  const free = $('urlSortFree');
  if (free) {
    const on = URL_SORT === 'models';
    free.classList.toggle('on', on);
    free.setAttribute?.('aria-pressed', String(on));
  }
  const clear = $('urlSearchClear');
  if (clear) clear.hidden = !urlSearchTerm;

  // The gesture legend tells the truth about the list it sits under. While a
  // filter is on, dragging is off - so the line says what to do to get it back
  // instead of naming a gesture that would do nothing.
  const hint = $('sideHint');
  if (hint) {
    hint.textContent = urlsFiltered()
      ? 'Đang lọc URL · xoá ô tìm hoặc bấm "Tất cả" để kéo sắp xếp lại'
      : 'Nhấn giữ một dòng để kéo · bấm biểu tượng khoá để loại khỏi vòng quay';
  }
}

/**
 * Apply the chosen order to the drawer.
 *
 * Locked URLs sink to the bottom rather than disappearing. A locked URL is out
 * of the rotation, and the quickest way to stop it competing for the top is to
 * stop showing it there - but it stays listed, because a row the user cannot
 * find is a row they will add a second time.
 */
function sortUrls(providerRows) {
  const isManual = URL_SORT === 'manual';

  // Only the manual view reads the dragged order AND the rotation rule. The other
  // three are plain comparisons, so they get neither: passing the rotation
  // through would leave a row that was dragged once permanently at the top of
  // every view, which is not what "sort by name" is asking for.
  if (!isManual) return [...providerRows].sort(URL_SORTS[URL_SORT] ?? URL_SORTS.name);
  return applyPriority(providerRows, SCOPE.PROVIDER, URL_SORTS.name);
}

/**
 * Move locked URLs to the end of one group.
 *
 * Applied per group rather than to the whole drawer: the grouping is what says
 * which URLs can be used at all, and a locked URL still belongs where it was
 * classified. It just stops competing for the top of that group, because it is
 * out of the rotation.
 */
function sinkLocked(rows) {
  const locked = skippedFor(SCOPE.PROVIDER);
  if (!locked.size) return rows;
  return [...rows.filter((r) => !locked.has(r.id)), ...rows.filter((r) => locked.has(r.id))];
}

/**
 * The drawer: every URL, split by whether it can be used right now.
 *
 * The split answers the question a new user actually has. A URL that needs a key
 * cannot be scanned until the user goes and gets one, so listing it beside the
 * ones that work immediately would imply it is ready too. Grouping says which
 * is which without making the user read each row.
 */
async function renderSidebar(providerRows, modelRows, keyRows) {
  const root = $('sidebarRoot');
  root.replaceChildren();

  // Counts first, because two of the four sort orders are "most of something"
  // and need the numbers before the rows can be put in order.
  modelCountByProvider = new Map();
  for (const model of modelRows) {
    if (model.active === false) continue;
    if (model.freeStatus === FREE.PAID) continue;
    modelCountByProvider.set(model.providerId, (modelCountByProvider.get(model.providerId) ?? 0) + 1);
  }

  keyCountByProvider = new Map();
  for (const key of keyRows) {
    keyCountByProvider.set(key.providerId, (keyCountByProvider.get(key.providerId) ?? 0) + 1);
  }

  // The whole list, before the drawer's own search and classification narrow it.
  // Locking every URL and the drag order are both facts about every URL the user
  // owns, so neither may be derived from the rows a transient view happens to
  // draw.
  const allProviders = providerRows;

  const classMatch = URL_CLASSES[urlClass] ?? URL_CLASSES.all;
  const needle = urlSearchTerm.trim().toLowerCase();
  providerRows = sortUrls(
    providerRows.filter((p) => classMatch(p) && urlMatchesSearch(p, needle))
  );

  markUrlControls();

  if (!allProviders.length) {
    root.append(emptyNote('Chưa có URL nào.'));
    return;
  }

  mountLockAll($('lockAllUrls'), SCOPE.PROVIDER, allProviders.map((p) => p.id));

  if (!providerRows.length) {
    root.append(emptyNote('Không có URL nào khớp. Xoá ô tìm URL hoặc chọn lại cách phân loại.'));
    return;
  }

  // Grouped by what a real scan actually returned, not by what a URL is
  // expected to need. A hand-added URL that has never been probed lands in its
  // own group instead of being claimed as "needs a key" - nobody has asked it.
  //
  // Sunk after grouping, never before. Sorting the locked URLs to the end of the
  // flat list and only then splitting into groups would move every locked URL
  // into whichever group happened to be rendered last - so locking one "chưa
  // kiểm tra" URL would reclassify it as "cần API key", which says something
  // completely different about it.
  const groups = groupByRequirement(providerRows);
  for (const requirement of Object.keys(groups)) groups[requirement] = sinkLocked(groups[requirement]);
  for (const requirement of [KEY_REQ.NONE, KEY_REQ.REQUIRED, KEY_REQ.UNKNOWN]) {
    const meta = KEY_REQ_META[requirement];
    renderUrlGroup(root, groups[requirement], meta.title, meta.hint);
  }

  // The drawer is one sortable list, headings included. That matters: the saved
  // order is read back from the DOM on every drop, so the group headings have to
  // be written back alongside the URLs - otherwise reordering would collapse
  // the three groups back into one block and the classification would stop
  // being visible on the next render.
  //
  // A heading is not draggable and carries no sortId, so it can never be picked
  // up; it only anchors its group. The ids written back are therefore exactly
  // the URLs, in the order they appear across all three groups.
  //
  // Skipped entirely while a URL search or classification is on. The saved order
  // is read back from whatever rows are on screen, so a drop made on a narrowed
  // list would store an order holding only the visible URLs and silently lose
  // the position of every hidden one.
  if (!urlsFiltered()) makeSortable(root, providerRows, SCOPE.PROVIDER, (p) => p.id);
}

/**
 * One titled group of URLs.
 *
 * The heading carries no data-sortId, so the drag handler skips it: a heading
 * that could be picked up and dropped between two URLs would be a bug.
 */
function renderUrlGroup(root, providers, title, hint) {
  if (!providers.length) return;

  const head = document.createElement('div');
  head.className = 'urlgroup';

  const label = document.createElement('span');
  label.className = 'urlgroup-title';
  label.textContent = title;

  // The reason the group exists, on the group. It is the difference between
  // "cần API key" being a rule the user has to know and being a fact they can
  // read, and it costs one line per group.
  if (hint) {
    const why = document.createElement('span');
    why.className = 'urlgroup-hint';
    why.textContent = hint;
    why.title = hint;
    head.append(why);
  }

  const count = document.createElement('span');
  count.className = 'urlgroup-count';
  count.textContent = String(providers.length);
  count.title = hint;

  head.append(label, count);
  root.append(head);

  for (const provider of providers) root.append(urlRow(provider));
}

/** One URL row. Shared by both groups so they cannot drift apart. */
function urlRow(provider) {
  const item = document.createElement('div');
  item.className = 'urlitem';
  item.dataset.providerId = provider.id;
  if (provider.id === focusProviderId) item.classList.add('on');
  if (skippedFor(SCOPE.PROVIDER).has(provider.id)) item.classList.add('locked');

  const openBtn = document.createElement('button');
  openBtn.className = 'urlopen';
  openBtn.setAttribute?.('aria-label', `Mở danh sách model của ${provider.name}`);

  const free = modelCountByProvider.get(provider.id) ?? 0;
  const api = keyCountByProvider.get(provider.id) ?? 0;

  // Three lines, in the order the questions get asked: what is it, where does
  // it point, and what is in it. The base URL is on the row rather than hidden
  // in a tooltip because two entries can share a name and the URL is what tells
  // them apart at a glance.
  const name = document.createElement('span');
  name.className = 'uname';
  name.textContent = provider.name;

  const base = document.createElement('span');
  base.className = 'ubase';
  base.textContent = provider.baseURL;

  const meta = document.createElement('span');
  meta.className = 'umeta';
  meta.textContent = free || api
    ? `${free} model 0đ · ${api} API${api === 1 ? '' : ''}`
    : 'chưa quét';

  openBtn.append(name, base, meta);

  // The badge states what it takes to use this URL, which the group heading
  // above also says. It is repeated because the row has to stay readable on its
  // own, and because the group heading collapses away while scrolling.
  const requirement = requirementOf(provider);
  const reqMeta = KEY_REQ_META[requirement];
  const badge = document.createElement('span');
  badge.className = 'urlbadge ' + reqMeta.tagClass;
  badge.textContent = reqMeta.tag;
  badge.title =
    (provider.note ? provider.note + '\n' : '') +
    reqMeta.hint +
    (requirement === KEY_REQ.REQUIRED && api ? `\nĐã có ${api} key trên URL này.` : '');
  openBtn.append(badge);

  openBtn.addEventListener('click', async () => {
    // Picking a URL narrows the list below to it: the drawer answers "which
    // URL", and the list then answers "what is in this one". The bar under the
    // app bar names it and carries the way back to every URL.
    urlScope = provider.id;
    focusProviderId = provider.id;
    openDrawer(false);
    await render();
    scrollToProvider(provider.id);
  });

  item.dataset.sortId = provider.id;
  // A long press on a URL opens the action sheet, so the row does not have to
  // carry four buttons to stay usable. The lock stays on the row because it is
  // the one control a user reaches for repeatedly while tuning a rotation.
  attachRowMenu(item, () => urlActions(provider));
  item.append(openBtn, lockButton('provider', provider.id));
  return item;
}

/**
 * Everything that can be done to one URL, as a list.
 *
 * Shown in a sheet on a long press rather than as buttons on the row: five
 * controls on a row that is 70px tall leaves nothing for the name, which is the
 * one thing the row is actually for.
 */
/**
 * The rotation rules, in the order the URL menu steps through them.
 *
 * One list, so the label that names the current rule and the value it switches to
 * can never disagree about which rule is next.
 */
const ROTATION_CHOICES = [
  [ROTATION.SPEED, 'model nhanh nhất trước'],
  [ROTATION.MANUAL, 'đúng thứ tự tôi kéo'],
  [ROTATION.ROUND_ROBIN, 'chia đều lượt dùng'],
];

/**
 * Everything that can be done to one URL, as a list.
 *
 * One sheet per URL, reached from the ⋮ on that URL's header, because the main
 * list shows every URL at once and a header button can only ever mean one of
 * them. Everything that used to be a control on the URL's own block - the
 * rotation rule, lock-every-model, clear-my-settings - lives here now: the block
 * itself is the data, and the sheet is where the data is configured.
 */
function urlActions(provider) {
  const modelsHere = modelIdsByProvider.get(provider.id) ?? [];
  const api = keyCountByProvider.get(provider.id) ?? 0;
  const lockedHere = modelsHere.filter((m) => skippedFor(SCOPE.MODEL).has(m.id));
  const allLocked = modelsHere.length > 0 && lockedHere.length === modelsHere.length;
  const rotation = provider.priority?.rotation ?? priorityState?.rotation ?? ROTATION.SPEED;
  const step = Math.max(0, ROTATION_CHOICES.findIndex(([value]) => value === rotation));

  const actions = [
    { icon: 'scan', label: 'Quét lại URL này', sub: 'Lấy danh sách model mới nhất', run: () => scanOne(provider) },
    { icon: 'wrench', label: 'Quét nhiều model', sub: 'Mỗi model 0đ thử lần lượt các API của URL', run: () => openBulkDialog(provider) },
    { icon: 'info', label: 'Danh sách model free', sub: `${modelsHere.length} model 0đ · bấm để sửa/xoá/thêm`, run: () => openModelList(provider) },
    { icon: 'key', label: 'Danh sách API', sub: `${api} API · xem hoạt động chưa · sửa/xoá/thêm`, run: () => openKeyList(provider) },
    // The label is the current rule rather than a question about it: a dropdown
    // hides the answer, and "why is this list in this order" is exactly the
    // question a user has when a model they expected is not first.
    {
      icon: 'refresh',
      label: `Quay vòng: ${ROTATION_CHOICES[step][1]}`,
      sub: 'Bấm để đổi cách URL này chọn model',
      run: () => setUrlRotation(provider, ROTATION_CHOICES[(step + 1) % ROTATION_CHOICES.length][0]),
    },
    {
      icon: allLocked ? 'unlock' : 'lock',
      label: allLocked ? 'Mở khoá model ở URL này' : 'Khoá model ở URL này',
      sub: `${modelsHere.length} model 0đ · ${lockedHere.length} đang bị khoá`,
      warn: !allLocked,
      run: () => setAllLocked(SCOPE.MODEL, modelsHere.map((m) => m.id), !allLocked),
    },
    {
      icon: 'trash',
      label: 'Xoá cấu hình riêng',
      sub: 'Bỏ khoá và thứ tự riêng, quay về cấu hình chung',
      run: () => clearUrlSettings(provider),
    },
  ];

  if (provider.websiteURL) {
    actions.push(
      { icon: 'globe', label: 'Mở website', sub: provider.websiteURL, run: () => {
        try { window.open(provider.websiteURL, '_blank', 'noopener,noreferrer'); }
        catch { copyText(provider.websiteURL, 'Không mở được, đã chép website'); }
      } },
      { icon: 'copy', label: 'Chép website', sub: provider.websiteURL, run: () => copyText(provider.websiteURL, 'Đã chép website') },
    );
  }
  actions.push(
    { icon: 'copy', label: 'Chép base URL', sub: provider.baseURL, run: () => copyText(provider.baseURL, 'Đã chép URL') },
  );
  return sheet(provider.name, `${provider.baseURL}${api ? ` · ${api} API` : ''}`, actions);
}

/** Set this URL's rotation rule and repaint everything that reads it. */
async function setUrlRotation(provider, value) {
  await priority.setProviderPriority(provider.id, { rotation: value });
  toast('Đã lưu cách quay vòng cho URL này');
  await refreshPriority();
}

/** Drop this URL's overrides and go back to the shared settings. */
async function clearUrlSettings(provider) {
  await priority.setProviderPriority(provider.id, {
    rotation: null,
    skipped: null,
    order: null,
  });
  // Row-level model locks are dropped too, otherwise "clear this URL's settings"
  // would leave the list still filtered by rows the user can no longer see.
  for (const model of modelIdsByProvider.get(provider.id) ?? []) {
    await priority.setSkipped(SCOPE.MODEL, model.id, false);
  }
  toast('Đã xoá cấu hình riêng của URL này');
  await refreshPriority();
}

/** Everything that can be done to one API key, as a list. */
function keyActions(provider, key) {
  const ownLock = skippedFor(SCOPE.KEY).has(key.id);
  return [
    { icon: 'eye', label: 'Hiện và chép key', sub: key.masked ?? '', run: () => revealKey(provider, key) },
    { icon: 'check', label: 'Check API này', sub: 'Gửi một request nhỏ để kiểm tra còn sống không', run: () => checkOneKey(provider, key) },
    ownLock
      ? { icon: 'unlock', label: 'Mở khoá API này', sub: 'Đưa vào vòng quay', run: () => unlockSubtree('key', key.id) }
      : { icon: 'lock', label: 'Khoá API này', sub: 'Tạm không dùng, vẫn giữ trong danh sách', warn: true, run: () => toggleLock('key', key.id) },
    { icon: 'trash', label: 'Xoá API này', sub: 'Xoá khỏi storage, không tự quay vại', danger: true, run: () => openDeleteDialog(provider, key) },
  ];
}

/**
 * Open a dialog as a sheet.
 *
 * Two things go wrong if this is just `showModal()`. Tapping a row that is
 * already open throws, because a modal dialog cannot be shown twice - and on a
 * phone that happens every time the sheet is left open behind another one. And
 * a dialog that is already on screen has to be closed first, because opening a
 * second one on top of it leaves the first one modal: the page behind stays
 * unscrollable and there is no visible way back to it.
 */
function openSheet(id) {
  const dialog = $(id);
  if (!dialog) return;
  if (dialog.open) {
    dialog.close();
  }
  // A modal dialog locks the page behind it. Closing every other open sheet
  // first is what keeps a second one from trapping the user in a stack of
  // sheets they cannot see the bottom of.
  for (const other of document.querySelectorAll('dialog')) {
    if (other !== dialog && other.open) other.close();
  }
  dialog.showModal();
}

/** One row's sheet, in the three parts the sheet renders. */
function sheet(title, sub, actions) {
  return { title, sub, actions };
}

/**
 * Read a sheet description.
 *
 * A plain array is accepted as well as the object, so a caller that hands over
 * a bare list of actions still opens a usable sheet instead of throwing inside
 * a timer - where the failure would look like a random crash with no stack
 * pointing at the cause.
 */
function unpackSheet(built) {
  if (Array.isArray(built)) {
    // [title, sub, actions]
    if (built.length === 3 && !built.every((x) => typeof x === 'string')) {
      const [title, sub, actions] = built;
      if (Array.isArray(actions)) return { title, sub, actions };
    }
    return { title: '', sub: '', actions: built.filter((a) => a && typeof a === 'object') };
  }
  return {
    title: built?.title ?? '',
    sub: built?.sub ?? '',
    actions: Array.isArray(built?.actions) ? built.actions : [],
  };
}

/**
 * Open the action sheet for a row.
 *
 * A long press is the gesture that cannot be confused with anything else: a tap
 * opens the row, a drag reorders it, and a press that does neither has to mean
 * "what can I do with this". The same sheet is used for URLs, models and keys so
 * the app has one place where row actions live.
 */
function openRowMenu(title, sub, actions) {
  const box = $('rowMenuActions');
  box.replaceChildren();
  $('rowMenuTitle').textContent = title;
  $('rowMenuSub').textContent = sub ?? '';

  for (const action of actions) {
    const item = document.createElement('button');
    item.className =
      'action-item' + (action.danger ? ' danger' : '') + (action.warn && !action.danger ? ' warn' : '');
    item.append(icon(action.icon));
    const grow = document.createElement('span');
    grow.className = 'grow';
    grow.append(document.createTextNode(action.label));
    if (action.sub) {
      const sub = document.createElement('span');
      sub.className = 'sub';
      sub.textContent = action.sub;
      grow.append(sub);
    }
    item.append(grow);
    item.addEventListener('click', async () => {
      $('rowMenu').close();
      await action.run();
    });
    box.append(item);
  }

  openSheet('rowMenu');
}

/**
 * Wire a long press on a row to its action sheet.
 *
 * The press has to survive the drag gesture that shares the same pointer: both
 * listen for pointerdown, and whichever claims the gesture first wins. The drag
 * claims it only after a hold, and it cancels its hold the moment the finger
 * moves, so a press that never moves always reaches the sheet.
 */
function attachRowMenu(row, build) {
  let holdTimer = null;
  let fired = false;
  let pointerId = null;
  let stillSince = 0;

  const cancel = () => {
    if (holdTimer) clearTimeout(holdTimer);
    holdTimer = null;
  };

  const showSheet = () => {
    holdTimer = null;
    if (pointerId === null) return;
    // A row that has lifted for a reorder stays a reorder. Both gestures are
    // triggered by a press, so the tie has to be broken by the one thing that
    // tells them apart: a reorder moves the row, and a menu press never does.
    if (ownsGesture(row, 'drag')) return;
    fired = true;
    haptic();
    claimGesture(row, 'menu');
    // `build` answers one question - what can be done to this row - and returns
    // the sheet's three parts. Every row kind answers it the same way, so the
    // sheet never has to know which row it came from.
    const parts = unpackSheet(build());
    openRowMenu(parts.title, parts.sub, parts.actions);
  };

  row.addEventListener('pointerdown', (event) => {
    if (event.pointerType === 'mouse') return;
    fired = false;
    pointerId = event.pointerId;
    cancel();
    // The sheet opens only once the finger has been still long enough. A finger
    // that travels is a reorder, and it has already claimed the row by then.
    stillSince = performanceNow();
    holdTimer = setTimeout(showSheet, ROW_MENU_HOLD_MS);
  });

  // Every movement restarts the wait. This is what separates the two gestures
  // without either of them having to win a race: hold still and the sheet
  // opens, move and the row is being reordered instead.
  row.addEventListener('pointermove', () => {
    if (pointerId === null) return;
    const moved = performanceNow() - stillSince;
    if (moved > 0) {
      // Moved at all: the sheet is off the table for this press.
      cancel();
      pointerId = null;
      return;
    }
    stillSince = performanceNow();
    holdTimer = setTimeout(showSheet, ROW_MENU_HOLD_MS);
  });

  row.addEventListener('pointerup', () => {
    pointerId = null;
    cancel();
    endPress(row);
  });
  row.addEventListener('pointercancel', () => {
    pointerId = null;
    cancel();
    endPress(row);
  });

  // A press that already opened the sheet must not also open the row behind it.
  row.addEventListener('click', (event) => {
    if (!fired) return;
    fired = false;
    event.preventDefault?.();
    event.stopPropagation?.();
  }, true);
}

/** Long enough to feel deliberate, short enough not to feel laggy. */
const ROW_MENU_HOLD_MS = 480;

async function render() {
  const [providerRows, modelRows, keyRows, mappingRows] = await Promise.all([
    providers.list(),
    models.list(),
    keys.list(),
    mapper.list(),
    loadPriority(),
  ]);
  // Metrics last: they are only needed once the model rows are known, and they
  // drive every sort on this screen.
  await loadMetrics(modelRows);

  // A URL the drawer jumped to may have been deleted; drop the mark rather than
  // try to scroll to a block that is no longer drawn.
  if (focusProviderId && !providerRows.some((p) => p.id === focusProviderId)) {
    focusProviderId = null;
  }
  // The narrowed-to URL can be deleted too. Falling back to "every URL" is
  // better than drawing an empty list with a bar naming a URL that is gone.
  const scopeProvider =
    (urlScope && providerRows.find((p) => p.id === urlScope)) || null;
  if (!scopeProvider) urlScope = null;
  const scopedRows = scopeProvider ? [scopeProvider] : providerRows;

  await renderSidebar(providerRows, modelRows, keyRows);

  const root = $('treeRoot');
  root.replaceChildren();
  renderScopeBar(scopeProvider);
  $('treeTitle').textContent = scopeProvider ? `Model 0đ · ${scopeProvider.name}` : 'Tất cả model 0đ';

  // Models and keys are bucketed once per render and every block below reads the
  // same buckets, so one URL's rows and its counts cannot disagree.
  const keysByProvider = new Map();
  for (const key of keyRows) {
    if (!keysByProvider.has(key.providerId)) keysByProvider.set(key.providerId, []);
    keysByProvider.get(key.providerId).push(key);
  }

  // Every free model of every URL, once. `listable` is what keeps a priced model
  // out of both tabs at every filter level; the tab only narrows further.
  const listable = modelRows.filter((m) => m.active !== false && m.freeStatus !== FREE.PAID);
  // The tabs count what is on screen. When the list is narrowed to one URL, a
  // count drawn over every URL would promise rows that this view cannot show.
  const viewListable = scopeProvider
    ? listable.filter((m) => m.providerId === scopeProvider.id)
    : listable;

  // Kept for the URL menu, which has to name every model of one URL to lock them
  // all and cannot read storage while it is building a sheet.
  modelIdsByProvider = new Map();
  for (const model of listable) {
    if (!modelIdsByProvider.has(model.providerId)) modelIdsByProvider.set(model.providerId, []);
    modelIdsByProvider.get(model.providerId).push(model);
  }

  // Each chip carries its own size. A chip that reads "Null" but is empty is
  // indistinguishable from one holding two models, so a user has to press it to
  // find out - and a dead chip looks broken rather than merely empty. Counting
  // here rather than in the handler is what keeps the chips and the list in
  // agreement: they are both derived from the same `viewListable`.
  for (const chip of document.querySelectorAll('.chip')) {
    const slot = chip.querySelector('.chip-count');
    if (!slot) continue;
    // Guarded, like `filterBy` above. A chip name the app no longer recognises
    // - a stale bookmark, a cached shell serving older markup - reached this as
    // an undefined function and took the whole render down with it, so the model
    // list the user asked for was never drawn at all.
    const countFor = FILTERS[chip.dataset.filter];
    if (!countFor) continue;
    const n = viewListable.filter((m) => countFor(m)).length;
    slot.textContent = n ? String(n) : '';
  }

  const matcher = FILTERS[activeFilter] ?? FILTERS.free;
  const needle = searchTerm.trim().toLowerCase();
  // The user's pin and order decide first; the free-status rank is only the
  // tie-break, so an untouched list still leads with the verified free models.
  const rank = {
    [FREE.FREE_VERIFIED]: 0,
    [FREE.FREE_LIKELY]: 1,
    [FREE.FREE_UNKNOWN]: 2,
    [FREE.PAID]: 3,
  };

  let shown = 0;
  let shownUrls = 0;

  for (const provider of sortUrls(scopedRows)) {
    // A search that names the URL brings back all of its models. With every URL
    // on one screen, "openrouter" is a thing worth typing into the search box,
    // and answering "no models match" would be the wrong answer.
    const urlMatches =
      !needle ||
      provider.name.toLowerCase().includes(needle) ||
      String(provider.baseURL ?? '').toLowerCase().includes(needle);

    const mine = [];
    for (const model of modelIdsByProvider.get(provider.id) ?? []) {
      if (!matcher(model)) continue;
      if (
        urlMatches ||
        model.modelId.toLowerCase().includes(needle) ||
        String(model.displayName ?? '').toLowerCase().includes(needle)
      ) {
        mine.push(model);
      }
    }
    if (!mine.length) continue;

    // Ordered per URL, because the same model id can exist on several URLs and
    // each one may have been arranged differently.
    const rules = effectiveFor(provider);
    const ordered = applyPriority(
      mine,
      SCOPE.MODEL,
      (a, b) =>
        (rank[a.freeStatus] ?? 4) - (rank[b.freeStatus] ?? 4) ||
        a.modelId.localeCompare(b.modelId),
      { order: rules.order, rotation: rules.rotation }
    );

    // Every free model is rendered. There is no "show more": a limit here would
    // silently hide models the user already scanned for, and the count above
    // would stop matching the list.
    root.append(urlSection(provider, ordered, keysByProvider.get(provider.id) ?? []));
    shown += ordered.length;
    shownUrls += 1;
  }

  // The hidden set is named rather than silent. A list that quietly drops models
  // a scan just found reads as a broken scan; a count says the models are here
  // and one tap away behind their own chip.
  const hiddenUnknown =
    activeFilter === 'unknown' ? 0 : viewListable.filter((m) => isUnknownPrice(m)).length;
  $('filterCount').textContent =
    `${shown} ${FILTER_LABEL[activeFilter] ?? FILTER_LABEL.free} · ${shownUrls} URL` +
    (hiddenUnknown ? ` · ${hiddenUnknown} chưa rõ giá ẩn` : '');

  if (!shown) {
    root.append(
      emptyNote(
        searchTerm
          ? 'Không có model nào khớp. Xoá ô tìm kiếm để xem lại.'
          : 'Chưa có model 0đ nào. Bấm QUÉT TẤT CẢ URL để lấy danh sách model.'
      )
    );
  }

  await renderKeys(providerRows);
  await renderHealth(mappingRows, keyRows, modelRows);
}

/**
 * One URL and its 0đ models, as one block of the flat list.
 *
 * The header is sticky because it is the only place the URL is written on this
 * screen: it answers "which URL am I looking at" while the eye is on a model id
 * somewhere down a long list. It is also the copy target for the URL, and the ⋮
 * beside it is where everything about this URL is configured - so the three
 * things this screen is for (URL, model, API) are each one tap from the screen
 * the user is already on.
 */
function urlSection(provider, models, keys) {
  const box = document.createElement('section');
  box.className = 'urlblock';
  box.dataset.providerId = provider.id;
  if (provider.id === focusProviderId) box.classList.add('on');
  if (skippedFor(SCOPE.PROVIDER).has(provider.id)) box.classList.add('locked');

  // ---- the sticky header: the URL itself, and a tap to copy it ----
  const head = document.createElement('div');
  head.className = 'urlhead';

  const copy = document.createElement('button');
  copy.className = 'urlcopy';
  copy.title = `Chép URL: ${provider.baseURL}`;
  copy.setAttribute?.('aria-label', `Chép URL ${provider.baseURL}`);

  const name = document.createElement('span');
  name.className = 'uname';
  name.textContent = provider.name;

  const base = document.createElement('span');
  base.className = 'ubase';
  base.textContent = provider.baseURL;

  const meta = document.createElement('span');
  meta.className = 'umeta';
  meta.textContent = `${models.length} model 0đ · ${keys.length} API`;

  copy.append(name, base, meta);
  copy.addEventListener('click', () => copyText(provider.baseURL, 'Đã chép URL'));

  const menu = iconButton('dots', `Thao tác với URL ${provider.name}`, () => {
    const parts = unpackSheet(urlActions(provider));
    openRowMenu(parts.title, parts.sub, parts.actions);
  });

  head.append(copy, menu, lockButton('provider', provider.id));
  box.append(head);

  // ---- the models ----
  const group = document.createElement('div');
  group.className = 'group';
  for (const model of models) group.append(modelRow(provider, model, keys));
  // The dragged order is written to this URL, and the container is this URL's own
  // group, so a row can never be dropped into another URL's list.
  makeSortable(group, models, SCOPE.MODEL, (m) => m.id, { providerId: provider.id });
  box.append(group);

  return box;
}

/**
 * One API key of this URL, on a model row, as a copy target.
 *
 * A key belongs to the URL, not to a model, so the same chip sits beside every
 * model of that URL - which is exactly the truth the row is telling: any of these
 * keys works with any of these models. The masked form is what is on screen;
 * tapping reveals and copies in one gesture, through the one function allowed to
 * put a secret on the screen.
 */
function apiChip(provider, key) {
  const chip = document.createElement('button');
  chip.className = 'apichip';

  const shown = revealedKeys.has(key.id);
  chip.title = shown ? 'Bấm để chép lại API này' : 'Bấm để hiện và chép API này';
  chip.setAttribute?.('aria-label', `${shown ? 'API' : 'API đang che'} ${key.masked ?? ''}`);

  const dot = document.createElement('span');
  dot.className = 'kdot ' + key.status;

  const text = document.createElement('span');
  text.className = 'apiname';
  if (shown) {
    // revealedText is the audited sink for a full secret; nothing else here is
    // allowed to put one on the screen.
    text.textContent = revealedText(key);
  } else {
    // Computed first, so no assignment to textContent ever holds the raw secret.
    const maskedText = key.masked ?? maskSecret(key.secret);
    text.textContent = maskedText;
  }

  chip.append(dot, text);
  chip.addEventListener('click', () => revealKey(provider, key));
  return chip;
}

function modelRow(provider, model, keys = []) {
  const row = document.createElement('div');
  row.className = 'model';
  row.dataset.modelId = model.modelId;

  // The free level is on the row as data, not only as a colour in the stylesheet,
  // so the dot and the legend can never drift apart: one says "this is what
  // verified-free looks like", the other says "this is what free looks like".
  row.dataset.level = model.freeStatus;

  // A locked row stays visible and editable. It is only left out of the
  // rotation, so hiding it would make it look deleted.
  // Inherited from its URL, or locked on its own. Both look locked; only the
  // second one is a lock the user can undo from this row alone.
  const ownLock = skippedFor(SCOPE.MODEL).has(model.id);
  const urlLock = skippedFor(SCOPE.PROVIDER).has(provider.id);
  if (ownLock || urlLock) row.classList.add('locked');

  // Tapping the model opens its card. The id it used to copy is the top line of
  // that card, so the copy is at most one tap further and a tap now answers
  // "what is this", which is what the row is for. The fast action did not
  // disappear either: the ✓ beside the row checks the model without opening
  // anything, which is the shortcut that used to be missing.
  const openBtn = document.createElement('button');
  openBtn.className = 'modelopen';
  openBtn.title = `Xem thông tin model ${model.modelId}`;
  openBtn.setAttribute?.('aria-label', `Xem thông tin model ${model.modelId}`);

  const dot = document.createElement('span');
  dot.className = 'free';

  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = model.modelId;

  // The published facts, read from the catalog entry the scan already stored.
  // Nothing here is measured by us and nothing is guessed: each chip appears
  // only because the provider stated it, so a model card never claims a context
  // window or a capability nobody published.
  const info = modelInfo(model);
  const facts = document.createElement('span');
  facts.className = 'facts';
  const chips = [];
  if (info.displayName) chips.push({ text: info.displayName, cls: 'fname', title: info.displayName });
  if (info.context) chips.push({ text: `${formatCount(info.context)} ngữ cảnh`, cls: '', title: `Cửa sổ ngữ cảnh: ${info.context.toLocaleString('vi-VN')} token` });
  if (info.maxOutput) chips.push({ text: `trả tối đa ${formatCount(info.maxOutput)}`, cls: '', title: `Số token tối đa mỗi câu trả lời: ${info.maxOutput.toLocaleString('vi-VN')}` });
  if (info.supportsVision) chips.push({ text: 'có ảnh', cls: 'cap', title: 'Nhận ảnh đầu vào' });
  if (info.supportsTools) chips.push({ text: 'có tool', cls: 'cap', title: 'Hỗ trợ gọi tool / function' });
  if (info.supportsReasoning) chips.push({ text: 'suy luận', cls: 'cap', title: 'Hỗ trợ chế độ suy luận' });
  if (info.released) {
    const age = ageOf(info.released);
    chips.push({ text: age, cls: 'age', title: `Phát hành ${info.released} (${age})` });
  }
  for (const chip of chips) {
    const el = document.createElement('span');
    el.className = 'chip-fact ' + chip.cls;
    el.textContent = chip.text;
    if (chip.title) el.title = chip.title;
    facts.append(el);
  }

  // A provider that publishes nothing leaves the row without a second line, and
  // an empty second line reads as a rendering failure rather than as "this URL
  // told us nothing". The placeholder says which of the two it is.
  if (!chips.length) {
    const none = document.createElement('span');
    none.className = 'chip-fact none';
    none.textContent = 'URL chưa công bố thông tin';
    none.title = 'URL này không có mô tả, cửa sổ ngữ cảnh hay khả năng cho model này.';
    facts.append(none);
  }
  // The description is the one piece too long for a row, so it lives in the
  // title where a long press can reach it without crowding the list.
  if (info.description) facts.title = info.description;

  // The measured numbers, when there are any. An unmeasured model shows a dash
  // rather than a zero, because "not measured yet" and "measured at 0 tok/s"
  // are not the same thing.
  const speed = document.createElement('span');
  speed.className = 'speed';
  const measured = metricsMap.get(`${model.providerId}::${model.modelId}`);
  if (measured?.samples) {
    // Only a real measurement gets the green treatment. Leaving "chưa đo" in
    // the same colour as a measured 42 tok/s would make an unmeasured model look
    // like the fastest one in the list.
    speed.classList.add('measured');
    const parts = [];
    if (Number.isFinite(measured.tokensPerSec)) parts.push(`${formatMetric(measured.tokensPerSec, { digits: 1 })} tok/s`);
    if (Number.isFinite(measured.ttftMs)) parts.push(`${formatMetric(measured.ttftMs)}ms`);
    speed.textContent = parts.join(' · ') || `${measured.samples} lần đo`;
    speed.title =
      `tốc độ output: ${formatMetric(measured.tokensPerSec, { digits: 1 })} tok/s\n` +
      `phản hồi lần đầu: ${formatMetric(measured.ttftMs)}ms\n` +
      `tổng thời gian: ${formatMetric(measured.totalMs)}ms\n` +
      `đã đo ${measured.samples} lần (tốt nhất ${formatMetric(measured.bestTokensPerSec, { digits: 1 })} tok/s)`;
  } else {
    speed.textContent = 'chưa đo';
    speed.title = 'Chạy check API để đo tốc độ của model này';
  }

  // Name and facts travel together in the middle column, so the speed figure on
  // the right stays aligned across rows regardless of how many chips a model
  // happens to have.
  const mid = document.createElement('span');
  mid.className = 'mid';
  mid.append(name, facts);

  // No trailing info glyph: the whole row already opens the model card, so a
  // second information mark beside it would only repeat what the row does. The
  // fast action - check this model - is the ✓ on the right.
  openBtn.append(dot, mid, speed);
  openBtn.addEventListener('click', () => openModelDialog(provider, model));

  row.dataset.sortId = model.id;
  // No long press on a model any more: a tap opens the card, where every per-
  // model action now lives. The press had nothing left to offer that the card
  // does not, and a gesture nobody can discover is worse than a button. The row
  // keeps the press-hold drag it shares with every other sortable list.
  row.append(openBtn);

  // The URL's API keys, on a second line of the same row. They sit here rather
  // than only inside the model card because the three things this screen is for -
  // URL, model, API - are then visible at once, and each is one tap to copy.
  if (keys.length) {
    const apis = document.createElement('div');
    apis.className = 'apichips';
    for (const key of keys) apis.append(apiChip(provider, key));
    row.append(apis);
  }

  row.append(
    // The card moved to the row's own tap, so this square is free for the action
    // a user reaches for most: check this model right now against the URL's keys,
    // without opening anything.
    iconButton('check', `Check nhanh ${model.modelId} với API của URL này`, () => checkModelQuick(provider, model)),
    lockButton('model', model.id, { inherited: urlLock && !ownLock })
  );
  return row;
}

function emptyNote(text) {
  const div = document.createElement('div');
  div.className = 'empty';
  div.textContent = text;
  return div;
}

// ------------------------------------------------------- model dialog

/**
 * The full model card, in the dialog.
 *
 * Everything here was already stored by the scan; this only reads it. A field
 * the provider did not publish is left out rather than shown as a dash, because
 * "they did not say" and "they said zero" are different answers and the second
 * one would be a claim nobody can back up.
 */
function renderModelInfo(model) {
  const box = $('modelInfo');
  box.replaceChildren();

  const info = modelInfo(model);
  const rows = [];

  if (info.displayName) rows.push(['tên', info.displayName]);
  if (info.context) rows.push(['ngữ cảnh', `${info.context.toLocaleString('vi-VN')} token (${formatCount(info.context)})`]);
  if (info.maxOutput) rows.push(['trả tối đa', `${info.maxOutput.toLocaleString('vi-VN')} token (${formatCount(info.maxOutput)})`]);
  if (info.modalities.length) rows.push(['đầu vào', info.modalities.join(', ')]);
  if (info.supportsTools) rows.push(['tool', 'có (function calling)']);
  if (info.supportsVision) rows.push(['ảnh', 'có']);
  if (info.supportsReasoning) rows.push(['suy luận', 'có']);
  if (info.released) rows.push(['phát hành', `${info.released} · ${ageOf(info.released)}`]);

  // Price is shown only when it is not free. The list this dialog belongs to is
  // free-only, so a zero here is noise and a non-zero is a warning.
  if (info.inputPrice || info.outputPrice) {
    rows.push(['giá', `${formatPrice(info.inputPrice)} vào · ${formatPrice(info.outputPrice)} ra`]);
  }

  const measured = metricsMap.get(`${model.providerId}::${model.modelId}`);
  if (measured?.samples) {
    const bits = [];
    if (Number.isFinite(measured.tokensPerSec)) bits.push(`${formatMetric(measured.tokensPerSec, { digits: 1 })} token/giây`);
    if (Number.isFinite(measured.ttftMs)) bits.push(`${formatMetric(measured.ttftMs)}ms phản hồi đầu`);
    if (Number.isFinite(measured.totalMs)) bits.push(`${formatMetric(measured.totalMs)}ms tổng`);
    if (measured.promptTokens != null || measured.completionTokens != null) {
      bits.push(`${measured.promptTokens ?? 0} vào · ${measured.completionTokens ?? 0} ra`);
    }
    rows.push(['đo được', `${bits.join(' · ')} (${measured.samples} lần đo)`]);
    if (Number.isFinite(measured.bestTokensPerSec) && Number.isFinite(measured.worstTokensPerSec ?? null)) {
      rows.push(['nhanh nhất', `${formatMetric(measured.bestTokensPerSec, { digits: 1 })} token/giây`]);
    }
  } else {
    rows.push(['đo được', 'chưa đo — bấm ✓ trên một API để chạy thử']);
  }

  if (!rows.length) {
    box.append(emptyNote('URL này không công bố thông tin cho model này.'));
    return;
  }

  for (const [label, value] of rows) {
    const line = document.createElement('div');
    line.className = 'inforow';
    const key = document.createElement('span');
    key.className = 'infokey';
    key.textContent = label;
    const val = document.createElement('span');
    val.className = 'infoval';
    val.textContent = value;
    line.append(key, val);
    box.append(line);
  }

  if (info.description) {
    const desc = document.createElement('div');
    desc.className = 'infodesc';
    desc.textContent = info.description;
    box.append(desc);
  }
}

async function openModelDialog(provider, model) {
  currentModel = { providerId: provider.id, modelId: model.modelId };

  $('modelTitle').textContent = model.modelId;
  $('modelHint').textContent =
    `${FREE_META[model.freeStatus]?.label ?? ''} · ${model.source === MODEL_SOURCE.MANUAL ? 'thêm tay' : 'tự quét'}`;

  $('boxUrl').textContent = provider.baseURL;
  $('boxModel').textContent = model.modelId;

  renderModelInfo(model);

  // The sheet opens first and fills in afterwards. The other order reads the
  // whole key list before anything appears, so on a slow phone the tap looks
  // like it did nothing for a second - and if the list read fails, the sheet
  // never opens at all and the tap looks broken rather than empty.
  // A fresh card starts with no chat open: the chat belongs to one key and one
  // model, and carrying a stale one across a re-open would show a conversation
  // that does not match what is on screen.
  closeChat();
  openSheet('modelDialog');
  await renderKeyRows(provider);
}

// --------------------------------------------- chat test with one API
//
// The card's API rows are the configuration; picking one opens a small chat
// against that exact key and model. It is deliberately a real conversation
// rather than a one-shot probe: the probe answers "alive", and the thing a user
// wants to know before wiring a model into an app is "what does it actually
// say". Nothing here writes a verdict - it is a question, not a health check.

/** The key and model the chat is currently talking through, or null. */
let chatTarget = null; // { providerId, keyId, modelId }

/** Close the chat panel and forget its target. */
function closeChat() {
  chatTarget = null;
  const field = $('chatField');
  if (field) field.hidden = true;
}

/** One line in the chat log: who said it, and what they said. */
function appendChat(role, text) {
  const log = $('chatLog');
  if (!log) return;
  const line = document.createElement('div');
  line.className = 'chatmsg ' + role;
  const who = document.createElement('span');
  who.className = 'chat-who';
  who.textContent = role === 'you' ? 'Bạn' : role === 'model' ? 'Model' : 'Lỗi';
  const body = document.createElement('span');
  body.className = 'chat-text';
  body.textContent = text;
  line.append(who, body);
  log.append(line);
  log.scrollTop = log.scrollHeight;
}

/** Open the chat panel for one of this URL's keys. */
async function openChat(provider, key) {
  chatTarget = { providerId: provider.id, keyId: key.id, modelId: currentModel?.modelId ?? null };
  const field = $('chatField');
  if (!field) return;
  field.hidden = false;
  const name = $('chatKeyName');
  if (name) name.textContent = `${key.masked ?? ''} · ${STATUS_META[key.status]?.label ?? key.status}`;
  const log = $('chatLog');
  if (log) log.replaceChildren();
  appendChat(
    'model',
    `Đang chat bằng ${key.masked ?? ''} với model ${chatTarget.modelId ?? '?'}. Nhập tin nhắn rồi bấm GỬI.`
  );
  const input = $('chatInput');
  if (input) input.value = '';
  input?.focus?.();
}

/** Send one chat turn to the selected key/model and show what came back. */
async function sendChat() {
  if (!chatTarget) return;
  const provider = await providers.get(chatTarget.providerId);
  const key = await storage.get('keys', chatTarget.keyId);
  if (!provider || !key) {
    appendChat('error', 'Không tìm thấy URL hoặc API.');
    return;
  }

  const text = $('chatInput').value.trim() || TEST_DEFAULT_PROMPT;
  appendChat('you', text);
  $('chatInput').value = '';
  const send = $('chatSend');
  if (send) send.disabled = true;
  try {
    const adapter = providers.adapterFor(provider);
    const result = await adapter.chatOnce({
      model: chatTarget.modelId,
      secret: key.secret,
      message: text,
      maxTokens: 256,
    });
    if (result.ok) {
      appendChat('model', result.content ? String(result.content) : '(phản hồi rỗng)');
      log(`chat ${provider.name}/${chatTarget.modelId} bằng ${key.masked}: khỏe`);
    } else {
      const label = STATUS_META[result.status]?.label ?? result.status ?? 'lỗi';
      appendChat(
        'error',
        `${label}${result.httpStatus ? ` · HTTP ${result.httpStatus}` : ''}${result.error ? ` · ${result.error}` : ''}`
      );
    }
  } catch (error) {
    appendChat('error', error?.message ?? String(error));
  } finally {
    if (send) send.disabled = false;
  }
}

// --------------------------------------------- manual model test

/**
 * Test one model, one key, one prompt.
 *
 * This is deliberately not the verifier. The verifier asks "is this key alive on
 * this URL" and answers by trying models in order until one works, which is the
 * right question for a key and the wrong one for a model: a key that is healthy
 * on the URL's first model can still be dead on the model the user is looking
 * at. Only a request that names all three - this key, this model, this URL - can
 * tell you which.
 *
 * Nothing is written to storage. A manual test is a question, not a verdict:
 * overwriting a key's status from a single hand-typed prompt would make the
 * health list claim something the app does not actually know.
 */

/** The prompt used when the box is left empty. One word, eight tokens. */
const TEST_DEFAULT_PROMPT = 'Trả lời bằng một từ';
const TEST_MAX_TOKENS = 8;

async function openTestDialog(provider, model) {
  // Recorded before anything is drawn: the sheet names one model, and the run
  // has to send its request to the same one however the sheet was reached.
  testTarget = { providerId: provider.id, modelId: model.modelId };
  $('testUrl').textContent = provider.baseURL;
  $('testModel').textContent = model.modelId;
  $('testHint').textContent = `${provider.name} · ${model.modelId}`;
  setTestResult('Chưa chạy. Bấm ▶ CHẠY THỬ để gửi một request thật.', 'idle');

  const list = await keys.list(provider.id);
  const picker = $('testKey');
  picker.replaceChildren();

  if (!list.length) {
    // No key means no request can be made, and the reason has to be on the
    // screen before the run rather than after it.
    const none = document.createElement('option');
    none.value = '';
    none.textContent = 'URL này chưa có API key';
    picker.append(none);
    $('testRun').disabled = true;
  } else {
    for (const key of list) {
      const opt = document.createElement('option');
      opt.value = key.id;
      // The status travels with the name: picking between two masked keys that
      // look alike is otherwise guesswork.
      opt.textContent = `${key.masked} · ${STATUS_META[key.status]?.label ?? key.status}`;
      picker.append(opt);
    }
    $('testRun').disabled = false;
  }

  openSheet('testDialog');
}

/** Write the result box, with the state named in words as well as colour. */
function setTestResult(text, state) {
  const box = $('testResult');
  box.textContent = text;
  box.className = 'testresult testresult-' + state;
}

/** Turn one probe result into the four lines a person needs to judge it. */
function describeTestResult(result) {
  if (result.ok) {
    const m = result.metrics ?? {};
    const rows = [`Khỏe · HTTP ${result.httpStatus ?? 200}`, ''];
    // Timings are the whole point of running a test by hand, so they are shown
    // even when they are missing - as "không đo được" rather than as a blank,
    // because a blank reads as "fast" next to a number that reads as "slow".
    rows.push(`câu trả lời: ${result.content ? JSON.stringify(result.content) : '(rỗng)'}`);
    rows.push(`tổng thời gian: ${Number.isFinite(m.totalMs) ? `${m.totalMs}ms` : 'không đo được'}`);
    rows.push(`token đầu tiên: ${Number.isFinite(m.ttftMs) ? `${m.ttftMs}ms` : 'không đo được'}`);
    rows.push(`tốc độ: ${Number.isFinite(m.tokensPerSec) ? `${m.tokensPerSec} tok/s` : 'không đo được'}`);
    if (Number.isFinite(m.totalTokens)) rows.push(`token dùng: ${m.totalTokens}`);
    return { text: rows.join('\n'), state: 'ok' };
  }

  const label = STATUS_META[result.status]?.label ?? result.status ?? 'lỗi';
  const rows = [`Lỗi · ${label}`, ''];
  if (result.httpStatus) rows.push(`HTTP: ${result.httpStatus}`);
  rows.push(`thời gian chờ: ${Number.isFinite(result.latencyMs) ? `${result.latencyMs}ms` : 'không rõ'}`);
  rows.push(`chi tiết: ${result.error ?? 'không có'}`);
  // The two most common causes are worth naming, because the fix is different:
  // a bad key is fixed by pasting another one, a bad model by choosing another.
  if (result.status === STATUS.AUTH_INVALID || result.status === STATUS.EXPIRED) {
    rows.push('', '→ Thử một API key khác của URL này.');
  } else if (result.status === STATUS.MODEL_UNAVAILABLE || result.status === STATUS.MODEL_DENIED) {
    rows.push('', '→ Model này không dùng được với key đó. Thử model khác.');
  }
  return { text: rows.join('\n'), state: 'bad' };
}

async function runManualTest() {
  // The sheet's own target, never `currentModel`: this sheet is opened from a
  // model's action sheet as well as from its card, and only the card sets
  // `currentModel` - so reading it here would run the wrong model, or nothing.
  const target = testTarget;
  if (!target) return;
  const keyId = $('testKey').value;
  if (!keyId) {
    setTestResult('Chưa có API key nào trên URL này để gửi request.', 'bad');
    return;
  }

  const provider = await providers.get(target.providerId);
  const key = await storage.get('keys', keyId);
  if (!provider || !key) {
    setTestResult('Không tìm thấy URL hoặc API key.', 'bad');
    return;
  }

  const message = $('testPrompt').value.trim() || TEST_DEFAULT_PROMPT;
  const adapter = providers.adapterFor(provider);

  $('testRun').disabled = true;
  setTestResult('Đang gửi…', 'run');
  const startedAt = Date.now();
  try {
    const result = await adapter.probeWithMetrics({
      model: target.modelId,
      secret: key.secret,
      maxTokens: TEST_MAX_TOKENS,
    });
    const described = describeTestResult(result);
    // A real stopwatch as well as the server's own timings: when they disagree
    // the gap is usually the provider queueing, which neither number shows.
    setTestResult(`tổng thời gian đo tay: ${Date.now() - startedAt}ms\n${described.text}`, described.state);
    log(`thử tay ${provider.name}/${target.modelId} bằng ${key.masked}: ${described.state === 'ok' ? 'khỏe' : 'lỗi'}`);
  } catch (error) {
    setTestResult(`Lỗi không mong đợi\n${error?.message ?? error}`, 'bad');
  } finally {
    $('testRun').disabled = false;
  }
}

// --------------------------------------------- bulk probe

/**
 * One key across many models of one URL.
 *
 * The verifier stops at the first model that answers, because it is asking
 * about a key. This asks which models are alive, which no single request can
 * answer - so it spends one request per model, and pays for it in care: a
 * number the user chooses, an estimate shown before the run, a stop button, and
 * a self-interrupt once the failures stop looking like the model's fault.
 */

/** Set once the run is confirmed, so a re-render does not ask again. */
let bulkConfirmed = false;

async function openBulkDialog(provider) {
  const cfg = CONFIG.bulkProbe;
  bulkConfirmed = false;
  // The sheet shows one URL's key list, so the run has to know which URL that
  // was. `currentModel` belongs to whatever card was opened last, if any.
  bulkProviderId = provider.id;

  $('bulkUrl').textContent = provider.baseURL;
  $('bulkHint').textContent =
    `${provider.name} · mỗi model 0đ thử lần lượt các API của URL, dừng ở API đầu trả lời.`;
  $('bulkCap').textContent = `tối đa ${cfg.maxLimit}`;
  $('bulkLimit').value = String(cfg.defaultLimit);
  $('bulkProgress').textContent = '';
  $('bulkStop').hidden = true;

  // Keys are read in the rotation's own order, and every one is offered to the
  // run by default: the question this sheet answers is "which models work", and
  // a model is usable if any of the URL's keys opens it.
  const list = await keys.list(provider.id);
  const ordered = applyPriority(list, SCOPE.KEY, (a, b) => Number(!!b.verifiedModelId) - Number(!!a.verifiedModelId));
  fillBulkKeyPicker($('bulkKey'), ordered);

  if (!ordered.length) {
    // "No keys" and "keys not loaded" must not look the same to someone
    // deciding whether to add one or wait.
    $('bulkRows').replaceChildren(bulkEmptyNote('URL này chưa có API key.'));
    $('bulkRun').disabled = true;
  } else {
    $('bulkRun').disabled = false;
    $('bulkRows').replaceChildren(bulkEmptyNote('Chọn số model rồi bấm BẮT ĐẦU QUÉT.'));
  }

  updateBulkEstimate();
  openSheet('bulkDialog');
}

/**
 * The bulk key picker: every key by default, or one key to isolate a failure.
 *
 * Defaulting to all is the point of the sheet now - a model is checked against
 * the URL's keys in turn, and the run stops at the first that answers, so the
 * common case needs no choice at all.
 */
function fillBulkKeyPicker(picker, list) {
  picker.replaceChildren();
  const all = document.createElement('option');
  all.value = '__all__';
  all.textContent = `Tất cả API (${list.length}) — theo thứ tự ưu tiên`;
  picker.append(all);
  for (const key of list) {
    const opt = document.createElement('option');
    opt.value = key.id;
    // The status travels with the name: picking between two masked keys that
    // look alike is otherwise guesswork.
    opt.textContent = `${key.masked} · ${STATUS_META[key.status]?.label ?? key.status}`;
    picker.append(opt);
  }
  picker.value = '__all__';
}

function bulkEmptyNote(text) {
  const div = document.createElement('div');
  div.className = 'bulk-empty';
  div.textContent = text;
  return div;
}

/**
 * Read the requested number, bounded.
 *
 * An empty or nonsensical box falls back to the default rather than clamping to
 * 1: a user who cleared the field has not asked for a single model, and
 * silently starting a one-model run would be a different action than the one
 * they seem to be reaching for.
 */
function bulkLimitFromInput() {
  const cfg = CONFIG.bulkProbe;
  const raw = Number($('bulkLimit').value);
  if (!Number.isFinite(raw) || raw < 1) return cfg.defaultLimit;
  return Math.min(Math.floor(raw), cfg.maxLimit);
}

/** Say what the run will cost before it does it. */
function updateBulkEstimate() {
  const cfg = CONFIG.bulkProbe;
  const n = bulkLimitFromInput();
  const tokens = n * cfg.maxTokens;
  const box = $('bulkEstimate');

  box.textContent = [
    `${n} request`,
    `khoảng ${tokens.toLocaleString('vi-VN')} token output`,
    'model có phí không được chạy',
  ].join(' · ');

  // Past this the user is spending a real quota, and that should be said in a
  // different colour rather than left to be inferred from the number.
  box.className = n > 50 ? 'bulk-estimate warn' : 'bulk-estimate';
}

/** Paint one finished model. */
function bulkResultRow(entry) {
  const cfg = CONFIG.bulkProbe;
  const row = document.createElement('div');
  const hard = [STATUS.AUTH_INVALID, STATUS.EXPIRED, STATUS.QUOTA_EXHAUSTED].includes(entry.status);
  row.className = 'bulk-row ' + (entry.ok ? 'ok' : hard ? 'hard' : 'bad');

  const dot = document.createElement('span');
  dot.className = 'kdot ' + (entry.ok ? 'HEALTHY' : entry.status);

  const name = document.createElement('span');
  name.className = 'bulk-name';
  name.textContent = entry.modelId;

  const verdict = document.createElement('span');
  verdict.className = 'bulk-verdict';
  // The winning key travels with the verdict: on a URL with several keys the
  // useful fact is not only "this model works" but "this key opened it".
  verdict.textContent = entry.ok
    ? `khỏe${entry.keyMasked ? ` · ${entry.keyMasked}` : ''}`
    : (STATUS_META[entry.status]?.label ?? entry.status);

  const lat = document.createElement('span');
  lat.className = 'bulk-lat';
  lat.textContent = entry.ok && Number.isFinite(entry.ttftMs) ? `${entry.ttftMs}ms` : '';

  row.append(dot, name, verdict, lat);
  return row;
}

async function runBulkProbe() {
  const target = bulkProviderId ? await providers.get(bulkProviderId) : null;
  if (!target) return;

  const chosen = $('bulkKey').value;
  const list = await keys.list(target.id);
  const ordered = applyPriority(list, SCOPE.KEY, (a, b) => Number(!!b.verifiedModelId) - Number(!!a.verifiedModelId));
  // "Tất cả" is the default and the point: a model is checked against the URL's
  // keys in turn. Choosing one key isolates it, for the case "why does this
  // model fail when I expect another key to open it".
  const keyIds = chosen && chosen !== '__all__' ? [chosen] : ordered.map((k) => k.id);
  if (!keyIds.length) {
    $('bulkRows').replaceChildren(bulkEmptyNote('Chưa có API key nào để quét.'));
    return;
  }

  const n = bulkLimitFromInput();

  // A sheet is modal, so a second dialog on top of it would trap the user in a
  // stack they cannot see the bottom of. confirm() is ugly and always works.
  if (!bulkConfirmed) {
    const ok = globalThis.confirm?.(
      `Sẽ thử ${n} model 0đ với ${keyIds.length} API tới ${target.name}.
` +
      `Mỗi model dừng ngay ở API đầu tiên trả lời, nên tối đa ${(n * keyIds.length).toLocaleString('vi-VN')} request.

` +
      `Bấm OK để bắt đầu.`
    );
    if (!ok) return;
    bulkConfirmed = true;
  }

  $('bulkRun').disabled = true;
  $('bulkStop').hidden = false;
  currentRun = { cancelled: () => false, cancel: () => { currentRun.cancelled = () => true; } };

  const box = $('bulkRows');
  box.replaceChildren();

  try {
    const summary = await bulkProber.runAcrossKeys({
      providerId: target.id,
      keyIds,
      limit: n,
      run: currentRun,
      onProgress: ({ entry, index, total }) => {
        // One row at a time rather than a full render(): re-rendering the sheet
        // two hundred times would drop the scroll position and fight the finger.
        if (entry) box.append(bulkResultRow(entry));
        $('bulkProgress').textContent = `${index}/${total}`;
      },
    });

    const lines = [
      `quét ${target.name}: ${summary.healthy}/${summary.results.length} model khỏe · ${summary.requests} request`,
    ];
    if (summary.stopped) {
      lines.push(
        summary.stopReason === STOP.CANCELLED
          ? 'đã dừng theo yêu cầu'
          : summary.stopReason === STOP.QUOTA
            ? 'dừng: hết quota'
            : 'dừng: mọi API đều có vấn đề'
      );
    }
    log(lines.join(' · '));
    toast(summary.healthy ? `${summary.healthy} model khỏe` : 'Không model nào chạy được');

    if (!summary.results.length) {
      box.replaceChildren(bulkEmptyNote('URL này không có model 0đ để quét.'));
    }
  } catch (error) {
    log(`quét lỗi: ${error?.message ?? error}`);
    toast('Lỗi khi quét');
  } finally {
    currentRun = null;
    $('bulkRun').disabled = false;
    $('bulkStop').hidden = true;
    await refreshPriority();
  }
}

async function renderKeyRows(provider) {
  const list = await keys.list(provider.id);
  const box = $('keyRows');
  box.replaceChildren();
  $('keyCount').textContent = list.length;

  if (!list.length) {
    // Shown explicitly, because "no keys yet" and "keys not loaded" must not
    // look the same to someone deciding what to do next.
    const note = document.createElement('div');
    note.className = 'empty';
    note.textContent = 'URL này chưa có API. Bấm [+ THÊM API] để dán key, hệ thống sẽ check ngay.';
    box.append(note);
    return;
  }

  // Keys are ordered like everything else, so the one the rotation would try
  // first is also the one at the top of the list.
  // The rotation rule is the URL's, because that is where the user set it: a
  // key list shown under one URL follows that URL's rule, not the global one.
  const mine = effectiveFor(provider, SCOPE.KEY);
  const ordered = applyPriority(
    list,
    SCOPE.KEY,
    // A key that has proven itself sorts above one that has not.
    (a, b) => Number(!!b.verifiedModelId) - Number(!!a.verifiedModelId),
    { rotation: mine.rotation, order: mine.order }
  );

  for (const key of ordered) box.append(keyRow(provider, key));
  makeSortable(box, ordered, SCOPE.KEY, (k) => k.id);
  mountLockAll($('lockAllKeys'), SCOPE.KEY, ordered.map((k) => k.id));
}

function keyRow(provider, key) {
  const row = document.createElement('div');
  row.className = 'keyrow';
  row.dataset.keyId = key.id;

  const flex = document.createElement('div');
  flex.className = 'kflex';

  // Default masked; tapping the eye reveals and copies in one go.
  if (revealedKeys.has(key.id)) {
    const full = document.createElement('div');
    full.className = 'kfull';
    // revealedText is the audited sink for a full secret. Routing the value
    // through one named function keeps "where can a secret reach the screen"
    // answerable by reading a single definition instead of grepping the file.
    full.textContent = revealedText(key);
    flex.append(full);
  } else {
    const masked = document.createElement('div');
    masked.className = 'kmasked';
    // The masked form is computed first so no assignment to textContent ever
    // holds the raw secret - the guard test can then prove that by reading it.
    const maskedText = key.masked ?? maskSecret(key.secret);
    masked.textContent = maskedText;
    flex.append(masked);
  }

  // Status is a dot plus a word, never a dot alone: a coloured dot is exactly
  // the thing that disappears on a dim screen or to a colour-blind reader, and
  // "is this key any good" is the whole question this row answers.
  const stat = document.createElement('div');
  stat.className = 'kstat';
  const meta = STATUS_META[key.status] ?? { label: key.status };
  const dot = document.createElement('span');
  dot.className = 'kdot ' + key.status;
  const word = document.createElement('span');
  word.className = 'kword';
  word.textContent = key.verifiedModelId
    ? `khỏe · đã map ${key.verifiedModelId}`
    : (meta.label ?? key.status);
  stat.append(dot, word);
  flex.append(stat);
  // The masked/status block is the chat target: tapping the key itself asks
  // "what does this key say", while the buttons beside it do their own thing.
  flex.title = 'Bấm để chat thử với API này';
  flex.addEventListener('click', () => openChat(provider, key));
  row.append(flex);

  const shown = revealedKeys.has(key.id);
  // revealKey is the only path that puts a full secret on screen. It is
  // deliberately explicit and deliberately also copies, so the common case
  // ("show me the key") is one tap.
  const reveal = iconButton(shown ? 'eyeOff' : 'eye', shown ? 'Ẩn key' : 'Hiện và chép key', () =>
    revealKey(provider, key)
  );

  const check = iconButton('check', 'Check API này', () => checkOneKey(provider, key));
  const del = iconButton('trash', 'Xoá API này', () => openDeleteDialog(provider, key), 'iconbtn del');

  row.dataset.sortId = key.id;
  // A key is locked on its own, or by its URL. Only the URL case is inherited,
  // because a key row has no model of its own on screen.
  const ownLock = skippedFor(SCOPE.KEY).has(key.id);
  const urlLock = skippedFor(SCOPE.PROVIDER).has(provider.id);
  if (ownLock || urlLock) row.classList.add('locked');
  attachRowMenu(row, () => sheet(
    key.masked ?? '',
    `${provider.name} · ${STATUS_META[key.status]?.label ?? key.status}`,
    keyActions(provider, key)
  ));
  row.append(reveal, check, del, lockButton('key', key.id, { inherited: urlLock && !ownLock }));
  return row;
}

/**
 * The single place a full secret becomes display text.
 *
 * Kept separate from keyRow so the rule "a secret reaches the screen only after
 * an explicit reveal" can be checked by reading one function, and so a future
 * edit that renders a key somewhere else has an obvious place to be caught.
 */
function revealedText(key) {
  return key.secret;
}

/** Reveal a full key and copy it. The only place a secret is shown. */
async function revealKey(provider, key) {
  revealedKeys.add(key.id);
  copyText(key.secret, 'Đã chép key');
  // Both surfaces that can show a key are repainted: the key list inside the
  // model dialog, and the API chip on whichever model row was tapped. They are
  // separate renders, so the one the user is not looking at would otherwise keep
  // showing the masked form and the tap would look broken there.
  await renderKeyRows(provider);
  await render();
}

// ------------------------------------------------------- keys tab

async function renderKeys(providerRows) {
  const all = await keys.list();
  const root = $('keysRoot');
  root.replaceChildren();

  if (!all.length) {
    // The global paste box and its CHECK button are gone, so this must point
    // at the control that exists now: the + API button on each URL.
    root.append(emptyNote('Chưa có API nào. Mở một URL rồi bấm [+ API] để dán key cho URL đó.'));
    return;
  }

  const byProvider = new Map();
  for (const key of all) {
    if (!byProvider.has(key.providerId)) byProvider.set(key.providerId, []);
    byProvider.get(key.providerId).push(key);
  }

  for (const provider of providerRows) {
    const list = byProvider.get(provider.id);
    if (!list?.length) continue;

    const group = document.createElement('div');
    group.className = 'group';
    const head = document.createElement('div');
    head.className = 'group-head';
    const name = document.createElement('span');
    name.className = 'grow';
    name.textContent = provider.name;
    const meta = document.createElement('span');
    meta.className = 'meta';
    meta.textContent = `${list.length} key`;
    head.append(name, meta);
    group.append(head);

    // Same order as the model dialog, so the two views never disagree.
    const ordered = applyPriority(
      list,
      SCOPE.KEY,
      (a, b) => Number(!!b.verifiedModelId) - Number(!!a.verifiedModelId)
    );
    for (const key of ordered) group.append(keyRow(provider, key));
    makeSortable(group, ordered, SCOPE.KEY, (k) => k.id);
    root.append(group);
    root.append(lockAllButton(SCOPE.KEY, ordered.map((k) => k.id)));
  }
}

// ------------------------------------------------------- health tab

async function renderHealth(mappingRows, keyRows, modelRows) {
  const root = $('healthRoot');
  root.replaceChildren();

  if (!mappingRows.length) {
    root.append(emptyNote('Chưa có mối nào được kiểm tra.'));
    return;
  }

  const keyById = new Map(keyRows.map((k) => [k.id, k]));
  const modelByKey = new Map(modelRows.map((m) => [`${m.providerId}::${m.modelId}`, m]));
  const providerById = new Map((await providers.list()).map((p) => [p.id, p]));

  for (const mapping of mappingRows) {
    const line = document.createElement('div');
    line.className = 'rowline';

    const key = keyById.get(mapping.keyId);
    const model = modelByKey.get(`${mapping.providerId}::${mapping.modelId}`);
    const provider = providerById.get(mapping.providerId);
    const meta = STATUS_META[mapping.status] ?? { label: mapping.status };

    // Dot plus the word, like every other status in the app. This pane answers
    // "what is actually alive", and a coloured dot alone is unreadable for
    // exactly the people most likely to be checking.
    const status = document.createElement('span');
    status.className = 'kdot ' + mapping.status;
    const label = document.createElement('span');
    label.className = 'grow';
    label.textContent =
      `${provider?.name ?? '?'} · ${model?.modelId ?? mapping.modelId} · ${key?.masked ?? '?'}`;
    const word = document.createElement('span');
    word.className = 'kword';
    word.textContent = meta.label ?? mapping.status;
    const lat = document.createElement('span');
    lat.className = 'lat';
    lat.textContent = Number.isFinite(mapping.latencyMs) ? `${mapping.latencyMs}ms` : '';
    line.append(status, label, word, lat);
    root.append(line);
  }
}

// ------------------------------------------------------- actions

async function scanOne(provider) {
  setBusy(true);
  try {
    const result = await scanner.scanProvider({ providerId: provider.id, force: true });
    if (result.ok) {
      log(`quét ${provider.name}: +${result.added} model (${result.free} free)`);
      toast(result.added ? `+${result.added} model` : 'Không có model mới');
    } else {
      log(`quét ${provider.name} lỗi: ${result.reason}`);
      toast(`Lỗi: ${result.reason}`);
    }
  } finally {
    setBusy(false);
    await render();
  }
}

async function scanEverything() {
  setBusy(true);
  currentRun = { cancelled: () => false, cancel: () => { currentRun.cancelled = () => true; } };
  log('— quét tất cả URL —');
  try {
    const summary = await scanner.scanAll({ force: true, onProgress: (e) => log(`quét ${e.position}/${e.total} · ${e.provider}`) });
    log(
      `xong: ${summary.providers} URL · +${summary.added} model · ` +
      `${summary.skipped} bỏ qua · ${summary.failed} lỗi`
    );
    // Nothing to "land on": the main list holds every URL at once, so a first
    // scan fills the screen the user is already looking at.
    toast(summary.added ? `+${summary.added} model` : 'Không có model mới');
  } catch (error) {
    log('lỗi quét: ' + (error?.message ?? error));
  } finally {
    setBusy(false);
    currentRun = null;
    await render();
  }
}

async function checkOneKey(provider, key) {
  setBusy(true);
  try {
    const result = await verifier.verifyKey({ keyId: key.id });
    if (result.ok) {
      log(`${key.masked} khỏe qua ${result.verifiedModelId} (${result.attempted} request)`);
      toast('Key dùng được');
    } else {
      log(`${key.masked} lỗi: ${result.reason ?? 'không rõ'}`);
      toast('Key lỗi');
    }
  } finally {
    setBusy(false);
    await render();
    await renderKeyRows(provider);
    // The API list is its own surface with its own check buttons, so a verdict
    // from one of them has to repaint that list too - otherwise the dot beside
    // the key it just checked would keep the old colour.
    if ($('keyDialog')?.open) await renderKeyList(provider);
  }
}

async function checkAllKeysOfCurrentModel() {
  if (!currentModel) return;
  const provider = await providers.get(currentModel.providerId);
  if (!provider) return;
  setBusy(true);
  try {
    const result = await verifier.verifyProvider({ providerId: provider.id });
    log(`check ${provider.name}: ${result.requests} request · ${result.ok ? 'có key khỏe' : 'không key nào khỏe'}`);
    toast(result.ok ? 'Có key dùng được' : 'Không key nào dùng được');
  } finally {
    setBusy(false);
    await render();
    await renderKeyRows(provider);
  }
}

/**
 * Check one model against this URL's keys, stopping at the first that answers.
 *
 * This is the fast path the row's ✓ runs: no sheet, no picker, no prompt - just
 * "does this model work right now". It spends at most one request per key and
 * writes exactly what any other check writes, so the speed line and the health
 * pane update from it. Keys are tried in the order the rotation would, so the
 * check agrees with what the router would actually do.
 */
async function checkModelQuick(provider, model) {
  const list = await keys.list(provider.id);
  if (!list.length) {
    toast('URL này chưa có API để check');
    return;
  }
  const ordered = applyPriority(list, SCOPE.KEY, (a, b) => Number(!!b.verifiedModelId) - Number(!!a.verifiedModelId));
  setBusy(true);
  try {
    const adapter = providers.adapterFor(provider);
    let winner = null;
    let last = null;
    for (const key of ordered) {
      const result = await adapter.probeWithMetrics({
        model: model.modelId,
        secret: key.secret,
        maxTokens: CONFIG.probe.maxTokens,
      });
      last = result;
      const { mapping } = await mapper.upsert({ providerId: provider.id, modelId: model.modelId, keyId: key.id });
      await mapper.record(mapping.id, result);
      if (result.ok) {
        if (result.metrics) await metrics.record(provider.id, model.modelId, result.metrics);
        winner = key;
        break;
      }
    }
    if (winner) {
      log(`check ${provider.name}/${model.modelId}: khỏe với ${winner.masked}`);
      toast('Model dùng được');
    } else {
      log(
        `check ${provider.name}/${model.modelId}: không API nào chạy được ` +
        `(${STATUS_META[last?.status]?.label ?? 'lỗi'})`
      );
      toast('Không API nào chạy được');
    }
  } finally {
    setBusy(false);
    await render();
    if ($('modelDialog')?.open && currentModel?.providerId === provider.id) await renderKeyRows(provider);
  }
}

// ------------------------------------------------------- add key

/** The key row being edited in the API-list dialog, or null for a fresh add. */
let keyEditingId = null;

/**
 * One dialog, two jobs: a list of this URL's API keys, and the form that adds
 * or edits one. The list is the default because "quản lý API" is mostly
 * looking at what is there; the form is a step inside it.
 */
function setKeyDialogMode(mode) {
  const listMode = mode === 'list';
  const list = $('keyList');
  const addBtn = $('keyListAdd');
  const form = $('keyForm');
  if (list) list.hidden = !listMode;
  if (addBtn) addBtn.hidden = !listMode;
  if (form) form.hidden = listMode;
  const confirm = $('keyConfirm');
  if (confirm) confirm.hidden = listMode;
  const cancel = $('keyCancel');
  if (cancel) cancel.textContent = listMode ? 'Đóng' : 'Huỷ';
}

function openAddKeyDialog(provider) {
  keyEditingId = null;
  $('keyHint').textContent = `${provider.name} — ${provider.baseURL}`;
  $('keySecret').value = '';
  const confirm = $('keyConfirm');
  if (confirm) { confirm.textContent = 'Thêm + check'; confirm.hidden = false; }
  $('keyDialog').dataset.providerId = provider.id;
  setKeyDialogMode('form');
  openSheet('keyDialog');
  $('keySecret').focus();
}

/** Open the API list for one URL, with add / edit / delete inside it. */
async function openKeyList(provider) {
  keyEditingId = null;
  $('keyDialog').dataset.providerId = provider.id;
  await renderKeyList(provider);
  setKeyDialogMode('list');
  openSheet('keyDialog');
}

/**
 * The list of a URL's keys, each labelled by whether it works.
 *
 * "Hoạt động" is the whole point of this screen: a masked key says nothing
 * about whether it does anything, so each row pairs the dot with a word and,
 * when the key has proven itself, names the model it was checked against.
 */
async function renderKeyList(provider) {
  const box = $('keyList');
  box.replaceChildren();
  const list = await keys.list(provider.id);
  $('keyHint').textContent = `${provider.name} — ${list.length} API`;
  if (!list.length) {
    box.append(emptyNote('URL này chưa có API nào. Bấm “+ Thêm API” để dán key, hệ thống sẽ check ngay.'));
    return;
  }
  const ordered = applyPriority(list, SCOPE.KEY, (a, b) => Number(!!b.verifiedModelId) - Number(!!a.verifiedModelId));
  for (const key of ordered) box.append(keyListRow(provider, key));
}

function keyListRow(provider, key) {
  const row = document.createElement('div');
  row.className = 'listrow';

  const dot = document.createElement('span');
  dot.className = 'kdot ' + key.status;

  const name = document.createElement('span');
  name.className = 'lname';
  name.textContent = key.masked ?? '';

  const meta = document.createElement('span');
  meta.className = 'lmeta';
  meta.textContent = key.verifiedModelId
    ? `hoạt động · qua ${key.verifiedModelId}`
    : (STATUS_META[key.status]?.label ?? key.status);

  const grow = document.createElement('span');
  grow.className = 'grow';
  grow.append(name, meta);

  const check = iconButton('check', 'Check API này', () => checkOneKey(provider, key));
  const edit = iconButton('wrench', 'Đổi key / thay secret', () => startEditKey(provider, key));
  const del = iconButton('trash', 'Xoá API', () => {
    $('keyDialog').close();
    openDeleteDialog(provider, key);
  }, 'iconbtn del');

  row.append(dot, grow, check, edit, del);
  return row;
}

/** Swap the dialog into the form, preloaded for replacing one key's secret. */
function startEditKey(provider, key) {
  keyEditingId = key.id;
  $('keySecret').value = '';
  const confirm = $('keyConfirm');
  if (confirm) { confirm.textContent = 'Lưu key'; confirm.hidden = false; }
  $('keyHint').textContent = `Thay secret cho ${key.masked} — ${provider.name}`;
  setKeyDialogMode('form');
  $('keySecret').focus();
}

async function confirmAddKey() {
  const providerId = $('keyDialog').dataset.providerId;
  const secret = $('keySecret').value.trim();
  if (!providerId || !secret) {
    toast('Dán key vào trước đã');
    return;
  }

  setBusy(true);
  // Hoisted out of the try: the finally below refreshes the key rows, and a
  // block-scoped const was not visible there, so every add threw.
  let provider = null;
  try {
    provider = await providers.get(providerId);

    // Editing replaces the secret in place. Deleting and re-adding would
    // tombstone the old fingerprint, and pasting that same key again would then
    // be refused - a strange punishment for correcting a typo.
    if (keyEditingId) {
      const fingerprint = await fingerprintSecret(secret);
      await keys.update(keyEditingId, {
        secret,
        fingerprint,
        masked: maskSecret(secret),
        status: STATUS.UNTESTED,
        verifiedModelId: null,
        lastError: null,
      });
      const verified = await verifier.verifyKey({ keyId: keyEditingId });
      log(`đổi key → ${maskSecret(secret)} · ${verified.ok ? `khỏe qua ${verified.verifiedModelId}` : `lỗi: ${verified.reason ?? '?'}`}`);
      toast(verified.ok ? 'Key mới dùng được' : 'Key mới lỗi');
      keyEditingId = null;
      const confirm = $('keyConfirm');
      if (confirm) confirm.textContent = 'Thêm + check';
      if (provider) { await renderKeyList(provider); setKeyDialogMode('list'); }
      return;
    }

    const result = await keys.add({ providerId, secret });

    if (result.reason === 'BLOCKED') {
      log('key này đã bị xoá khỏi URL, không thêm lại');
      toast('Key đã xoá trước đó');
      return;
    }
    if (result.reason === 'DUPLICATE') {
      toast('URL này đã có key này rồi');
      return;
    }

    const verified = await verifier.verifyKey({ keyId: result.key.id });
    log(
      `${result.key.masked} + ${provider?.name ?? ''} · ` +
      (verified.ok ? `khỏe qua ${verified.verifiedModelId}` : `lỗi: ${verified.reason ?? '?'}`)
    );
    toast(verified.ok ? 'Key dùng được' : 'Key lỗi');
    // Back to the list, not shut: adding one key usually means wanting to see
    // it in place, and closing the sheet would make the user reopen it.
    if (provider) { await renderKeyList(provider); setKeyDialogMode('list'); }
  } finally {
    setBusy(false);
    await render();
    if (provider) await renderKeyRows(provider);
  }
}

// ------------------------------------------------------- delete key

function openDeleteDialog(provider, key) {
  $('delHint').textContent = `${key.masked} — ${provider.name}`;
  $('delSecret').value = '';
  $('delRestore').hidden = true;
  $('delDialog').dataset.keyId = key.id;
  $('delDialog').dataset.providerId = provider.id;
  openSheet('delDialog');
}

async function confirmDeleteKey() {
  const keyId = $('delDialog').dataset.keyId;
  const providerId = $('delDialog').dataset.providerId;
  await keys.remove(keyId);
  revealedKeys.delete(keyId);
  log('đã xoá 1 API');
  toast('Đã xoá');
  $('delDialog').close();
  await render();
  const provider = await providers.get(providerId);
  if (provider) await renderKeyRows(provider);
}

async function restoreDeletedKey() {
  const providerId = $('delDialog').dataset.providerId;
  const secret = $('delSecret').value.trim();
  if (!secret) {
    toast('Dán key đã xoá vào đây');
    return;
  }
  const result = await keys.restore(providerId, secret);
  if (result.created) {
    log('đã khôi phục 1 API');
    toast('Đã khôi phục');
    $('delDialog').close();
    await render();
    const provider = await providers.get(providerId);
    if (provider) await renderKeyRows(provider);
  } else {
    toast('Không tìm thấy key đã xoá');
  }
}

// ------------------------------------------------------- add url

function openAddUrlDialog() {
  $('urlName').value = '';
  $('urlBase').value = '';
  $('urlWebsite').value = '';
  $('urlModels').value = '';
  $('urlKey').value = '';
  openSheet('addUrlDialog');
  $('urlBase').focus();
}

async function confirmAddUrl() {
  const baseURL = $('urlBase').value.trim();
  if (!baseURL) {
    toast('Nhập Base URL');
    return;
  }

  setBusy(true);
  let provider = null;
  try {
    const result = await providers.upsert({
      name: $('urlName').value.trim(),
      baseURL,
      websiteURL: $('urlWebsite').value.trim(),
    });

    if (result.reason === 'DUPLICATE') {
      toast('URL này đã có trong danh sách');
      $('addUrlDialog').close();
      return;
    }

    provider = result.provider;
    const modelIds = parseManualModelList($('urlModels').value);
    for (const modelId of modelIds) {
      await models.addManual({ providerId: provider.id, modelId, freeStatus: FREE.FREE_UNKNOWN });
    }
    $('addUrlDialog').close();

    const scan = await scanner.scanProvider({ providerId: provider.id, force: true });
    if (scan.ok) {
      log(`${provider.name}: +${scan.added} model`);
      toast(`+${scan.added} model`);
    } else {
      log(`${provider.name}: không có /models (${scan.reason})`);
      toast('Đã thêm, nhưng không quét được model');
    }

    const secret = $('urlKey').value.trim();
    if (secret) {
      const keyResult = await keys.add({ providerId: provider.id, secret });
      if (keyResult.created) {
        const verified = await verifier.verifyKey({ keyId: keyResult.key.id });
        log(
          `${keyResult.key.masked} + ${provider.name} · ` +
          (verified.ok ? `khỏe qua ${verified.verifiedModelId}` : `lỗi: ${verified.reason ?? '?'}`)
        );
        toast(verified.ok ? 'URL đã thêm, key dùng được' : 'URL đã thêm, key lỗi');
      } else {
        toast(keyResult.reason === 'DUPLICATE' ? 'Key này đã có trên URL' : 'Không thêm được key');
      }
    }

    focusProviderId = provider.id;
    await render();
    scrollToProvider(provider.id);
    const saved = await providers.get(provider.id);
    if (saved) await renderKeyRows(saved);
  } finally {
    setBusy(false);
  }
}

function parseManualModelList(value) {
  const seen = new Set();
  for (const part of String(value ?? '').split(/[\n,]+/)) {
    const modelId = part.trim();
    if (modelId) seen.add(modelId);
  }
  return [...seen];
}

// ------------------------------------------------------- add model

/** The model row being edited in the model-list dialog, or null for a fresh add. */
let manualEditingId = null;

/**
 * The same dual-mode dialog as the API list: a list of this URL's 0đ models,
 * and the form that adds or edits one.
 */
function setModelDialogMode(mode) {
  const listMode = mode === 'list';
  const list = $('manualList');
  const addBtn = $('manualListAdd');
  const form = $('manualForm');
  if (list) list.hidden = !listMode;
  if (addBtn) addBtn.hidden = !listMode;
  if (form) form.hidden = listMode;
  const confirm = $('manualConfirm');
  if (confirm) confirm.hidden = listMode;
  const cancel = $('manualCancel');
  if (cancel) cancel.textContent = listMode ? 'Đóng' : 'Huỷ';
}

/** Open the 0đ model list for one URL, with add / edit / delete inside it. */
async function openModelList(provider) {
  manualEditingId = null;
  $('modelAddDialog').dataset.providerId = provider.id;
  await renderModelList(provider);
  setModelDialogMode('list');
  openSheet('modelAddDialog');
}

/**
 * The list of a URL's 0đ models, each editable and deletable in place.
 *
 * Only the models that appear in the main list are shown: a paid model belongs
 * to storage but not to this screen, and offering an edit button for something
 * the list refuses to draw would be a control with no visible effect.
 */
async function renderModelList(provider) {
  const box = $('manualList');
  box.replaceChildren();
  const all = (await models.list(provider.id)).filter((m) => m.freeStatus !== FREE.PAID);
  $('manualHint').textContent = `${provider.name} — ${all.length} model 0đ`;
  if (!all.length) {
    box.append(emptyNote('URL này chưa có model 0đ nào. Bấm “+ Thêm model” để thêm tay.'));
    return;
  }
  for (const model of all) box.append(modelListRow(provider, model));
}

function modelListRow(provider, model) {
  const row = document.createElement('div');
  row.className = 'listrow';

  const dot = document.createElement('span');
  dot.className = 'kdot ' + (model.source === MODEL_SOURCE.MANUAL ? 'UNTESTED' : 'HEALTHY');

  const name = document.createElement('span');
  name.className = 'lname';
  name.textContent = model.modelId;

  const meta = document.createElement('span');
  meta.className = 'lmeta';
  meta.textContent =
    `${FREE_META[model.freeStatus]?.label ?? model.freeStatus ?? ''}` +
    (model.source === MODEL_SOURCE.MANUAL ? ' · thêm tay' : '');

  const grow = document.createElement('span');
  grow.className = 'grow';
  grow.append(name, meta);

  const edit = iconButton('wrench', 'Sửa model này', () => startEditModel(provider, model));
  const del = iconButton('trash', 'Xoá model này', () => removeModel(provider, model), 'iconbtn del');

  row.append(dot, grow, edit, del);
  return row;
}

/** Switch the dialog to the add form. Called from the list's "+ Thêm model". */
function openManualModel(provider) {
  manualEditingId = null;
  $('manualHint').textContent = `${provider.name} — ${provider.baseURL}`;
  $('manualModel').value = '';
  $('manualFree').value = 'FREE_LIKELY';
  $('modelAddDialog').dataset.providerId = provider.id;
  const confirm = $('manualConfirm');
  if (confirm) { confirm.textContent = 'Thêm'; confirm.hidden = false; }
  setModelDialogMode('form');
  // Reopened so the form gets focus even when the list sheet was already open.
  openSheet('modelAddDialog');
  $('manualModel').focus();
}

/** Preload the form with an existing model, for editing. */
function startEditModel(provider, model) {
  manualEditingId = model.id;
  $('manualHint').textContent = `Sửa model · ${provider.name}`;
  $('manualModel').value = model.modelId;
  $('manualFree').value = model.freeStatus ?? 'FREE_LIKELY';
  const confirm = $('manualConfirm');
  if (confirm) { confirm.textContent = 'Lưu'; confirm.hidden = false; }
  setModelDialogMode('form');
  $('manualModel').focus();
}

/** Delete a model, after a confirm that names it. */
async function removeModel(provider, model) {
  const ok = globalThis.confirm?.(`Xoá model “${model.modelId}” khỏi URL này?`) ?? true;
  if (!ok) return;
  await models.remove(model.id);
  log(`đã xoá model ${model.modelId}`);
  toast('Đã xoá model');
  await render();
  await renderModelList(provider);
}

async function confirmAddModel() {
  const providerId = $('modelAddDialog').dataset.providerId;
  const modelId = $('manualModel').value.trim();
  if (!providerId || !modelId) {
    toast('Nhập tên model');
    return;
  }
  const freeStatus = $('manualFree').value;

  if (manualEditingId) {
    await models.update(manualEditingId, { modelId, displayName: modelId, freeStatus });
    log(`sửa model: ${modelId}`);
    toast('Đã lưu');
    manualEditingId = null;
  } else {
    const result = await models.addManual({ providerId, modelId, freeStatus });
    if (result.reason === 'DUPLICATE') {
      toast('Model này đã có');
    } else {
      log(`+ model thủ công: ${modelId}`);
      toast('Đã thêm');
    }
  }

  await render();
  const provider = await providers.get(providerId);
  if (provider) {
    await renderModelList(provider);
    setModelDialogMode('list');
  } else {
    $('modelAddDialog').close();
  }
}

// ---------------------------------------------------------------- AI tab

/**
 * One bubble in the AI log.
 *
 * Returns the body element, because a streamed answer is written into the
 * bubble token by token rather than being re-rendered per delta - one node that
 * grows beats a hundred that replace each other.
 */
function aiBubble(role, text = '') {
  const log_ = $('aiLog');
  const line = document.createElement('div');
  line.className = 'aibub ' + role;
  const who = document.createElement('span');
  who.className = 'aiwho';
  who.textContent = role === 'you' ? 'Bạn' : role === 'ai' ? 'AI' : 'Lỗi';
  const body = document.createElement('span');
  body.className = 'aitext';
  body.textContent = text;
  line.append(who, body);
  log_?.append(line);
  if (log_) log_.scrollTop = log_.scrollHeight;
  return body;
}

/** Show how much of the session's token budget is left. */
function aiPaintBudget() {
  const el = $('aiBudget');
  if (el) el.textContent = `${aiAgent.remaining.toLocaleString('vi-VN')} token còn lại`;
}

/**
 * Send one turn through the router and stream the answer into its bubble.
 *
 * Everything about *which* URL, model and key answers - and about rotating to
 * another one when a key is expired or out of quota - belongs to the router.
 * This function only orders the conversation and paints it.
 */
async function sendAiTurn() {
  if (aiRun) return;
  const input = $('aiInput');
  const text = input.value.trim();
  if (!text) return;

  input.value = '';
  aiBubble('you', text);

  const target = aiBubble('ai', '');
  const run = { cancelled: () => false, cancel: () => { run.cancelled = () => true; } };
  aiRun = run;
  $('aiSend').disabled = true;
  $('aiStop').hidden = false;
  aiPaintBudget();

  const who = $('aiWho');
  let used = null;
  let streamed = '';
  try {
    const result = await aiAgent.turn({
      history: aiHistory,
      userText: text,
      run,
      onToken: (delta) => {
        streamed += delta;
        target.textContent = streamed;
        const log_ = $('aiLog');
        if (log_) log_.scrollTop = log_.scrollHeight;
      },
      onEvent: (event) => {
        if (event.stage === 'attempt') {
          used = `${event.provider} · ${event.model}`;
          if (who) who.textContent = `đang gọi ${used}`;
        }
        if (event.stage === 'failed') {
          log(`AI thử ${event.provider}/${event.model ?? ''}: ${event.status ?? event.error ?? 'lỗi'}`);
        }
      },
    });

    if (result.ok) {
      aiHistory.push({ role: 'user', content: text });
      aiHistory.push({ role: 'assistant', content: result.content ?? '' });
      target.textContent = result.content || '(rỗng)';
      if (who) who.textContent = used ?? `${result.provider} · ${result.model}`;
      log(`AI trả lời qua ${result.provider}/${result.model}`);
    } else if (result.partial) {
      // Half the answer is already on screen. Swapping in another model's reply
      // mid-sentence would splice two answers together, so the part that arrived
      // is kept and the stop is named instead.
      target.textContent = `${streamed}\n… (dừng giữa chừng: ${result.status ?? 'lỗi'})`;
      log(`AI dừng giữa chừng: ${result.status ?? 'lỗi'}`);
    } else {
      const reason =
        result.reason === 'BUDGET_EXHAUSTED' ? 'đã hết hạn mức token của phiên'
          : result.reason === 'CANCELLED' ? 'đã dừng theo yêu cầu'
            : result.reason === 'NO_ELIGIBLE_MAPPING' ? 'không có URL/key nào dùng được — hãy thêm key hoặc quét trước'
              : `không gọi được (${result.reason ?? 'lỗi'})`;
      target.textContent = streamed || `Không trả lời được: ${reason}`;
      log(`AI lỗi: ${reason}`);
    }
  } finally {
    aiRun = null;
    $('aiSend').disabled = false;
    $('aiStop').hidden = true;
    if (who && !used) who.textContent = 'chưa gọi';
    aiPaintBudget();
  }
}

// ------------------------------------------------------- export config

/**
 * The working configuration, built once when the export sheet opens.
 *
 * It is kept in a module variable rather than rebuilt on every format change
 * because two of its three pieces - the moment of export and which mapping is
 * the default - would otherwise shift under the user as they flipped formats.
 */
let exportData = null;

/** Gather storage, build the export, and show the sheet. */
async function openExportDialog() {
  const [providerRows, keyRows, modelRows, mappingRows] = await Promise.all([
    providers.list(),
    keys.list(),
    models.list(),
    mapper.list(),
  ]);
  if (!priorityState) await loadPriority();

  exportData = buildExport({
    providers: providerRows,
    keys: keyRows,
    models: modelRows,
    mappings: mappingRows,
    skipped: {
      provider: [...skippedFor(SCOPE.PROVIDER)],
      model: [...skippedFor(SCOPE.MODEL)],
      key: [...skippedFor(SCOPE.KEY)],
    },
  });

  const count = $('exportCount');
  if (count) {
    count.textContent = exportData.endpoints.length
      ? `${exportData.endpoints.length} URL đang hoạt động`
      : 'chưa có cấu hình nào hoạt động';
  }

  renderExport();
  openSheet('exportDialog');
}

/** The one place the exported text - keys and all - becomes text on screen. */
function renderExport() {
  const out = $('exportOut');
  if (!out) return;
  const format = $('exportFormat')?.value ?? 'env';
  out.textContent = exportData ? formatExport(exportData, format) : '';
}

/** Save text to a file, falling back to the clipboard where download is absent. */
function downloadText(filename, text) {
  try {
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast(`Đã tải ${filename}`);
  } catch {
    // A headless run or a browser without Blob still gets the file's contents.
    copyText(text, 'Không tải được, đã chép cấu hình');
  }
}

// ------------------------------------------------------- wiring

$('btnMenu').addEventListener('click', toggleDrawer);
$('scrim').addEventListener('click', () => openDrawer(false));
// The drawer keeps the drawer open state consistent: adding a URL from inside
// it closes the drawer so the new URL's models are actually visible afterwards.
$('btnAddUrl').addEventListener('click', () => {
  openDrawer(false);
  openAddUrlDialog();
});
// The same action from the header, so "add a URL" is reachable without opening
// the drawer first.
$('appbarAddUrl').addEventListener('click', () => {
  openDrawer(false);
  openAddUrlDialog();
});
$('btnScanAll').addEventListener('click', scanEverything);
$('urlConfirm').addEventListener('click', confirmAddUrl);
$('urlCancel').addEventListener('click', () => $('addUrlDialog').close());
$('btnAddKey').addEventListener('click', async () => {
  // Guarded: a stale dialog must not throw on a null currentModel.
  const provider = currentModel ? await providers.get(currentModel.providerId) : null;
  if (provider) openAddKeyDialog(provider);
});
$('btnCheckOne').addEventListener('click', checkAllKeysOfCurrentModel);
$('btnTestModel').addEventListener('click', async () => {
  if (!currentModel) return;
  const provider = await providers.get(currentModel.providerId);
  if (!provider) return;
  // currentModel carries the provider's model id, not the registry's own, so it
  // has to be looked up by pair. Passing it to get() would read a row that does
  // not exist and the test button would do nothing at all.
  const model = await models.find(provider.id, currentModel.modelId);
  if (!model) return;
  openTestDialog(provider, model);
});
$('testRun').addEventListener('click', runManualTest);
$('btnBulk').addEventListener('click', async () => {
  if (!currentModel) return;
  const provider = await providers.get(currentModel.providerId);
  if (provider) openBulkDialog(provider);
});
$('bulkRun').addEventListener('click', runBulkProbe);
$('bulkLimit').addEventListener('input', updateBulkEstimate);
$('bulkStop').addEventListener('click', () => currentRun?.cancel());
// Closing mid-run would leave the sheet behind an orphaned request: the run
// keeps spending tokens against nobody's screen. So closing stops it first.
const closeBulk = () => {
  if (currentRun) currentRun.cancel();
  $('bulkDialog').close();
};
$('bulkDismiss').addEventListener('click', closeBulk);
$('bulkClose').addEventListener('click', closeBulk);
$('bulkDialog').addEventListener('cancel', (event) => {
  if (!currentRun) return;
  event.preventDefault();
  closeBulk();
});
$('testClose').addEventListener('click', () => $('testDialog').close());
$('modelClose').addEventListener('click', () => {
  closeChat();
  $('modelDialog').close();
});
$('keyConfirm').addEventListener('click', confirmAddKey);
$('keyCancel').addEventListener('click', () => $('keyDialog').close());
// The two list dialogs share their form and their list, so each dialog has one
// button that drops back into "add": the list is the default view and the form
// is a step inside it.
$('keyListAdd').addEventListener('click', async () => {
  const provider = await providers.get($('keyDialog').dataset.providerId);
  if (provider) openAddKeyDialog(provider);
});
$('manualListAdd').addEventListener('click', async () => {
  const provider = await providers.get($('modelAddDialog').dataset.providerId);
  if (provider) openManualModel(provider);
});
// The chat panel: GỬI sends, Enter sends, and XOÁ API removes the key it is
// talking through - the delete path is the same dialog as everywhere else.
$('chatSend').addEventListener('click', sendChat);
$('chatInput').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') sendChat();
});
$('chatDelete').addEventListener('click', async () => {
  if (!chatTarget) return;
  const provider = await providers.get(chatTarget.providerId);
  const key = await storage.get('keys', chatTarget.keyId);
  if (!provider || !key) return;
  closeChat();
  openDeleteDialog(provider, key);
});

// Export: the sheet is built fresh each time it opens, so a key added a moment
// ago is already in the file. Changing the format repaints from the same data.
$('btnExport').addEventListener('click', () => {
  openDrawer(false);
  openExportDialog();
});
$('exportFormat').addEventListener('change', renderExport);
$('exportCopy').addEventListener('click', () => {
  if (!exportData) return;
  copyText(formatExport(exportData, $('exportFormat').value), 'Đã chép cấu hình');
});
$('exportDownload').addEventListener('click', () => {
  if (!exportData) return;
  const format = $('exportFormat').value;
  const ext = { env: 'env', json: 'json', yaml: 'yaml' }[format] ?? 'txt';
  downloadText(`freeai-config.${ext}`, formatExport(exportData, format));
});
$('exportClose').addEventListener('click', () => $('exportDialog').close());
$('exportDone').addEventListener('click', () => $('exportDialog').close());

// The AI tab. Enter alone is a newline - a chat box that sends on Enter is how
// a half-typed question gets sent - so Ctrl/⌘+Enter sends.
$('aiSend').addEventListener('click', sendAiTurn);
$('aiStop').addEventListener('click', () => aiRun?.cancel());
$('aiClear').addEventListener('click', () => {
  aiHistory = [];
  $('aiLog').replaceChildren();
  aiPaintBudget();
});
$('aiInput').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    sendAiTurn();
  }
});
aiPaintBudget();
$('delConfirm').addEventListener('click', confirmDeleteKey);
$('delRestore').addEventListener('click', restoreDeletedKey);
$('delCancel').addEventListener('click', () => $('delDialog').close());
$('manualConfirm').addEventListener('click', confirmAddModel);
$('manualCancel').addEventListener('click', () => $('modelAddDialog').close());
$('btnCancel').addEventListener('click', () => currentRun?.cancel());

// There is no header button for "add a key" or "add a model" any more. Both act
// on exactly one URL, and with every URL on one screen there is no single URL a
// header button could mean. Both are in that URL's own ⋮ menu, one tap from its
// header, and the key dialog is also reachable from any model's card.

$('rowMenuCancel').addEventListener('click', () => $('rowMenu').close());

// The drawer order. Kept in a variable rather than read from the select on
// every render, because every render sorts the list and the select is only
// where the value is edited.
$('urlSort').addEventListener('change', (event) => setUrlSort(event.target.value));

/**
 * Set the drawer's order from anywhere.
 *
 * The select and the "0đ ↓" quick button are two ways to say one thing, so the
 * value is written to the variable and back into the select on every change. A
 * control that shows one order while the list is in another is worse than no
 * control, because the user reads it as a bug in the sort.
 */
async function setUrlSort(value) {
  URL_SORT = URL_SORTS[value] ? value : 'manual';
  const select = $('urlSort');
  if (select) select.value = URL_SORT;
  markUrlControls();
  await renderSidebarOnly();
}

// ---- URL search and classification -------------------------------------
//
// Both narrow the drawer only. The main list is the answer to "what can I use
// for nothing", and a URL filter that quietly punched holes in it would make
// the count under the title disagree with the rows beneath it.

$('urlSearch').addEventListener('input', async (event) => {
  urlSearchTerm = event.target.value.trim();
  await renderSidebarOnly();
});

$('urlSearchClear').addEventListener('click', async () => {
  urlSearchTerm = '';
  $('urlSearch').value = '';
  await renderSidebarOnly();
});

// Pressing the class that is already on turns it off, back to every URL. There
// are two classes and only one can be on, so without a toggle the second tap on
// "cần key" would be a tap that does nothing.
for (const btn of document.querySelectorAll('.classbtn')) {
  btn.addEventListener('click', async () => {
    const next = btn.dataset.urlclass;
    urlClass = urlClass === next ? 'all' : next;
    await renderSidebarOnly();
  });
}

// "Số lượng model 0đ nhiều trước", as one button. It writes the same URL_SORT
// the select does, so the drawer has one order, stated twice.
$('urlSortFree').addEventListener('click', () => {
  void setUrlSort(URL_SORT === 'models' ? 'manual' : 'models');
});

/** Re-render the drawer on its own, for a change that only affects the drawer. */
async function renderSidebarOnly() {
  const [providerRows, modelRows, keyRows] = await Promise.all([
    providers.list(),
    models.list(),
    keys.list(),
  ]);
  await loadPriority();
  await renderSidebar(providerRows, modelRows, keyRows);
}

/**
 * The bottom bar.
 *
 * Four destinations, always reachable without a scroll, because on a phone the
 * thing a user reaches for most often is rarely the thing on screen.
 *
 * Delegated rather than bound per button. A handler attached while this module
 * loads only reaches the buttons that exist at that moment, so anything rendered
 * later is silently dead - which is how a navigation bar ends up looking wired
 * while none of its buttons do anything.
 */
document.addEventListener('click', async (event) => {
  const btn = event.target?.closest?.('.tabbar-btn');
  if (!btn) return;
  const target = btn.dataset.goto;
  markTabBar(target);

  if (target === 'drawer') {
    openDrawer(true);
    return;
  }
  if (target === 'scan') {
    await scanEverything();
    return;
  }

  // API and Sức khoẻ are panes further down the page, so they are shown and
  // scrolled to rather than hidden behind a navigation that does not exist.
  openDrawer(false);
  const pane = $(TAB_PANES[target]);
  if (!pane) return;
  showTab(target);
  pane.scrollIntoView({ behavior: 'smooth', block: 'start' });
});

for (const chip of document.querySelectorAll('.chip')) {
  chip.addEventListener('click', () => filterBy(chip.dataset.filter));
}
for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => {
    showTab(tab.dataset.tab);
    markTabBar(tab.dataset.tab);
  });
}
$('searchBox').addEventListener('input', (e) => {
  searchTerm = e.target.value.trim();
  render();
});

// Undo the URL pick: the list goes back to every URL and the bar hides itself.
$('scopeClear').addEventListener('click', async () => {
  urlScope = null;
  focusProviderId = null;
  await render();
});

// ------------------------------------------------- rotation: lock and order

/**
 * Everything the user can lock or reorder, in one place.
 *
 * Locking and ordering are different decisions and never share a control. A
 * lock means "do not use this" - it removes the row from the rotation without
 * deleting anything. An order means "try these in this sequence", which
 * overrides the automatic speed ranking only for the ids actually dragged.
 */
async function loadPriority() {
  priorityState = await priority.load();
  return priorityState;
}

async function loadMetrics(modelRows) {
  metricsMap = await metrics.mapFor(modelRows);
  return metricsMap;
}

function skippedFor(scope) {
  const state = priorityState ?? { skipped: {} };
  return new Set(state.skipped?.[scope] ?? []);
}

/**
 * Sort a list for display.
 *
 * The rotation rule decides first, and whatever the user dragged outranks it.
 * Speed needs a metrics map, which is why it is passed rather than read: a sort
 * comparator cannot await.
 */
function applyPriority(rows, scope, fallback, extra = {}) {
  return sortByPriority(rows, {
    // `order` is passed in when the list belongs to one URL, because dragging a
    // model or a key writes that URL's order onto the provider row. Reading the
    // global order instead would sort by a list the user never arranged, and the
    // arrangement they did make would disappear on the next render.
    order: extra.order ?? priorityState?.order?.[scope] ?? [],
    rotation: extra.rotation ?? priorityState?.rotation ?? ROTATION.SPEED,
    metrics: scope === SCOPE.MODEL ? metricsMap : new Map(),
    skipped: skippedFor(scope),
    scope,
    fallback,
  });
}

/**
 * The rules that apply to one URL: its own overrides, or the global ones.
 *
 * `rotation` is needed to fill the dropdown and to sort; `order` is what the
 * drag handler wrote. Both live on the provider row, so the lists under a URL
 * and the router all resolve them the same way.
 */
function effectiveFor(provider, scope = SCOPE.MODEL) {
  const local = provider?.priority ?? null;
  return {
    rotation: local?.rotation ?? priorityState?.rotation ?? ROTATION.SPEED,
    // Models are dragged into the URL's own order; keys are dragged into the
    // shared key order. Reading the wrong one here would make a key list ignore
    // the arrangement the user just made, which is the exact symptom the drag
    // handler would otherwise look broken for.
    order: scope === SCOPE.KEY
      ? (priorityState?.order?.[SCOPE.KEY] ?? [])
      : (local?.order ?? priorityState?.order?.[SCOPE.MODEL] ?? []),
  };
}

/** Re-read the rules and repaint, so a change is visible immediately. */
async function refreshPriority() {
  await loadPriority();
  await render();
  // The key list inside the open model dialog is rendered by its own function,
  // not by render(), so a change made in that dialog would otherwise appear to
  // undo itself: the row moves, the stored order updates, and nothing repaints
  // the dialog the user is actually looking at.
  if ($('modelDialog')?.open && currentModel) {
    const provider = await providers.get(currentModel.providerId);
    if (provider) await renderKeyRows(provider);
  }
}

/**
 * Lock or unlock one row.
 *
 * A locked row stays on screen and stays editable - it is only left out of the
 * rotation, so nothing the user configured disappears by being locked.
 */
async function toggleLock(level, id) {
  const scope = { provider: SCOPE.PROVIDER, model: SCOPE.MODEL, key: SCOPE.KEY }[level];
  const nowLocked = await priority.toggleSkipped(scope, id);
  toast(
    nowLocked
      ? { provider: 'Đã khoá URL, mọi model và API của nó cũng dừng dùng',
          model: 'Đã khoá model, mọi API của nó cũng dừng dùng',
          key: 'Đã khoá API này' }[level]
      : 'Đã mở khoá'
  );
  await refreshPriority();
}

/**
 * Open a row and everything under it, lowest level first.
 *
 * This is the "mở thủ công theo tầng" action. It clears the whole subtree rather
 * than only the tapped level, because a model opened while its URL is still
 * locked would look unlocked in the list and still never be used - the confusing
 * middle state this action exists to remove.
 */
async function unlockSubtree(level, id) {
  // The cascade is bounded to the row that was tapped. Unlocking a URL must not
  // reopen a model the user locked on some other URL, so the ids below it are
  // read from storage rather than assumed to be everything in the scope.
  await priority.setLocked({
    level,
    id,
    locked: false,
    exclusive: true,
    descendants: await subtreeIdsBelow(level, id),
  });
  toast(
    { provider: 'Đã mở URL và toàn bộ model, API bên trong',
      model: 'Đã mở model và toàn bộ API của nó',
      key: 'Đã mở API này' }[level]
  );
  await refreshPriority();
}

/**
 * The ids that live below one row, keyed by the scope they belong to.
 *
 * Read from storage rather than guessed, because a lock list is global: knowing
 * that "some model is locked" says nothing about whether it is on this URL.
 */
async function subtreeIdsBelow(level, id) {
  if (level === 'provider') {
    const [modelRows, keyRows] = await Promise.all([models.list(id), keys.list(id)]);
    return {
      [SCOPE.MODEL]: modelRows.map((m) => m.id),
      [SCOPE.KEY]: keyRows.map((k) => k.id),
    };
  }
  if (level === 'model') {
    // A model has no children of its own; its keys belong to the URL, and the
    // URL decides them, so nothing here is safe to release implicitly.
    return { [SCOPE.KEY]: [] };
  }
  return {};
}

/** Lock or unlock every row in a scope at once. */
async function setAllLocked(scope, ids, locked) {
  for (const id of ids) await priority.setSkipped(scope, id, locked);
  await refreshPriority();
  toast(locked ? `Đã khoá ${ids.length} mục` : `Đã mở ${ids.length} mục`);
}

/**
 * Mount the lock-all control into a fixed slot in the page.
 *
 * The sidebar has a permanent slot in index.html because it is always visible.
 * Re-creating the button here instead would lose the click handler on every
 * render, so the element is reused and only its label and action are swapped.
 */
function mountLockAll(slot, scope, ids) {
  if (!slot) return null;
  const current = slot.__fmhScope;
  // The whole list is compared, not just its length. Two different sets of the
  // same size - one URL deleted while another is added, or the open URL's models
  // changing - would otherwise keep a stale button whose label and actions
  // referred to rows that are no longer on screen.
  const same =
    current &&
    current.scope === scope &&
    current.ids.length === ids.length &&
    current.ids.every((id, i) => id === ids[i]);

  if (same) {
    // The same list, but the lock state under it may have just changed - locking
    // every row is a change to the state, not to the list. Reusing the element
    // without repainting it is what left the button reading "khoá tất cả" while
    // everything was already locked, so the only thing it could still do was
    // lock again and "mở khoá tất cả" could never be reached.
    paintLockAll(slot.children?.[0], scope, ids);
    return slot;
  }

  slot.replaceChildren();
  if (ids.length) slot.append(lockAllButton(scope, ids));
  slot.__fmhScope = { scope, ids };
  return slot;
}

/**
 * One button that locks everything, or unlocks everything if all are locked.
 *
 * Both the label and the action are read from the current state on every tap
 * rather than captured once, because this one element is reused across renders:
 * a value closed over here would go stale the first time the list was locked,
 * and every later tap would lock it again instead of unlocking it.
 */
function lockAllButton(scope, ids) {
  const btn = document.createElement('button');
  btn.className = 'mini lockall';
  btn.addEventListener('click', async () => {
    const allLocked = ids.length > 0 && ids.every((id) => skippedFor(scope).has(id));
    await setAllLocked(scope, ids, !allLocked);
  });
  paintLockAll(btn, scope, ids);
  return btn;
}

/** Write the current lock state of a whole list onto its button. */
function paintLockAll(btn, scope, ids) {
  if (!btn) return false;
  const skipped = skippedFor(scope);
  const allLocked = ids.length > 0 && ids.every((id) => skipped.has(id));
  btn.textContent = allLocked ? 'mở khoá tất cả' : 'khoá tất cả';
  btn.title = allLocked
    ? 'Đưa toàn bộ danh sách này vào vòng quay'
    : 'Loại toàn bộ danh sách này khỏi vòng quay';
  btn.setAttribute?.('aria-pressed', allLocked ? 'true' : 'false');
  return allLocked;
}

/**
 * The lock control on every row.
 *
 * A lock is a skip, never a promotion. When the row is locked by inheritance -
 * the URL above it is locked - the button shows the open state and offers to
 * unlock the whole subtree, because tapping it could not possibly make this one
 * row usable on its own.
 */
function lockButton(level, id, { inherited = false } = {}) {
  const scope = { provider: SCOPE.PROVIDER, model: SCOPE.MODEL, key: SCOPE.KEY }[level];
  const locked = inherited || skippedFor(scope).has(id);

  // The glyph alone, no word beside it.
  //
  // Three states that have to be told apart - locked on its own, locked because
  // the URL above is locked, and open - are carried by the glyph, the fill and
  // the border. A word per state would have to shrink to about 9px to fit
  // beside an icon on a 44px row, and at that size it is worse than no word: it
  // costs the row its width and still cannot be read at a glance. The row keeps
  // its full text budget instead, and the three states stay distinguishable by
  // shape, which is faster to read than text anyway.
  //
  // `title` and `aria-label` still carry the full sentence, so the meaning is
  // one hover away on a desktop and one screen-reader announcement away.
  const state = inherited ? 'inherited' : locked ? 'locked' : 'open';

  const btn = document.createElement('button');
  btn.className = 'lockbtn ' + state + (locked ? ' on' : '') + (inherited ? ' inherited' : '');
  btn.title = inherited
    ? 'Bị khoá bởi URL phía trên. Bấm để mở cả nhánh.'
    : locked
      ? 'Đã khoá: không dùng mục này. Bấm để mở cả nhánh.'
      : {
          provider: 'Đang dùng. Bấm để khoá URL: mọi model và API của nó cũng dừng dùng',
          model: 'Đang dùng. Bấm để khoá model: mọi API của nó cũng dừng dùng',
          key: 'Đang dùng. Bấm để khoá API này',
        }[level];
  btn.setAttribute?.('aria-pressed', locked ? 'true' : 'false');
  btn.setAttribute?.('aria-label', btn.title);

  btn.append(icon(locked ? 'lock' : 'unlock'));
  btn.addEventListener('click', async (event) => {
    // The row itself opens a dialog; the lock must not also trigger that.
    event.stopPropagation?.();
    if (locked) await unlockSubtree(level, id);
    else await toggleLock(level, id);
  });
  return btn;
}

/**
 * Reordering.
 *
 * A phone has no hover and no second pointer, so "pick this row up" has to be a
 * gesture. Two are used, each for the input it actually suits:
 *
 *   mouse / trackpad - HTML5 drag-and-drop
 *   touch - press and hold, then drag
 *
 * The hold is what separates a reorder from a scroll. A vertical drag on its own
 * is indistinguishable from flicking the list, so the finger has to rest first;
 * once it has, the vertical axis is free to mean "move this row" unambiguously.
 * A flick that never rests stays a scroll, which is why the list behaves like a
 * list no matter how fast the user moves.
 *
 * While a drag is in progress the list is locked and the row is lifted, so the
 * item under the finger is always the one being moved. The new position is
 * computed from the row's own measured box rather than from the pointer, so the
 * row lands where it is dropped instead of wherever the last sibling happened to
 * end up.
 */
function makeSortable(container, rows, scope, idOf, { providerId = null } = {}) {
  // `sortId` on a row is the row's own id, so the DOM reads back in exactly the
  // form that gets stored. Applying `idOf` to that id is what once produced an
  // order full of undefined.
  // `container.children` is an HTMLCollection, which is array-like but has no
  // map of its own - spreading it first is what turns it into a real list.
  const readOrder = () => [...container.children].map((child) => child.dataset?.sortId).filter(Boolean);

  const commit = async () => {
    const order = readOrder();
    if (!order.length) return;
    // Two commits from one gesture would race, and whichever lost would leave
    // the list showing an order that was never stored.
    if (committing) return;
    committing = true;
    try {
      // With a providerId the order belongs to that URL, so two URLs offering
      // the same model id can be ranked differently without overwriting.
      if (providerId) await priority.setProviderPriority(providerId, { order });
      else await priority.setOrder(scope, order);
      await refreshPriority();
    } finally {
      committing = false;
    }
  };

  let dragging = null;
  let committing = false;

  for (const child of container.children) {
    // A group heading is a label, not a row. It gets no drag handle, so it can
    // never be picked up and cannot end up inside a stored order.
    if (!child.dataset?.sortId) continue;
    child.draggable = true;

    child.addEventListener('dragstart', (event) => {
      dragging = child;
      child.classList.add('dragging');
      event.dataTransfer?.setData('text/plain', child.dataset.sortId);
      if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
    });

    child.addEventListener('dragend', () => {
      child.classList.remove('dragging');
      for (const other of container.children) other.classList.remove('dropbefore', 'dropafter');
      // Cleared first: dragend always follows drop, and a second commit would
      // run against a container that is already repainting.
      const was = dragging;
      dragging = null;
      if (was === child) void commit();
    });

    child.addEventListener('dragover', (event) => {
      if (!dragging || dragging === child) return;
      event.preventDefault();
      const after = isBelow(event, child);
      child.classList.toggle('dropbefore', !after);
      child.classList.toggle('dropafter', after);
    });

    child.addEventListener('dragleave', () => {
      child.classList.remove('dropbefore', 'dropafter');
    });

    child.addEventListener('drop', (event) => {
      event.preventDefault();
      child.classList.remove('dropbefore', 'dropafter');
      if (!dragging || dragging === child) return;

      const after = isBelow(event, child);
      container.insertBefore(dragging, after ? child.nextSibling : child);
      dragging = null;
      void commit();
    });

    attachHoldDrag(child, container, commit);
  }
}

/** Is the pointer past the midpoint of this row? Decides before or after. */
function isBelow(event, row) {
  const box = row.getBoundingClientRect?.();
  if (!box) return false;
  return event.clientY > box.top + box.height / 2;
}

/**
 * Press-and-hold drag to reorder, on touch.
 *
 * A phone has no hover and no second pointer, so "pick this row up" has to be a
 * gesture. The one every mobile list uses is a press-and-hold followed by a
 * drag, and that is what this is:
 *
 *   press and hold  - after ~180ms without moving, the row lifts (haptic tick)
 *   move            - the row follows the finger on the vertical axis
 *   release         - the row drops where it visually is, and the order is stored
 *
 * The alternative tried earlier was a horizontal swipe. It cannot work on a list
 * that is stacked vertically: the row stays in its own slot no matter how far
 * sideways the finger travels, so the "crossed a neighbour" test never became
 * true and nothing ever moved. A vertical long-press keeps the travel and the
 * list on the same axis, which is the only way the crossing test can mean
 * anything.
 *
 * A vertical *flick* is still scrolling. The press is what claims the gesture,
 * so a fast scroll never enters a drag and the list keeps behaving like a list.
 */
function attachHoldDrag(child, container, commit) {
  let pointerId = null;
  let startY = 0;
  let holdTimer = null;
  let downSince = 0;
  let dragging = false;
  let suppressClick = false;

  const cancelHold = () => {
    if (holdTimer) clearTimeout(holdTimer);
    holdTimer = null;
  };

  const endDrag = () => {
    cancelHold();
    if (!dragging) return;
    dragging = false;
    child.classList.remove('dragging');
    child.style.transform = '';
    delete child.dataset.dragDistance;
    container.classList.remove('reordering');
    for (const other of container.children) other.classList.remove('dropbefore', 'dropafter');
    void commit();
  };

  child.addEventListener('pointerdown', (event) => {
    if (event.pointerType === 'mouse') return; // the mouse has its own path
    pointerId = event.pointerId;
    startY = event.clientY;
    dragging = false;

    // Both listeners on this row share one claim. Whichever of them the press
    // belongs to, the other stands down the moment it notices - without this the
    // two timers race, and the shorter one wins every time, so the longer one
    // becomes a gesture the app can never perform.
    beginPress(child);
    downSince = performanceNow();
    // No lift on the hold alone. The finger has to start travelling first -
    // that is the signal that separates "move this row" from "what can I do
    // with this row", and claiming on the hold alone took the menu's press away.
    holdTimer = setTimeout(() => {
      holdTimer = null;
    }, HOLD_TO_DRAG_MS);
  });

  child.addEventListener('pointermove', (event) => {
    if (event.pointerId !== pointerId) return;
    const dy = event.clientY - startY;

    if (!dragging) {
      // Past the hold, moving means the press is a reorder. Under it, moving
      // means it was a scroll all along - and one that never became a drag, so
      // the list keeps behaving like a list however fast the user flicks.
      if (Math.abs(dy) <= HOLD_SLOP_PX) return;
      cancelHold();
      if (performanceNow() - downSince < HOLD_TO_DRAG_MS) {
        releaseGesture(child, 'drag');
        endPress(child);
        pointerId = null;
        return;
      }
      dragging = true;
      suppressClick = true;
      child.classList.add('dragging');
      container.classList.add('reordering');
      claimGesture(child, 'drag');
      haptic();
    }

    event.preventDefault?.();
    child.style.transform = `translateY(${clampOffset(dy)}px)`;
    // The distance is kept on the row because the swap test needs to know how
    // far the finger actually travelled, which the transform alone cannot say -
    // it is clamped, and it is the travel that decides whether a swap happened.
    child.dataset.dragDistance = String(Math.abs(dy));

    swapWhenCrossed(child, container);
  });

  const finish = (event) => {
    if (event.pointerId !== pointerId) return;
    pointerId = null;
    releaseGesture(child, 'drag');
    endPress(child);
    endDrag();
  };

  child.addEventListener('pointerup', finish);
  child.addEventListener('pointercancel', finish);

  // The click that follows a drag must not open the row behind it.
  child.addEventListener('click', (event) => {
    if (!suppressClick) return;
    suppressClick = false;
    event.preventDefault?.();
    event.stopPropagation?.();
  }, true);
}

/**
 * Which gesture a press on a row has become.
 *
 * A press means three things depending on whether it moves and for how long: a
 * tap opens the row, a press that travels becomes a reorder, and a press that
 * stays put becomes the action sheet. Two timers on one element cannot be left
 * to race - whichever is shorter wins every time and the other becomes a
 * gesture the app can never perform - so the row records who took the press and
 * each listener checks that before acting.
 *
 * The claim lives on the row rather than in a module-level variable because two
 * lists are on screen at once (the drawer and the main list), and a press in one
 * of them must not answer a question in the other.
 */
function claimGesture(row, who) {
  row.__fmhGesture = who;
}

function ownsGesture(row, who) {
  return row.__fmhGesture === who;
}

/** Give the claim back, so the next press starts from a clean slate. */
function releaseGesture(row, who) {
  if (row.__fmhGesture === who) row.__fmhGesture = null;
}

/** A press started here, not yet claimed by anyone. */
function beginPress(row) {
  row.__fmhPress = true;
}

function endPress(row) {
  row.__fmhPress = false;
}

/** How long a finger must rest before the row is picked up. */
const HOLD_TO_DRAG_MS = 180;

/** How far the finger may drift during the hold before it counts as a scroll. */
const HOLD_SLOP_PX = 8;

/** Beyond this the row stops following, so a long drag does not slide it off. */
const DRAG_MAX_OFFSET_PX = 320;

function clampOffset(dy) {
  return Math.max(-DRAG_MAX_OFFSET_PX, Math.min(DRAG_MAX_OFFSET_PX, dy));
}

/**
 * A short tick when a row is picked up.
 *
 * Vibration is what tells a finger that the hold succeeded, so the drag does not
 * start from nothing. It is a no-op on a device or browser without the API.
 */
function haptic() {
  try {
    navigator.vibrate?.(12);
  } catch {
    // Not supported: the visual lift on the row is the only feedback.
  }
}

/**
 * Swap the dragged row with the neighbour it has crossed.
 *
 * The comparison uses each row's real box, read at the moment of the swap, so
 * the list has to be laid out before this can be trusted. That is the whole
 * reason this reads the DOM rather than tracking an index: an index goes stale
 * as soon as one row moves.
 */
function swapWhenCrossed(dragging, container) {
  const moving = dragging.getBoundingClientRect?.();
  if (!moving) return;

  // The comparison is on the vertical axis, because that is the axis the rows
  // are stacked on and the axis the finger now travels on.
  const centre = moving.top + moving.height / 2;

  for (const sibling of container.children) {
    if (sibling === dragging || !sibling.dataset?.sortId) continue;
    const box = sibling.getBoundingClientRect?.();
    if (!box) continue;

    // DOCUMENT_POSITION_FOLLOWING means the sibling comes after the dragged row,
    // so it is the one below it.
    const siblingIsBelow =
      (dragging.compareDocumentPosition(sibling) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;

    // Crossing is judged against the neighbour's midpoint, and the dragged row's
    // own travel is what is compared - not its box, which a browser recomputes
    // on every frame and which therefore always looks like it is still in its
    // original slot.
    const siblingCentre = box.top + box.height / 2;
    const gap = centre - siblingCentre;
    const travel = Number(dragging.dataset.dragDistance ?? 0);

    // Moving up: the row's centre is now above the neighbour's, and the finger
    // has travelled far enough to be worth acting on.
    if (!siblingIsBelow && gap < 0 && travel >= box.height / 2) {
      container.insertBefore(dragging, sibling);
      return;
    }
    // Moving down: mirror image.
    if (siblingIsBelow && gap > 0 && travel >= box.height / 2) {
      container.insertBefore(dragging, sibling.nextSibling);
      return;
    }
  }
}


// ------------------------------------------------------- no zoom on mobile// ------------------------------------------------------- no zoom on mobile

/**
 * Pin the visual scale at 1 on a phone.
 *
 * The viewport meta and styles.css handle most of it, but iOS Safari keeps
 * pinch-zoom alive when a gesture starts on an element it treats as zoomable,
 * and it ignores the meta tag entirely for a double-tap in some versions. The
 * only reliable fix is to cancel the gesture events themselves.
 *
 * A multi-touch event means two fingers, which is exactly a pinch. One finger
 * is a scroll and is left alone, so the page still scrolls normally.
 */
function lockScale() {
  // gesturestart / gesturechange / gestureend are Safari-only and do not bubble,
  // so they are bound on document rather than delegated.
  for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
    document.addEventListener(type, (event) => event.preventDefault(), { passive: false });
  }

  // Two fingers at once = pinch. More than one touch point is cancelled;
  // a single finger keeps scrolling.
  document.addEventListener(
    'touchmove',
    (event) => {
      if (event.touches?.length > 1) event.preventDefault();
    },
    { passive: false }
  );

  // Double-tap zoom is also a scale change; a fast second tap is ignored when it
  // lands on text or an inline control, which is where Safari allows it.
  let lastTouchEnd = 0;
  document.addEventListener(
    'touchend',
    (event) => {
      const now = Date.now();
      if (now - lastTouchEnd < 300) event.preventDefault();
      lastTouchEnd = now;
    },
    { passive: false }
  );
}

lockScale();

// Copy boxes: tapping a value copies it.
$('boxUrl').addEventListener('click', () => copyText($('boxUrl').textContent, 'Đã chép URL'));
$('boxModel').addEventListener('click', () => copyText($('boxModel').textContent, 'Đã chép model'));
for (const btn of document.querySelectorAll('[data-copy]')) {
  btn.addEventListener('click', () => {
    const target = btn.dataset.copy === 'url' ? $('boxUrl') : $('boxModel');
    copyText(target.textContent, 'Đã chép');
  });
}

// ------------------------------------------------------------- start

async function boot() {
  await providers.seedBuiltins();
  await render();
  log('sẵn sàng');
  if (storage.degraded) log('cảnh báo: IndexedDB không dùng được, dữ liệu không lưu qua lần tải');
}

// The service worker only exists to revalidate our own static files; provider
// requests are never intercepted.
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}

boot();
