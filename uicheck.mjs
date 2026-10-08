/**
 * Renders the real app.js against a minimal DOM stub and drives the two
 * flows the user cares about: the model list, and tapping a model to see its
 * URL / model / keys. Catches runtime errors a text-only wiring check misses.
 */
import fs from 'node:fs';
import { MemoryStorage } from './core/storage.js';
import { ProviderRegistry } from './core/provider-registry.js';
import { ModelRegistry } from './core/model-registry.js';
import { KeyRegistry } from './core/key-registry.js';
import { createMockFetch } from './tests/mock-fetch.js';

const KEY_A = 'oc_sk_A1b2C3d4E5f6G7h8I9j0';
const KEY_B = 'oc_sk_Z9y8X7w6V5u4T3s2R1q0';

// Seed storage the app will read.
const storage = new MemoryStorage();
globalThis.__FMH_SEED__ = {};
const providers = new ProviderRegistry(storage);
const models = new ModelRegistry(storage);
const keys = new KeyRegistry(storage);
await providers.seedBuiltins();
const { provider } = await providers.upsert({ name: 'Gateway', baseURL: 'https://gw.test/v1' });
for (const m of ['space-bunny-free', 'paid-model']) {
  await models.upsertDiscovered({
    providerId: provider.id, modelId: m,
    pricing: { prompt: m.includes('paid') ? '0.01' : '0', completion: m.includes('paid') ? '0.02' : '0' },
  });
}

// One model carrying a real catalog entry, so the facts line has something to
// render. The shape is trimmed from the live OpenRouter catalog.
await models.upsertDiscovered({
  providerId: provider.id, modelId: 'ling-3.1-flash',
  displayName: 'inclusionAI: Ling 3.1 Flash',
  pricing: { prompt: '0', completion: '0' },
  metadata: {
    id: 'inclusionai/ling-3.1-flash',
    name: 'inclusionAI: Ling 3.1 Flash',
    created: Math.floor(Date.now() / 1000) - 86400 * 3,
    description: 'Ling 3.1 Flash is a hybrid reasoning mixture-of-experts model from inclusionAI.',
    context_length: 262144,
    architecture: { modality: 'text->text', input_modalities: ['text'], output_modalities: ['text'] },
    top_provider: { context_length: 262144, max_completion_tokens: 32768 },
    supported_parameters: ['tools', 'reasoning', 'temperature'],
  },
});
const k1 = await keys.add({ providerId: provider.id, secret: KEY_A });
const k2 = await keys.add({ providerId: provider.id, secret: KEY_B });

globalThis.__FMH_SEED__ = {
  providers: await storage.list('providers'),
  models: await storage.list('models'),
  keys: await storage.list('keys'),
};

