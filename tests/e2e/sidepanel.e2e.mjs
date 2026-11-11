// 端到端测试：用完整 Chromium 加载真实插件。
// 运行：npx playwright install chromium && node tests/e2e/sidepanel.e2e.mjs
// （会把插件复制到 /tmp/ext-sidepanel）
//
// 测试工具看不到 Chrome 侧边栏里的页面，所以界面部分在一个普通标签页里打开 sidepanel.html 来测
// （它所在的窗口就是「这个窗口」）；侧边栏本身只检查「Chrome 确实把我们的页面放进了侧边栏」。
// 测试浏览器没有登录 Google 账号，「其他电脑」用直接往 storage.sync 里写一台假设备的清单来模拟。
import { execSync } from 'node:child_process';
import { chromium } from 'playwright';

const EXT = '/tmp/ext-sidepanel';
execSync(`rm -rf ${EXT} && mkdir -p ${EXT} && cp -r manifest.json *.js *.html *.css icons _locales ${EXT}/`);
const PROF = '/tmp/prof-sidepanel-' + Date.now();
const launch = () =>
  chromium.launchPersistentContext(PROF, {
    channel: 'chromium', headless: true, viewport: { width: 1100, height: 700 },
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  });
let ctx = await launch();
let [sw] = ctx.serviceWorkers();
if (!sw) sw = await ctx.waitForEvent('serviceworker');
const extId = new URL(sw.url()).host;
// 下面的断言都是中文：不管这台电脑的浏览器是什么语言，先固定成中文（书签里的置顶文件夹也改回「置顶」）
await new Promise((r) => setTimeout(r, 1000));
await sw.evaluate(async () => {
  await chrome.storage.local.set({ 'ui.lang': 'zh' });
  for (const b of await chrome.bookmarks.search({ title: 'Pinned' })) if (!b.url) await chrome.bookmarks.update(b.id, { title: '置顶' });
});
const page = (r) => r.fulfill({ contentType: 'text/html', body: `<!doctype html><meta charset=utf-8><title>${new URL(r.request().url()).pathname.slice(1)}</title><p>正文</p>` });
const route = async (c) => {
  await c.route('http://site.test/**', page);
  await c.route('http://other.test/**', page);
};
await route(ctx);

let pass = 0, fail = 0;
const check = (name, ok, extra = '') => { ok ? pass++ : fail++; console.log((ok ? '  ✓ ' : '  ✗ ') + name, ok ? '' : extra); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 15000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn().catch(() => null);
    if (v) return v;
    await sleep(300);
  }
  return null;
};

console.log('安装后');
const shortcut = await sw.evaluate(async () => (await chrome.commands.getAll()).find((c) => c.name === '_execute_action')?.shortcut || '');
check('快捷键已注册（默认 Command+Shift+Y / Ctrl+Shift+Y，不和网页里的加粗抢 Command+B）', /Y$/.test(shortcut) && !/\+B$/.test(shortcut), JSON.stringify(shortcut));
const behavior = await sw.evaluate(() => chrome.sidePanel.getPanelBehavior());
check('点工具栏图标 / 按快捷键：打开或关闭侧边栏', behavior.openPanelOnActionClick === true, JSON.stringify(behavior));
const manifest = await sw.evaluate(() => chrome.runtime.getManifest());
check('名字是 Side Pocket', manifest.name === 'Side Pocket' && ['打开或关闭 Side Pocket', 'Open or close Side Pocket'].includes(manifest.action.default_title) && manifest.default_locale === 'en' && !manifest.description.includes('__MSG'), manifest.name);
check('不申请「读取和修改所有网站」，不往网页里注入', !manifest.host_permissions && !manifest.content_scripts && !manifest.permissions.includes('scripting'));
check('只申请用得到的权限', JSON.stringify([...manifest.permissions].sort()) === JSON.stringify(['alarms', 'bookmarks', 'favicon', 'fontSettings', 'sidePanel', 'storage', 'tabs']), JSON.stringify(manifest.permissions));

const site = await ctx.newPage();
await site.goto('http://site.test/a');
const panel = await ctx.newPage();
panel.on('pageerror', (e) => console.log('pageerror', e.message));
await panel.goto(`chrome-extension://${extId}/sidepanel.html`);
await sleep(1200);
check('侧栏页面标题是 Side Pocket', (await panel.title()) === 'Side Pocket', await panel.title());

