// 端到端测试：用完整 Chromium 加载真实插件，检查放在 Chrome 侧边栏里的侧栏。
// 运行：npx playwright install chromium && node tests/e2e/sidepanel.e2e.mjs
// （会把插件复制到 /tmp/ext-sidepanel）
//
// 测试工具看不到 Chrome 侧边栏里的页面，所以界面部分在一个普通标签页里打开 sidepanel.html 来测；
// 侧边栏本身只检查「Chrome 确实把我们的页面放进了侧边栏」。
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
await ctx.route('http://site.test/**', (r) =>
  r.fulfill({ contentType: 'text/html', body: `<!doctype html><meta charset=utf-8><title>${new URL(r.request().url()).pathname.slice(1)}</title><p>正文</p>` }),
);

let pass = 0, fail = 0;
const check = (name, ok, extra = '') => { ok ? pass++ : fail++; console.log((ok ? '  ✓ ' : '  ✗ ') + name, ok ? '' : extra); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log('安装后');
const shortcut = await sw.evaluate(async () => (await chrome.commands.getAll()).find((c) => c.name === '_execute_action')?.shortcut || '');
check('快捷键已注册（默认 Command+B / Ctrl+B）', /B$/.test(shortcut), JSON.stringify(shortcut));
const behavior = await sw.evaluate(() => chrome.sidePanel.getPanelBehavior());
check('点工具栏图标 / 按快捷键：打开或关闭侧边栏', behavior.openPanelOnActionClick === true, JSON.stringify(behavior));
const manifest = await sw.evaluate(() => chrome.runtime.getManifest());
check('名字是 Side Pocket', manifest.name === 'Side Pocket' && manifest.action.default_title === '打开或关闭 Side Pocket', manifest.name);
check('不再申请「读取和修改所有网站」，不往网页里注入', !manifest.host_permissions && !manifest.content_scripts && !manifest.permissions.includes('scripting'));

const site = await ctx.newPage();
await site.goto('http://site.test/a');
await sleep(1200);
check('网页里没有被塞进任何东西', (await site.evaluate(() => document.querySelectorAll('[id^="arc-sidebar"]').length)) === 0); // 旧版浮动侧栏的元素 id

console.log('侧栏界面');
const panel = await ctx.newPage();
panel.on('pageerror', (e) => console.log('pageerror', e.message));
await panel.goto(`chrome-extension://${extId}/sidepanel.html`);
await sleep(1200);
check('侧栏页面标题是 Side Pocket', (await panel.title()) === 'Side Pocket', await panel.title());
const today = await panel.locator('#tabs .row.tab').evaluateAll((rows) => rows.map((r) => r.title));
check('「今日」里有打开的网页', today.includes('http://site.test/a'), JSON.stringify(today));
check('「新建标签页」在今日列表上面', await panel.evaluate(() => !!(document.querySelector('#new-tab').compareDocumentPosition(document.querySelector('#tabs')) & Node.DOCUMENT_POSITION_FOLLOWING)));
await sw.evaluate(() => chrome.tabs.create({ url: 'http://site.test/b', active: false }));
await sleep(1500);
const today2 = await panel.locator('#tabs .row.tab').evaluateAll((rows) => rows.map((r) => r.title));
check('新打开的网页排在今日最上面', today2[0] === 'http://site.test/b' && today2.includes('http://site.test/a'), JSON.stringify(today2));
const webTabs = () => sw.evaluate(async () => (await chrome.tabs.query({})).filter((t) => /^https?:/.test(t.url || t.pendingUrl || '')).length);
const mineCount = () => panel.locator('#tabs .row.tab').count();
check('「这台电脑」的条数和 Chrome 的网页标签数一致', (await mineCount()) === (await webTabs()), `${await mineCount()} vs ${await webTabs()}`);
// 在同一个标签里跳来跳去：只更新这一条，不会变多
for (const u of ['http://site.test/a1', 'http://site.test/a2', 'http://site.test/a3']) {
  await site.goto(u);
  await sleep(700);
}
await sleep(800);
const afterNav = await panel.locator('#tabs .row.tab').evaluateAll((rows) => rows.map((r) => r.title));
check('同一个标签里跳转三次，条数不变、只是网址更新', afterNav.length === today2.length && afterNav.includes('http://site.test/a3') && !afterNav.includes('http://site.test/a'), JSON.stringify(afterNav));
check('没有「其他电脑 / 没开着的」残留', await panel.locator('#others-wrap').isHidden());
await site.goto('http://site.test/a'); await sleep(1200);
await panel.screenshot({ path: (process.env.OUT || '/tmp/') + 'sidepanel-today.png' });
await panel.locator('#open-settings').click();
await sleep(300);
check('设置里显示当前快捷键', (await panel.locator('#shortcut-key').textContent()) === shortcut, await panel.locator('#shortcut-key').textContent());
check('快捷键正常时不显示「被占用」提示', await panel.locator('#shortcut-hint').isHidden());
const opened = ctx.waitForEvent('page', { timeout: 3000 }).catch(() => null);
await panel.locator('#edit-shortcut').click();
const sp = await opened;
check('「修改快捷键」打开 Chrome 的快捷键设置页', sp?.url() === 'chrome://extensions/shortcuts', sp?.url());
check('点完按钮设置面板收起', await panel.locator('#settings-pop').isHidden());
await sp?.close();

console.log('Chrome 侧边栏');
// sidePanel.open 必须由用户点击触发：在侧栏页面里临时放一个按钮，点它打开
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
await sleep(200);
await panel.locator('#test-open').click();
await sleep(1000);
const contexts = await sw.evaluate(async () => (await chrome.runtime.getContexts({ contextTypes: ['SIDE_PANEL'] })).map((c) => c.documentUrl));
check('侧边栏里加载的是我们的侧栏', contexts.length === 1 && contexts[0].endsWith('/sidepanel.html'), JSON.stringify(contexts));
await sw.evaluate(async () => { const w = await chrome.windows.getLastFocused(); await chrome.sidePanel.close({ windowId: w.id }); });
await sleep(500);
check('关闭侧边栏', (await sw.evaluate(async () => (await chrome.runtime.getContexts({ contextTypes: ['SIDE_PANEL'] })).length)) === 0);

console.log('收藏和置顶存在 Chrome 书签里');
const bmList = () => sw.evaluate(async () => {
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
let list = await bmList();
check('其他书签里建好了 Side Pocket / 置顶', Array.isArray(list) && list.includes('置顶/'), JSON.stringify(list));
const sendOp = (op, args) => panel.evaluate(([op, args]) => chrome.runtime.sendMessage({ type: 'side-pocket:op', op, args }), [op, args]);
const todayId = await panel.evaluate(async () => {
  const { state2 } = await chrome.storage.local.get('state2');
  return Object.values(state2.nodes).find((n) => n.url === 'http://site.test/a')?.id;
});
await sendOp('move', { id: todayId, parent: 'root' });
await sleep(800);
list = await bmList();
check('今日 → 收藏：变成书签', list.includes('http://site.test/a'), JSON.stringify(list));
await panel.reload(); await sleep(1000);
check('收藏里显示出来，今日里没有了', (await panel.locator('#saved .row.link[title="http://site.test/a"]').count()) === 1 && (await panel.locator('#tabs .row.tab[title="http://site.test/a"]').count()) === 0);
const bkmId = await panel.locator('#saved .row.link[title="http://site.test/a"]').getAttribute('data-id');
await sendOp('pin', { id: bkmId });
await sleep(800);
list = await bmList();
check('置顶：书签挪进「置顶」文件夹', list.includes('置顶/http://site.test/a'), JSON.stringify(list));
const fid = (await sendOp('addFolder', { id: 'tmpfold1', title: '工作' }))?.result;
await sendOp('setColor', { id: fid, color: 'green' });
await sleep(800);
list = await bmList();
const colors = await sw.evaluate(async () => (await chrome.storage.sync.get('ui.folderColors'))['ui.folderColors']);
check('新建文件夹：建在书签里，颜色另外记下', list.includes('工作/') && colors?.['工作'] === 'green', JSON.stringify([list, colors]));

console.log('旧版设备写回来的收藏');
await sw.evaluate(() => chrome.storage.sync.set({ 'n:legacy01': { k: 'l', ti: 'Legacy', p: 'root', o: 0, t: Date.now(), u: 'https://legacy.test/' } }));
await sleep(6000);
list = await bmList();
const leftover = await sw.evaluate(async () => Object.keys(await chrome.storage.sync.get(null)).filter((k) => k === 'n:legacy01'));
check('搬进书签，并从插件的同步存储里删掉', list.includes('https://legacy.test/') && leftover.length === 0, JSON.stringify([list, leftover]));
const backup = await sw.evaluate(async () => !!(await chrome.storage.local.get('backup.beforeBookmarks'))['backup.beforeBookmarks']);
check('搬之前在本机留了备份', backup);

console.log('模拟卸载重装：插件自己的数据全部清空');
// 清掉插件自己的本机和同步存储，书签留着；关掉浏览器再用同一个配置启动
await sw.evaluate(async () => { await chrome.storage.local.clear(); await chrome.storage.sync.clear(); });
await sleep(500);
await ctx.close();
ctx = await launch();
[sw] = ctx.serviceWorkers();
if (!sw) sw = await ctx.waitForEvent('serviceworker');
const wiped = await sw.evaluate(async () => Object.keys(await chrome.storage.local.get(null)).filter((k) => k !== 'deviceId' && k !== 'state2'));
check('重启后插件存储确实是空的（没有旧收藏、没有备份）', !wiped.includes('backup.beforeBookmarks'), JSON.stringify(wiped));
await sleep(1500);
const panel2 = await ctx.newPage();
await panel2.goto(`chrome-extension://${extId}/sidepanel.html`);
await sleep(1500);
check('置顶还在', (await panel2.locator('#pinned .tile[title]').count()) === 1);
check('收藏还在（文件夹和网址）', (await panel2.locator('#saved .row').count()) >= 2, String(await panel2.locator('#saved .row').count()));
list = await bmList();
check('没有重复建 Side Pocket 文件夹', list.filter((x) => x === '置顶/').length === 1, JSON.stringify(list));

console.log(`\n通过 ${pass}，失败 ${fail}`);
await ctx.close();
process.exit(fail ? 1 : 0);