// ---- minimal DOM ----
class El {
  constructor(tag='div') { this.tag=tag; this.children=[]; this.dataset={}; this.style={}; this.className=''; this._listeners={}; this.classList={add(){},remove(){},toggle(){}}; this._text=''; this._html=''; }
  addEventListener(ev, fn){ (this._listeners[ev] ||= []).push(fn); }
  set textContent(v){ this._text=String(v); } get textContent(){ return this._text; }
  set innerHTML(v){ this._html=v; } get innerHTML(){ return this._html; }
  append(...k){ this.children.push(...k); }
  replaceChildren(...k){ this.children=k; }
  prepend(...k){ this.children.unshift(...k); }
  remove(){}
  querySelectorAll(){ return []; }
  get lastElementChild(){ return this.children[this.children.length-1]; }
  get childElementCount(){ return this.children.length; }
  setAttribute(){}
  focus(){}
  click(){ for (const fn of this._listeners.click ?? []) fn(); }
  // A <dialog> must be openable; without these the app throws on tap and the
  // run ends before the key rows are ever inspected.
  showModal(){ this.open = true; }
  close(){ this.open = false; }
}
const registry = new Map();
for (const id of ['btnScanAll','btnAddUrl','appbarAddUrl','btnCancel','searchBox','treeRoot','keysRoot','healthRoot','logRoot','toast','filterCount','paneKeys','paneHealth','paneLog','modelDialog','modelTitle','modelHint','boxUrl','boxModel','keyRows','keyCount','btnCheckOne','btnAddKey','modelClose','keyDialog','keyHint','keySecret','keyConfirm','keyCancel','delDialog','delHint','delSecret','delConfirm','delRestore','delCancel','addUrlDialog','urlName','urlBase','urlConfirm','urlCancel','modelAddDialog','manualHint','manualModel','manualFree','manualConfirm','manualCancel','sidebar','sidebarRoot','btnMenu','scrim','treeTitle','lockAllUrls','lockAllKeys','modelInfo','btnTestModel','urlSearch','urlSearchClear','urlClass','urlSortFree','sideHint','scopeBar','scopeName','scopeUrl','scopeClear','btnBulk','bulkDialog','bulkRows','bulkRun','bulkKey','bulkLimit','bulkEstimate','bulkProgress','testDialog','testKey','testModel','testUrl','testRun','testResult','chatField','chatKeyName','chatLog','chatInput','chatSend','chatDelete','keyList','keyListAdd','keyForm','manualList','manualListAdd','manualForm','btnExport','exportDialog','exportHint','exportCount','exportFormat','exportOut','exportCopy','exportDownload','exportClose','exportDone','rowMenu','rowMenuTitle','rowMenuSub','rowMenuActions','rowMenuCancel','paneAI','aiWho','aiBudget','aiLog','aiInput','aiSend','aiStop','aiClear','urlTitle','urlHint','urlNewOnly','urlWebsite','urlModels','urlKey','delUrlDialog','delUrlHint','delUrlWarn','delUrlConfirm','delUrlCancel','btnTheme']) {
  registry.set(id, new El());
}
globalThis.document = {
  getElementById: (id) => registry.get(id) ?? new El(),
  createElement: (tag) => new El(tag),
  querySelectorAll: () => [],
  body: new El(),
  addEventListener(){},
};
Object.defineProperty(globalThis, 'navigator', {
  value: { clipboard: { writeText: async () => {} } },
  configurable: true,
});
globalThis.location = { protocol:'http:' };
const originalFetch = createMockFetch({
  '/models': { body: { data: [] } },
  '/chat/completions': { body: { choices:[{message:{content:'OK'}}] } },
});
globalThis.fetch = originalFetch;

// Import the app for real.
process.on('unhandledRejection', (e) => { console.log('UNHANDLED:', e?.message ?? e); process.exitCode = 1; });
await import('./app.js');
await new Promise((r) => setTimeout(r, 300));

const has = (node, cls) => String(node?.className ?? '').split(/\s+/).includes(cls);
const kid = (row, cls) => row?.children.find((c) => has(c, cls));

const tree = registry.get('treeRoot');
console.log('render() chay khong loi');

// Copy is what the flat list is for, so every copy is recorded: a claim that a
// tap copies something is only worth reading if it was observed.
const copied = [];
globalThis.navigator.clipboard.writeText = async (text) => { copied.push(text); };

// The drawer is still where a URL is jumped to and configured. The main list no
// longer waits for that - it draws every URL at once - so this is a jump, not a
// selection. The drawer row is a container: the tap target sits inside it, so
// the name is read from the nested open button rather than from the row itself.
const drawerChildren = registry.get('sidebarRoot').children;
const drawerItems = drawerChildren.filter((c) => has(c, 'urlitem'));
console.log(
  'nhom:',
  drawerChildren
    .filter((c) => has(c, 'urlgroup'))
    .map((c) => c.children.map((x) => x.textContent).join(' '))
    .join(' | ')
);
// The name sits directly on the open button now: the row reads name, base URL,
// counts, badge - four lines, each one answering a question the row is asked.
function urlName(row) {
  return kid(kid(row, 'urlopen'), 'uname')?.textContent ?? '';
}
function urlBase(row) {
  return kid(kid(row, 'urlopen'), 'ubase')?.textContent ?? '';
}
function urlBadge(row) {
  const b = kid(kid(row, 'urlopen'), 'urlbadge');
  return b ? `${b.textContent} [${b.className}]` : '';
}
console.log('so muc trong drawer:', drawerItems.length);
console.log('ten URL:', drawerItems.map(urlName).join(' | '));
console.log('base URL cua Gateway:', urlBase(drawerItems.find((i) => urlName(i) === 'Gateway') ?? drawerItems[0]));
console.log('badge cua tung URL:', drawerItems.map(urlBadge).join(' | '));
const gateway = drawerItems.find((i) => urlName(i) === 'Gateway');
if (!gateway) throw new Error('drawer khong co muc Gateway');
const gatewayOpen = kid(gateway, 'urlopen');
gatewayOpen._listeners.click.forEach((fn) => fn());
await new Promise((r) => setTimeout(r, 600));
console.log('tieu de:', registry.get('treeTitle').textContent);