console.log('这个窗口：和 Chrome 标签栏一模一样');
const panelWin = await panel.evaluate(async () => (await chrome.windows.getCurrent()).id);
/** Chrome 里这个窗口的标签（不含侧栏页面自己），按标签栏顺序 */
const chromeTabs = () => sw.evaluate(async (w) => (await chrome.tabs.query({ windowId: w })).filter((t) => !(t.url || '').includes('/sidepanel.html')).sort((a, b) => a.index - b.index).map((t) => String(t.id)), panelWin);
const shownTabs = () => panel.locator('#tabs .row.tab').evaluateAll((rows) => rows.map((r) => r.dataset.tab));
const same = async () => JSON.stringify(await shownTabs()) === JSON.stringify(await chromeTabs());
check('一开始：条数和顺序都一样', await same(), JSON.stringify([await shownTabs(), await chromeTabs()]));
await sw.evaluate(async (w) => { await chrome.tabs.create({ windowId: w, url: 'http://site.test/a', active: false }); await chrome.tabs.create({ windowId: w, active: false }); await chrome.tabs.create({ windowId: w, url: 'chrome://settings/', active: false }); }, panelWin);
await sleep(1500);
check('同一网址开两个、新标签页、设置页：全都显示，顺序一样', (await same()) && (await shownTabs()).length === 5, JSON.stringify([await shownTabs(), await chromeTabs()]));
const titlesShown = await panel.locator('#tabs .row.tab .title').allTextContents();
check('新标签页显示为「新标签页」', titlesShown.includes('新标签页'), JSON.stringify(titlesShown));
for (const u of ['http://site.test/a1', 'http://site.test/a2']) { await site.goto(u); await sleep(500); }
await sleep(800);
check('标签里跳转：只是这一行变了，条数不变', (await same()) && (await panel.locator('#tabs .row.tab[title="http://site.test/a2"]').count()) === 1, JSON.stringify(await panel.locator('#tabs .row.tab').evaluateAll((r) => r.map((x) => x.title))));
const ids = await chromeTabs();
await sw.evaluate(async (id) => chrome.tabs.move(Number(id), { index: -1 }), ids[0]);
await sleep(1000);
check('在 Chrome 里拖动标签：侧栏顺序跟着变', (await same()) && (await shownTabs()).at(-1) === ids[0], JSON.stringify([await shownTabs(), await chromeTabs()]));
const last = (await shownTabs()).at(-2);
await panel.locator(`#tabs .row.tab[data-tab="${last}"]`).hover();
await panel.locator(`#tabs .row.tab[data-tab="${last}"] [data-act=close]`).click();
await sleep(1000);
check('点 ✕：关掉这个标签，侧栏少一行', (await same()) && !(await chromeTabs()).includes(last), JSON.stringify([await shownTabs(), await chromeTabs()]));
await panel.screenshot({ path: (process.env.OUT || '/tmp/') + 'sidepanel-window.png' });
await panel.bringToFront();
await panel.evaluate(() => {
  const orig = navigator.clipboard.writeText.bind(navigator.clipboard);
  window.__clip = [];
  navigator.clipboard.writeText = (t) => orig(t).then(() => { window.__clip.push('ok:' + t); }, (e) => { window.__clip.push('err:' + e.message); throw e; });
});
await panel.locator('#tabs .row.tab[title="http://site.test/a2"]').first().click({ button: 'right' });
await panel.locator('#menu button', { hasText: '复制链接' }).click();
await sleep(500);
const clip = await panel.evaluate(() => window.__clip);
check('右键「复制链接」：不申请剪贴板权限也能复制', JSON.stringify(clip) === '["ok:http://site.test/a2"]' && (await panel.locator('#status').textContent()) === '已复制链接', JSON.stringify(clip));

console.log('当前标签自动滚进视野');
check('侧栏里没有自己的关闭按钮（Chrome 侧边栏标题栏上已经有 ✕）', (await panel.locator('#toggle-collapse').count()) === 0);
const extra = await sw.evaluate(async (w) => { const out = []; for (let i = 0; i < 24; i++) out.push((await chrome.tabs.create({ windowId: w, url: 'http://site.test/many' + i, active: false })).id); return out; }, panelWin);
await sleep(1500);
// 测试里侧栏是一个普通标签页，切到别的标签它就到后台了；真正的侧边栏一直看得见，这里装成那样
await panel.evaluate(() => { Object.defineProperty(document, 'hidden', { get: () => false }); document.hasFocus = () => false; document.querySelector('#scroll').scrollTop = 0; });
// 鼠标不在侧栏里（在网页上）
const mouseOut = () => panel.evaluate(() => document.documentElement.dispatchEvent(new MouseEvent('mouseleave')));
await sleep(1600);
await mouseOut();
const inView = (id) => panel.evaluate((id) => {
  const r = document.querySelector(`#tabs .row.tab[data-tab="${id}"]`)?.getBoundingClientRect();
  const s = document.querySelector('#scroll').getBoundingClientRect();
  return !!r && r.top >= s.top && r.bottom <= s.bottom;
}, id);
const lastTab = extra.at(-1);
check('标签很多时，最后一个标签一开始在屏幕外', !(await inView(lastTab)));
await sw.evaluate((id) => chrome.tabs.update(id, { active: true }), lastTab);
check('在 Chrome 里切到它：侧栏自动把它滚进视野，并标成当前', !!(await until(async () => (await inView(lastTab)) && (await panel.locator(`#tabs .row.tab.active[data-tab="${lastTab}"]`).count()) === 1, 5000)));
const scrollTop = () => panel.evaluate(() => document.querySelector('#scroll').scrollTop);
// 鼠标在侧栏里、焦点已经被 Chrome 交给网页：就是「点了上面的收藏，它的标签在最下面」的情形
await panel.evaluate(() => { document.querySelector('#scroll').scrollTop = 0; document.documentElement.dispatchEvent(new MouseEvent('mouseenter')); });
await sw.evaluate((id) => chrome.tabs.update(id, { active: true }), extra.at(-2));
await sleep(1200);
check('鼠标在侧栏里时（刚点了上面的收藏）：不自动滚动，哪怕焦点已经到了网页', (await scrollTop()) === 0);
await mouseOut();
await panel.evaluate(() => { document.hasFocus = () => true; });
await sw.evaluate((id) => chrome.tabs.update(id, { active: true }), extra.at(-3));
await sleep(1200);
check('侧栏有焦点时：不自动滚动', (await scrollTop()) === 0);
// 当前标签的置顶已经亮着并且看得见：不用滚到下面那一行
await panel.evaluate(() => { document.hasFocus = () => false; });
await panel.evaluate(() => chrome.runtime.sendMessage({ type: 'side-pocket:op', op: 'saveTab', args: { url: 'http://site.test/many23', title: 'many23', parent: 'pinned' } }));
await sleep(1000);
await sw.evaluate((id) => chrome.tabs.update(id, { active: true }), lastTab);
await sleep(1200);
check('在 Chrome 里切到一个标签，它的置顶在上面亮着：不滚到下面去', (await scrollTop()) === 0 && (await panel.locator('#pinned .tile.active').count()) === 1, String(await scrollTop()));
await panel.evaluate(() => chrome.runtime.sendMessage({ type: 'side-pocket:op', op: 'remove', args: { id: document.querySelector('#pinned .tile').dataset.id } }));
await sleep(800);
await sw.evaluate((ids) => chrome.tabs.remove(ids), extra);
await panel.bringToFront();
await panel.evaluate(() => { delete document.hidden; delete document.hasFocus; });
await sleep(1200);
check('关掉这些标签后，侧栏和 Chrome 还是一样', await same(), JSON.stringify([await shownTabs(), await chromeTabs()]));

