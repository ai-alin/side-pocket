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
execSync(`rm -rf ${EXT} && mkdir -p ${EXT} && cp -r manifest.json *.js *.html *.css icons ${EXT}/`);
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
check('快捷键已注册（默认 Command+B / Ctrl+B）', /B$/.test(shortcut), JSON.stringify(shortcut));
const behavior = await sw.evaluate(() => chrome.sidePanel.getPanelBehavior());
check('点工具栏图标 / 按快捷键：打开或关闭侧边栏', behavior.openPanelOnActionClick === true, JSON.stringify(behavior));
const manifest = await sw.evaluate(() => chrome.runtime.getManifest());
check('名字是 Side Pocket', manifest.name === 'Side Pocket' && manifest.action.default_title === '打开或关闭 Side Pocket', manifest.name);
check('不申请「读取和修改所有网站」，不往网页里注入', !manifest.host_permissions && !manifest.content_scripts && !manifest.permissions.includes('scripting'));

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