function modelName(row) {
  // By class, not by position: the row now carries a facts line under the name.
  const open = row.children.find((c) => c.className === 'modelopen');
  const mid = open?.children.find((c) => c.className === 'mid');
  return (mid ?? open)?.children.find((c) => c.className === 'name')?.textContent ?? '';
}

// One block per URL: the sticky header carrying the URL, then that URL's rows.
const blocks = tree.children.filter((c) => has(c, 'urlblock'));
console.log('so khoi URL tren man hinh:', blocks.length);
const blockOf = (fragment) =>
  blocks.find((b) =>
    (kid(kid(b, 'urlhead'), 'urlcopy')?.children ?? []).some((c) => c.textContent === fragment)
  );
const gatewayBlock = blockOf('https://gw.test/v1');
if (!gatewayBlock) throw new Error('khong co khoi URL cua Gateway');

// The header is the copy target for the URL, and the only place the URL is
// written on this screen.
const headerCopy = kid(kid(gatewayBlock, 'urlhead'), 'urlcopy');
console.log(
  'header URL:',
  (headerCopy?.children ?? []).map((c) => c.textContent).join(' / ')
);
const beforeHeader = copied.length;
headerCopy._listeners.click.forEach((fn) => fn());
await new Promise((r) => setTimeout(r, 60));
console.log(
  'bam header -> chep URL:',
  copied.slice(beforeHeader).includes('https://gw.test/v1') ? 'OK' : 'LOI'
);

const group = kid(gatewayBlock, 'group');
const modelRows = (group?.children ?? []).filter((c) => c.className === 'model');
console.log('so dong model render ra:', modelRows.length);
console.log('bo loc:', registry.get('filterCount').textContent);
console.log('co model bi phi thu phí khong:', modelRows.some((r) => modelName(r) === 'paid-model'));
console.log('ten model:', modelRows.map(modelName).filter(Boolean).join(', '));

// The published facts, on the row and in the dialog.
function factsOf(row) {
  const open = row.children.find((c) => c.className === 'modelopen') ?? row;
  const mid = open.children.find((c) => c.className === 'mid');
  const facts = (mid ?? open).children.find((c) => c.className === 'facts');
  return facts ? facts.children.map((c) => c.textContent) : [];
}
for (const row of modelRows) {
  const f = factsOf(row);
  console.log('facts [' + modelName(row) + ']:', f.length ? f.join(' | ') : '(khong co gi cong bo)');
}
// The free level is on the row as data and shown as a coloured dot, so the
// level is read from the row rather than from a glyph. Reading textContent
// would print nothing and hide the fact that the level is now carried at all.
console.log('muc do 0d:', modelRows.map((r) => `${modelName(r)}=${r.dataset.level}`).join(' | '));
console.log(
  'trang thai khoa:',
  modelRows
    .map((r) => {
      const lock = kid(r, 'lockbtn');
      return kid(lock, 'locklabel')?.textContent ?? '(thieu nhan)';
    })
    .join(' | ')
);
console.log('toc do:', modelRows.map((r) => kid(kid(r, 'modelopen'), 'speed')?.textContent).join(' | '));

// The row opens the card now, and the ✓ beside it checks the model. Both are
// driven, because both are what a person does with this screen.
if (!modelRows.length) throw new Error('khong co model free nao de bam');
const firstRow = modelRows[0];
const firstId = modelName(firstRow);
const beforeRow = copied.length;
kid(firstRow, 'modelopen')._listeners.click.forEach((fn) => fn());
await new Promise((r) => setTimeout(r, 200));
console.log('bam dong model -> mo the thong tin:', registry.get('modelDialog').open ? 'OK' : 'khong mo duoc');
console.log('bam dong model khong con chep:', copied.length === beforeRow ? 'OK' : 'van chep');
const checkBtn = firstRow.children.find((c) => c.title && c.title.includes('Check nhanh'));
console.log('nut ✓ tren dong:', checkBtn ? 'co' : 'khong co');

// The URL's APIs, on the row, masked - the third thing this screen is for.
const apiChips = kid(firstRow, 'apichips')?.children ?? [];
console.log(
  'API tren dong model:',
  apiChips.map((c) => c.children[1]?.textContent ?? '').join(' | ') || '(khong co)'
);
console.log(
  'lo secret tren dong:',
  apiChips.some((c) => (c.children ?? []).some((x) => [KEY_A, KEY_B].includes(x.textContent)))
    ? 'LOI: co'
    : 'khong'
);