console.log('其他电脑：上传本机清单');
const selfId = await sw.evaluate(async () => (await chrome.storage.local.get('deviceId')).deviceId);
const mine = await until(() => sw.evaluate(async (id) => {
  const all = await chrome.storage.sync.get(null);
  const m = all['dv:' + id];
  return m && m.n ? { meta: m, tabs: all[`dt:${id}:0`] } : null;
}, selfId));
check('标签变化后十几秒内，本机清单写进了同步存储', !!mine, JSON.stringify(mine));
check('清单只有普通网页，同网址只留一个，没有新标签页和设置页', !!mine && mine.tabs.every((t) => /^http/.test(t[0])) && new Set(mine.tabs.map((t) => t[0])).size === mine.tabs.length, JSON.stringify(mine?.tabs));
check('本机自己不出现在「其他电脑」里', (await panel.locator('#devices .device-head').count()) === 0);

console.log('其他电脑：显示别的电脑的清单');
await sw.evaluate(() => chrome.storage.sync.set({
  'dv:devfake1': { nm: '公司', at: Date.now() - 3 * 60e3, n: 1, tot: 2, sk: 0 },
  'dt:devfake1:0': [['http://site.test/a', 'A 页面'], ['http://site.test/remote1', '公司那边的网页']],
}));
await sleep(1200);
check('显示设备名和「3 分钟前」', (await panel.locator('#devices .device-head .title').textContent()) === '公司' && (await panel.locator('#devices .device-head .when').textContent()) === '3 分钟前', await panel.locator('#devices').innerText());
check('两个网页都显示', (await panel.locator('#devices .row.remote').count()) === 2);
check('本机已经开着的标「已开着」', (await panel.locator('#devices .row.remote[title="http://site.test/a"] .tag').textContent()) === '已开着');
const before = (await chromeTabs()).length;
await panel.locator('#devices .row.remote[title="http://site.test/remote1"]').click();
await sleep(1500);
check('点一下：在这台电脑打开', (await chromeTabs()).length === before + 1 && (await panel.locator('#tabs .row.tab[title="http://site.test/remote1"]').count()) === 1);
check('打开后那一行也标上「已开着」', (await panel.locator('#devices .row.remote[title="http://site.test/remote1"] .tag').count()) === 1);
await panel.screenshot({ path: (process.env.OUT || '/tmp/') + 'sidepanel-devices.png' });
await panel.locator('#devices .device-head').click();
await sleep(300);
check('点设备名：折叠这台电脑的清单', (await panel.locator('#devices .row.remote').count()) === 0);
await panel.locator('#devices .device-head').click();
const sendOp = (op, args) => panel.evaluate(([op, args]) => chrome.runtime.sendMessage({ type: 'side-pocket:op', op, args }), [op, args]);
await sendOp('removeDevice', { id: 'devfake1' });
await sleep(800);
const fakeLeft = await sw.evaluate(async () => Object.keys(await chrome.storage.sync.get(null)).filter((k) => k.includes('devfake1')));
check('移除这台设备：同步存储里它的清单删掉，侧栏也没了', fakeLeft.length === 0 && (await panel.locator('#devices .device-head').count()) === 0, JSON.stringify(fakeLeft));