console.log('');
console.log('--- sau khi bam model ---');
console.log('tieu de  :', registry.get('modelTitle').textContent);
console.log('URL o    :', registry.get('boxUrl').textContent);
console.log('MODEL o  :', registry.get('boxModel').textContent);
const infoBox = registry.get('modelInfo');
console.log('the tin model trong dialog:');
for (const line of infoBox.children) {
  const k = line.children.find((c) => c.className === 'infokey');
  const v = line.children.find((c) => c.className === 'infoval');
  if (k && v) console.log('   ', k.textContent.padEnd(12), v.textContent);
  else if (line.className === 'infodesc') console.log('    mo ta     ', line.textContent);
  else console.log('   ', line.textContent);
}
console.log('so API   :', registry.get('keyCount').textContent);
const keyRows = registry.get('keyRows').children;
console.log('so dong API render:', keyRows.length);
for (const row of keyRows) {
  const flex = kid(row, 'kflex');
  const label = kid(flex, 'kmasked')?.textContent ?? kid(flex, 'kfull')?.textContent ?? '';
  const status = kid(kid(flex, 'kstat'), 'kword')?.textContent ?? '';
  // Buttons are icons now, so they are identified by their accessible name
  // rather than by the glyph they used to draw.
  const buttons = row.children
    .filter((b) => has(b, 'iconbtn') || has(b, 'lockbtn'))
    .map((b) => b.title || '(khong ten)')
    .join(' / ');
  console.log('   ', label, '|', status, '| nut:', buttons);
}
const leak = JSON.stringify(keyRows.map((r) => r.children[0]?.children[0]?.textContent));
console.log('');
console.log(leak.includes(KEY_A) ? 'LOI: hien full secret o danh sach' : 'OK: chi hien masked, khong lo secret');

// Clicking an API row opens the chat panel: a real chat against that key.
const chatField = registry.get('chatField');
console.log('o chat an truoc khi bam API:', chatField.hidden === false ? 'dang hien' : 'dang an');
if (keyRows.length) {
  const flex = kid(keyRows[0], 'kflex');
  flex._listeners.click.forEach((fn) => fn());
  await new Promise((r) => setTimeout(r, 60));
  console.log('bam API -> mo o chat:', chatField.hidden === false ? 'OK' : 'khong mo');
  const chatText = (registry.get('chatLog').children ?? []).map((c) => c.textContent).join(' ');
  console.log('log chat:', chatText.slice(0, 80));
  console.log(
    'nut GUI:',
    registry.get('chatSend') ? 'co' : 'khong co',
    '| nut xoa API:',
    registry.get('chatDelete') ? 'co' : 'khong co'
  );
  console.log('lo secret trong o chat:', chatText.includes(KEY_A) || chatText.includes(KEY_B) ? 'LOI' : 'khong');
}

// Export: the working configuration, in the shape another tool reads.
registry.get('btnExport')._listeners.click.forEach((fn) => fn());
await new Promise((r) => setTimeout(r, 250));
console.log('nut xuat cau hinh -> mo sheet:', registry.get('exportDialog').open ? 'OK' : 'khong mo');
console.log('so URL xuat duoc:', registry.get('exportCount').textContent || '(khong co)');
console.log('dinh dang dau tien:', registry.get('exportFormat').value);
const exportBody = registry.get('exportOut').textContent;
console.log('so dong ban xuat:', exportBody.split('\n').length);
console.log('ban xuat co lo secret:', exportBody.includes(KEY_A) || exportBody.includes(KEY_B) ? 'co (dung, vi day la ban xuat chu dich)' : 'khong');

// Reveal path
if (keyRows.length) {
  keyRows[0]._listeners.click;
  const revealBtn = keyRows[0].children.find((c) => c.textContent === '\ud83d\udc41' || c.title === 'Hi\u1ec7n v\u00e0 ch\u00e9p key');
  if (revealBtn?._listeners.click) {
    revealBtn._listeners.click.forEach((fn) => fn());
    await new Promise((r) => setTimeout(r, 100));
    const after = registry.get('keyRows').children;
    console.log('sau khi bam eye:', after[0].children[0].children[0].textContent === KEY_A ? 'hien full key (chi khi bam)' : 'van masked');
  }
}