console.log('设置');
await panel.locator('#open-settings').click();
await sleep(400);
check('设置里显示当前快捷键', (await panel.locator('#shortcut-key').textContent()) === shortcut);
check('这台电脑的名字有默认值', /·/.test(await panel.locator('#device-name').inputValue()), await panel.locator('#device-name').inputValue());
await panel.locator('#device-name').fill('家里');
await panel.locator('#device-name').press('Enter');
await sleep(1200);
const nm = await sw.evaluate(async (id) => (await chrome.storage.sync.get('dv:' + id))['dv:' + id]?.nm, selfId);
check('改名后马上同步出去', nm === '家里', nm);
console.log('外观：字体、粗细、字号');
const lookOf = () => panel.evaluate(async () => {
  const b = getComputedStyle(document.body);
  return { family: b.fontFamily, size: b.fontSize, weight: b.fontWeight, strong: getComputedStyle(document.querySelector('#saved-section .sec-head')).fontWeight, rowH: getComputedStyle(document.querySelector('#new-tab')).height, saved: (await chrome.storage.local.get('ui.font'))['ui.font'] };
});
const look0 = await lookOf();
check('默认：系统字体、13px、普通 400、强调 500', look0.family.startsWith('system-ui') && look0.size === '13px' && look0.weight === '400' && look0.strong === '500' && !look0.saved, JSON.stringify(look0));
const fontIds = await panel.locator('#font-family option').evaluateAll((o) => o.map((x) => x.value));
check('字体下拉里是「跟随系统」加这台电脑已安装的字体', fontIds[0] === '' && fontIds.length > 5, String(fontIds.length));
const pickFont = fontIds[Math.floor(fontIds.length / 2)];
await panel.locator('#font-family').selectOption(pickFont);
await panel.locator('#font-weight').selectOption('300');
await panel.locator('#font-strong').selectOption('700');
await panel.locator('#font-size').selectOption('l');
await sleep(400);
const look1 = await lookOf();
check('选了字体、粗细、字号：马上生效', look1.family.replace(/"/g, '').startsWith(pickFont) && look1.size === '15px' && look1.weight === '300' && look1.strong === '700' && look1.rowH === '36px' && look1.saved?.family === pickFont && look1.saved.weight === 300 && look1.saved.strong === 700 && look1.saved.size === 'l', JSON.stringify(look1));
await panel.screenshot({ path: (process.env.OUT || '/tmp/') + 'sidepanel-look.png' });
await panel.reload();
await sleep(1200);
const look2 = await lookOf();
check('重新打开侧栏：外观还是刚才选的', look2.family.replace(/"/g, '').startsWith(pickFont) && look2.size === '15px' && look2.strong === '700', JSON.stringify(look2));
await panel.locator('#open-settings').click();
await sleep(500);
check('设置里选中的是当前值', (await panel.locator('#font-family').inputValue()) === pickFont && (await panel.locator('#font-strong').inputValue()) === '700' && (await panel.locator('#font-size').inputValue()) === 'l');
await panel.locator('#reset-look').click();
await sleep(400);
const look3 = await lookOf();
check('恢复默认外观', look3.family.startsWith('system-ui') && look3.size === '13px' && look3.weight === '400' && look3.strong === '500' && !look3.saved && (await panel.locator('#font-family').inputValue()) === '', JSON.stringify(look3));

console.log('语言：中文 / English');
const textsOf = () => panel.evaluate(() => ({
  lang: document.documentElement.lang,
  heads: [...document.querySelectorAll('#browse .sec-head > span:first-child')].map((x) => x.textContent),
  ph: document.querySelector('#search').placeholder,
  sync: document.querySelector('#sync-state').textContent,
  empty: getComputedStyle(document.querySelector('#pinned'), '::before').content,
  setting: document.querySelector('#settings-pop .settings-title').textContent,
  weight: document.querySelector('#font-weight').selectedOptions[0].textContent,
  newTab: document.querySelector('#new-tab').textContent.trim(),
  // 界面上我们自己写的文字：去掉字体下拉框（系统给的字体名）、标签标题（网页自己的标题）
  all: (() => {
    for (const x of document.querySelectorAll('#font-family, #tabs .row .title')) x.dataset.skip = '1';
    const out = [...document.body.querySelectorAll('*')].filter((x) => !x.closest('[data-skip]') && !x.children.length && !['SCRIPT', 'STYLE'].includes(x.tagName)).map((x) => x.textContent.trim()).filter(Boolean);
    for (const x of document.querySelectorAll('[data-skip]')) delete x.dataset.skip;
    return out.join('\n');
  })(),
}));
const zh0 = await textsOf();
check('中文界面', zh0.lang === 'zh-CN' && JSON.stringify(zh0.heads) === '["置顶","收藏","这个窗口","其他电脑"]' && zh0.sync === '已同步' && zh0.setting === '外观' && zh0.empty.includes('把网站拖到这里置顶'), JSON.stringify({ ...zh0, all: 0 }));
await panel.locator('#lang').selectOption('en');
await sleep(800);
const en = await textsOf();
check('切到 English：区块标题、搜索框、底栏、设置都变成英文', en.lang === 'en' && JSON.stringify(en.heads) === '["Pinned","Saved","This window","Other computers"]' && en.ph.startsWith('Search') && en.sync === 'Synced' && en.setting === 'Appearance' && en.weight === 'Regular' && en.newTab === 'New tab' && en.empty.includes('Drag a site here'), JSON.stringify({ ...en, all: 0 }));
const zhLeft = en.all.split('\n').filter((l) => /[\u4e00-\u9fff]/.test(l) && l.trim() !== '中文');
check('英文界面里没有漏翻的中文（除了语言选项「中文」）', zhLeft.length === 0, JSON.stringify(zhLeft));
await panel.locator('#search').click(); // 点一下别处，收起设置
await sleep(300);
await panel.locator('#tabs .row.tab').first().click({ button: 'right' });
await sleep(300);
const menuEn = await panel.locator('#menu').innerText();
check('右键菜单是英文', /Copy link/.test(menuEn) && /Close tab/.test(menuEn) && !/[\u4e00-\u9fff]/.test(menuEn), menuEn);
await panel.keyboard.press('Escape');
await panel.screenshot({ path: (process.env.OUT || '/tmp/') + 'sidepanel-en.png' });
const bgEn = await panel.evaluate(() => chrome.runtime.sendMessage({ type: 'side-pocket:op', op: 'saveTab', args: { url: 'javascript:alert(1)', title: 'x' } }));
check('后台的出错提示也跟着换成英文', bgEn?.ok === false && !/[\u4e00-\u9fff]/.test(bgEn.error), JSON.stringify(bgEn));
await panel.locator('#open-settings').click();
await sleep(400);
await panel.locator('#lang').selectOption('zh');
await sleep(800);
const zh1 = await textsOf();
check('切回中文', zh1.lang === 'zh-CN' && JSON.stringify(zh1.heads) === JSON.stringify(zh0.heads) && zh1.sync === '已同步' && zh1.weight === '常规', JSON.stringify({ ...zh1, all: 0 }));

const myKeys = () => sw.evaluate(async (id) => Object.keys(await chrome.storage.sync.get(null)).filter((k) => k === 'dv:' + id || k.startsWith(`dt:${id}:`)), selfId);
check('上传开关默认是开的', (await panel.locator('#share-tabs').isChecked()) && (await myKeys()).length >= 2, JSON.stringify(await myKeys()));
await panel.locator('#share-tabs').uncheck();
await sleep(1200);
check('关掉上传：本机清单从同步存储里删掉，底栏显示「未开启同步」', (await myKeys()).length === 0 && (await panel.locator('#sync-state').textContent()) === '未开启同步', JSON.stringify([await myKeys(), await panel.locator('#sync-state').textContent()]));
await sw.evaluate(async (w) => chrome.tabs.create({ windowId: w, url: 'http://site.test/while-off', active: false }), panelWin);
await sleep(13000);
check('关着的时候开新网页：不上传', (await myKeys()).length === 0, JSON.stringify(await myKeys()));
await panel.locator('#share-tabs').check();
await sleep(1200);
const backTabs = await sw.evaluate(async (id) => (await chrome.storage.sync.get(`dt:${id}:0`))[`dt:${id}:0`], selfId);
check('重新打开：马上整份上传，底栏回到「已同步」', (await myKeys()).length >= 2 && backTabs?.some((t) => t[0] === 'http://site.test/while-off') && (await panel.locator('#sync-state').textContent()) === '已同步', JSON.stringify([await myKeys(), backTabs]));
await panel.screenshot({ path: (process.env.OUT || '/tmp/') + 'sidepanel-settings.png' });
const opened = ctx.waitForEvent('page', { timeout: 3000 }).catch(() => null);
await panel.locator('#edit-shortcut').click();
const sp = await opened;
check('「修改快捷键」打开 Chrome 的快捷键设置页', sp?.url() === 'chrome://extensions/shortcuts', sp?.url());
await sp?.close();

console.log('Chrome 侧边栏');
await panel.bringToFront();
await panel.evaluate(async () => {
  const w = await chrome.windows.getCurrent(); // 先拿到窗口 id：点击处理里不能先 await，否则不算用户点击
  const b = document.createElement('button');
  b.id = 'test-open';
  b.textContent = 'open';
  b.style.cssText = 'position:fixed;left:0;top:0;z-index:99';
  b.onclick = () => chrome.sidePanel.open({ windowId: w.id });
  document.body.append(b);
});
await panel.locator('#test-open').click();
await sleep(1000);
const contexts = await sw.evaluate(async () => (await chrome.runtime.getContexts({ contextTypes: ['SIDE_PANEL'] })).map((c) => c.documentUrl));
check('侧边栏里加载的是我们的侧栏', contexts.length === 1 && contexts[0].endsWith('/sidepanel.html'), JSON.stringify(contexts));
await sw.evaluate(async () => { const w = await chrome.windows.getLastFocused(); await chrome.sidePanel.close({ windowId: w.id }); });
await sleep(500);

console.log('置顶和收藏（Chrome 书签）');
const bmList = (w = sw) => w.evaluate(async () => {
  const top = await chrome.bookmarks.getChildren('0');
  const other = top.find((b) => b.folderType === 'other') || top.find((b) => b.id === '2');
  const root = (await chrome.bookmarks.getChildren(other.id)).find((b) => b.title === 'Side Pocket' && !b.url);
  if (!root) return null;
  const [t] = await chrome.bookmarks.getSubTree(root.id);
  const out = [];
  const walk = (b, path) => {
    for (const c of b.children || []) {
      if (c.url) out.push(path + c.url);
      else { out.push(path + c.title + '/'); walk(c, path + c.title + '/'); }
    }
  };
  walk(t, '');
  return out;
});
const row = panel.locator('#tabs .row.tab[title="http://site.test/remote1"]');
await row.hover();
await row.locator('[data-act=save]').click();
await sleep(1000);
let list = await bmList();
check('标签上点「收藏」：变成书签，标签照常开着', list.includes('http://site.test/remote1') && (await row.count()) === 1, JSON.stringify(list));
check('收藏上显示「开着」', (await panel.locator('#saved .row.link.open[title="http://site.test/remote1"]').count()) === 1);
const bkmId = await panel.locator('#saved .row.link[title="http://site.test/remote1"]').getAttribute('data-id');
await sendOp('pin', { id: bkmId });
await sleep(800);
list = await bmList();
check('置顶：书签挪进「置顶」文件夹', list.includes('置顶/http://site.test/remote1'), JSON.stringify(list));
const fid = (await sendOp('addFolder', { id: 'tmpfold1', title: '工作' }))?.result;
await sendOp('setColor', { id: fid, color: 'green' });
await sleep(800);
list = await bmList();
const colors = await sw.evaluate(async () => (await chrome.storage.sync.get('ui.folderColors'))['ui.folderColors']);
check('新建文件夹：建在书签里，颜色另外记下', list.includes('工作/') && colors?.['工作'] === 'green', JSON.stringify([list, colors]));
const wellBg = (title) => panel.locator('#saved .folder-well', { has: panel.locator('> .row.folder', { hasText: title }) }).first().evaluate((w) => [w.className, getComputedStyle(w).backgroundColor]);
const [wellCls, wellColor] = await wellBg('工作');
check('有颜色的文件夹：整块铺一层这个颜色的淡底', wellCls.includes('tinted') && !/rgba\(0, 0, 0, 0\)|transparent/.test(wellColor), JSON.stringify([wellCls, wellColor]));
const plain = (await sendOp('addFolder', { id: 'tmpfold2', title: '没颜色', parent: fid }))?.result;
await sleep(800);
const [plainCls, plainColor] = await wellBg('没颜色');
const plainIcon = await panel.locator('#saved .row.folder', { hasText: '没颜色' }).locator('.folder-ico').evaluate((x) => getComputedStyle(x).color);
const greenIcon = await panel.locator('#saved .row.folder', { hasText: '工作' }).locator('.folder-ico').evaluate((x) => getComputedStyle(x).color);
check('里面没设颜色的子文件夹：自己不铺底，图标也不跟着外层变色', !plainCls.includes('tinted') && /rgba\(0, 0, 0, 0\)|transparent/.test(plainColor) && plainIcon !== greenIcon, JSON.stringify([plainCls, plainColor, plainIcon, greenIcon]));
await sendOp('remove', { id: plain });
await sleep(600);
check('置顶格子下面显示标题', (await panel.locator('#pinned .tile .tile-label').first().textContent()).length > 0, await panel.locator('#pinned .tile').first().innerHTML());
const letter = await until(async () => (await panel.locator('#pinned .tile img').first().getAttribute('src')).startsWith('data:image/svg'), 5000);
const chromeIcons = await panel.locator('#tabs .row.tab img.fav').evaluateAll((xs) => xs.map((x) => [x.closest('.row').title, x.getAttribute('src')]).filter(([u]) => !/^https?:/.test(u)));
check('没有图标的网站：用「色块 + 标题第一个字」代替一排地球；Chrome 自己的页面照常', !!letter && chromeIcons.every(([, src]) => src.includes('/_favicon/')), JSON.stringify(chromeIcons));
await panel.locator('#devices-section .sec-head').click();
await sleep(300);
const secOff = await panel.evaluate(async () => [document.querySelector('#devices').offsetParent === null, document.querySelector('#devices-section .sec-head').getAttribute('aria-expanded'), (await chrome.storage.local.get('ui.sectionCollapsed'))['ui.sectionCollapsed']]);
check('点区块标题：折叠这个区块，并且记住', secOff[0] && secOff[1] === 'false' && secOff[2]?.devices === true, JSON.stringify(secOff));
await panel.locator('#devices-section .sec-head').focus();
await panel.keyboard.press('Enter');
await sleep(300);
check('键盘：聚焦区块标题按回车展开', await panel.evaluate(() => document.querySelector('#devices').offsetParent !== null && document.querySelector('#devices-section .sec-head').getAttribute('aria-expanded') === 'true'));

console.log('置顶可以重命名');
await panel.bringToFront();
const firstTile = panel.locator('#pinned .tile').first();
const firstUrl = await firstTile.evaluate((x) => x.title.split('\n')[0]) && await panel.evaluate(async () => { const id = document.querySelector('#pinned .tile').dataset.id.slice(3); return (await chrome.bookmarks.get(id))[0].url; });
await firstTile.click({ button: 'right' });
await panel.locator('#menu button', { hasText: '重命名' }).click();
await sleep(400);
const renameBox = panel.locator('#pinned .tile input.rename');
check('右键置顶点「重命名」：格子里出现输入框，已选中原来的名字', (await renameBox.count()) === 1 && (await renameBox.evaluate((x) => document.activeElement === x && x.selectionEnd - x.selectionStart === x.value.length && x.value.length > 0)));
const tabsBefore = (await chromeTabs()).length;
await renameBox.click();
await panel.keyboard.press('ControlOrMeta+a');
await panel.keyboard.type('新 名字');
await panel.keyboard.press('Enter');
await sleep(1000);
const renamed = await sw.evaluate(async (u) => (await chrome.bookmarks.search({ url: u })).map((b) => b.title), firstUrl);
check('输入新名字按回车：格子标题和书签都改了，不会误打开网页', (await firstTile.locator('.tile-label').textContent()) === '新 名字' && renamed.includes('新 名字') && (await panel.locator('#pinned input.rename').count()) === 0 && (await chromeTabs()).length === tabsBefore, JSON.stringify([renamed, await firstTile.innerHTML()]));
await firstTile.click({ button: 'right' });
await panel.locator('#menu button', { hasText: '重命名' }).click();
await sleep(300);
await panel.keyboard.type('不要这个');
await panel.keyboard.press('Escape');
await sleep(500);
check('按 Esc：取消，名字不变', (await firstTile.locator('.tile-label').textContent()) === '新 名字');

console.log('删除后可以撤销');
await sendOp('saveTab', { url: 'http://site.test/in-folder', title: '文件夹里的网页', parent: fid });
await sendOp('setCollapsed', { id: fid, collapsed: true });
await sleep(800);
await panel.bringToFront();
await panel.locator('#saved .row.folder', { hasText: '工作' }).click({ button: 'right' });
await panel.locator('#menu button', { hasText: '删除文件夹（含 1 项）' }).click();
await sleep(1000);
list = await bmList();
check('删除文件夹：书签里没了，出现「撤销」', !list.includes('工作/') && (await panel.locator('#status .status-act').textContent()) === '撤销' && (await panel.locator('#status').textContent()).includes('已删除文件夹「工作」（含 1 项）'), JSON.stringify([list, await panel.locator('#status').textContent()]));
await panel.screenshot({ path: (process.env.OUT || '/tmp/') + 'sidepanel-undo.png' });
await panel.locator('#status .status-act').click();
await sleep(1200);
list = await bmList();
const colors2 = await sw.evaluate(async () => (await chrome.storage.sync.get('ui.folderColors'))['ui.folderColors']);
const backRow = panel.locator('#saved .row.folder', { hasText: '工作' });
check('点撤销：文件夹和里面的网页回来了，位置不变', list.includes('工作/') && list.includes('工作/http://site.test/in-folder') && list.indexOf('工作/') === list.length - 2, JSON.stringify(list));
check('撤销后颜色和折叠状态还在', colors2?.['工作'] === 'green' && (await backRow.getAttribute('style'))?.includes('green') && (await backRow.getAttribute('class')).includes('is-collapsed'), JSON.stringify([colors2, await backRow.getAttribute('style'), await backRow.getAttribute('class')]));
await sendOp('undoRemove', {});
await sleep(500);
check('撤销只能用一次，不会重复建', JSON.stringify(await bmList()) === JSON.stringify(list));
const linkRow = panel.locator('#saved .row.link[title^="http://site.test/in-folder"]');
await backRow.click(); // 展开
await sleep(500);
await linkRow.click(); // 打开并认领
await sleep(1200);
const claimedTab = await sw.evaluate(async (w) => (await chrome.tabs.query({ windowId: w, active: true }))[0], panelWin);
await sw.evaluate((id) => chrome.tabs.update(id, { url: 'http://other.test/moved-away' }), claimedTab.id);
await sleep(1200);
await panel.bringToFront(); await sleep(400);
await linkRow.click({ button: 'right' });
await panel.locator('#menu button', { hasText: /^删除$/ }).click();
await sleep(1000);
await panel.locator('#status .status-act').click();
await sleep(1200);
check('删掉一个认领着标签的收藏再撤销：标签还是它的', (await linkRow.getAttribute('class')).includes('open') && (await panel.locator(`#tabs .row.tab[data-tab="${claimedTab.id}"] .claim-ico`).count()) === 1, await linkRow.getAttribute('class'));
await sw.evaluate((id) => chrome.tabs.remove(id), claimedTab.id);
await sleep(600);

console.log('点置顶：一个置顶在这个窗口只对应一个标签');
await sendOp('saveTab', { url: 'http://site.test/pinA', title: 'PinA', parent: 'pinned' });
await sleep(800);
const tile = panel.locator('#pinned .tile[title^="PinA"]');
const winInfo = () => sw.evaluate(async (w) => {
  const ts = (await chrome.tabs.query({ windowId: w })).filter((t) => !(t.url || '').includes('/sidepanel.html'));
  return { n: ts.length, active: ts.find((t) => t.active)?.id, ids: ts.map((t) => t.id), urls: Object.fromEntries(ts.map((t) => [t.id, t.url || t.pendingUrl])) };
}, panelWin);
const clickTile = async () => { await panel.bringToFront(); await sleep(500); await tile.click(); await sleep(1200); };
let w0 = await winInfo();
await clickTile();
let w1 = await winInfo();
const a1 = w1.ids.find((id) => !w0.ids.includes(id));
check('第一次点：在这个窗口新开 A1', w1.n === w0.n + 1 && a1 && w1.active === a1, JSON.stringify([w0, w1]));
await sw.evaluate((id) => chrome.tabs.update(id, { url: 'http://other.test/elsewhere' }), a1);
await sleep(1200);
await panel.bringToFront(); await sleep(600);
check('A1 跳到别的网站：置顶 A 还亮着', (await tile.getAttribute('class')).includes('open'), await tile.getAttribute('class'));
check('悬停提示「现在：…」', (await tile.getAttribute('title')).includes('现在：'), await tile.getAttribute('title'));
check('这个窗口里 A1 前面有小图钉', (await panel.locator(`#tabs .row.tab[data-tab="${a1}"] .claim-ico`).count()) === 1);
const a2 = await sw.evaluate(async (w) => (await chrome.tabs.create({ windowId: w, url: 'http://site.test/pinA', active: false })).id, panelWin);
await sleep(800);
w0 = await winInfo();
await clickTile();
w1 = await winInfo();
check('手动开了 A2 后再点 A：还是切到 A1，不新开', w1.n === w0.n && w1.active === a1, JSON.stringify([w0, w1, a1, a2]));
await sw.evaluate((id) => chrome.tabs.remove(id), a1);
await sleep(800);
w0 = await winInfo();
await clickTile();
w1 = await winInfo();
check('关掉 A1 再点 A：认领开着的 A2，不新开', w1.n === w0.n && w1.active === a2, JSON.stringify([w0, w1, a2]));
await sw.evaluate((id) => chrome.tabs.update(id, { url: 'http://other.test/away' }), a2);
await sleep(1000);
await panel.bringToFront(); await sleep(600);
await tile.click({ button: 'right' });
await sleep(300);
await panel.locator('#menu button', { hasText: '回到原网址' }).click();
await sleep(1200);
w1 = await winInfo();
check('右键「回到原网址」：A2 回到置顶的网址', w1.urls[a2] === 'http://site.test/pinA' && w1.n === w0.n, JSON.stringify(w1));

await sw.evaluate(async (w) => { const t = (await chrome.tabs.query({ windowId: w })).find((x) => (x.url || '').includes('/sidepanel.html')); await chrome.tabs.update(t.id, { active: true }); }, panelWin);
await panel.bringToFront(); await sleep(600);
await tile.focus();
await panel.keyboard.press('Enter');
await sleep(1200);
w1 = await winInfo();
check('键盘：聚焦置顶按回车，和点击一样切到它的标签', w1.active === a2 && w1.n === w0.n, JSON.stringify([w1, a2]));

console.log('两个窗口各自独立');
const p2Promise = ctx.waitForEvent('page');
const win2 = await sw.evaluate(async (u) => (await chrome.windows.create({ url: u })).id, `chrome-extension://${extId}/sidepanel.html`);
const panelB = await p2Promise;
await sleep(1500);
const tileB = panelB.locator('#pinned .tile[title^="PinA"]');
check('另一个窗口里 A 是灰的（A2 在第一个窗口）', !(await tileB.getAttribute('class')).includes('open'), await tileB.getAttribute('class'));
await tileB.click();
await sleep(1200);
const inWin2 = await sw.evaluate(async (w) => (await chrome.tabs.query({ windowId: w })).filter((t) => (t.url || t.pendingUrl || '').includes('pinA')).length, win2);
w1 = await winInfo();
check('在另一个窗口点 A：在那个窗口新开，第一个窗口的 A2 不动', inWin2 === 1 && w1.ids.includes(a2), JSON.stringify([inWin2, w1]));
await sw.evaluate((w) => chrome.windows.remove(w), win2);
await sleep(500);

console.log('从旧版本升级');
// 写入 0.9.x 的旧数据（今日 + 一个收藏 + 本机副本），重启浏览器
await sw.evaluate(async () => {
  await chrome.storage.sync.set({
    'n:oldtody1': { k: 'l', ti: '旧今日', p: 'today', o: 0, t: 1, u: 'https://old-today.test/' },
    'n:oldsave1': { k: 'l', ti: '旧收藏', p: 'root', o: 5, t: 1, u: 'https://old-saved.test/' },
    'd:devold01': { oldgone1: [1, 1] },
  });
  await chrome.storage.local.set({ state2: { nodes: {}, pending: {} }, tabBindings: {} });
});
await sleep(300);
await ctx.close();
ctx = await launch();
await route(ctx);
[sw] = ctx.serviceWorkers();
if (!sw) sw = await ctx.waitForEvent('serviceworker');
await sleep(2500);
const afterUp = await sw.evaluate(async () => ({
  sync: Object.keys(await chrome.storage.sync.get(null)),
  local: Object.keys(await chrome.storage.local.get(null)),
}));
list = await bmList();
check('旧的「今日」数据全部删掉', !afterUp.sync.some((k) => k.startsWith('n:') || k.startsWith('d:')) && !afterUp.local.includes('state2'), JSON.stringify(afterUp));
check('旧数据里的收藏搬进书签，旧今日没有进书签', list.includes('https://old-saved.test/') && !list.includes('https://old-today.test/'), JSON.stringify(list));
check('删之前在本机留了备份', afterUp.local.includes('backup.before0100'));
await sw.evaluate(() => chrome.storage.sync.set({ 'n:oldsave2': { k: 'l', ti: '旧版电脑新写的收藏', p: 'root', o: 6, t: 1, u: 'https://old-saved2.test/' }, 'n:oldtody2': { k: 'l', ti: '旧版电脑的今日', p: 'today', o: 0, t: 1, u: 'https://old-today2.test/' } }));
await sleep(3000);
list = await bmList();
const keys2 = await sw.evaluate(async () => Object.keys(await chrome.storage.sync.get(null)).filter((k) => k.startsWith('n:')));
check('旧版电脑运行中写回来的收藏：搬进书签；它的今日先不动', list.includes('https://old-saved2.test/') && JSON.stringify(keys2) === '["n:oldtody2"]', JSON.stringify([list, keys2]));

console.log('模拟卸载重装：插件自己的数据全部清空');
await sw.evaluate(async () => { await chrome.storage.local.clear(); await chrome.storage.sync.clear(); });
await sleep(500);
await ctx.close();
ctx = await launch();
[sw] = ctx.serviceWorkers();
if (!sw) sw = await ctx.waitForEvent('serviceworker');
await sleep(1500);
const panel2 = await ctx.newPage();
await panel2.goto(`chrome-extension://${extId}/sidepanel.html`);
await sleep(1500);
check('置顶还在（两个）', (await panel2.locator('#pinned .tile[title]').count()) === 2, String(await panel2.locator('#pinned .tile[title]').count()));
check('收藏还在（文件夹和网址）', (await panel2.locator('#saved .row').count()) >= 3, String(await panel2.locator('#saved .row').count()));
list = await bmList();
check('没有重复建 Side Pocket 文件夹', list.filter((x) => x === '置顶/').length === 1, JSON.stringify(list));

console.log(`\n通过 ${pass}，失败 ${fail}`);
await ctx.close();
process.exit(fail ? 1 : 0);
