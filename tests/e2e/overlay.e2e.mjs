// 端到端测试：用完整 Chromium 加载真实插件，验证浮动侧栏的展开 / 收起交互和网页缩放。
// 运行：npx playwright install chromium && node tests/e2e/overlay.e2e.mjs
// （会把插件复制到 /tmp/ext；截图写到 OUT 目录）
import { execSync } from 'node:child_process';
execSync('rm -rf /tmp/ext && mkdir -p /tmp/ext && cp -r manifest.json *.js *.html *.css icons /tmp/ext/');
import { chromium } from 'playwright';
const OUT = process.env.OUT || '/tmp/';
const ctx = await chromium.launchPersistentContext('/tmp/prof-' + Date.now(), {
  channel: 'chromium', headless: true, viewport: { width: 1100, height: 700 },
  args: ['--disable-extensions-except=/tmp/ext', '--load-extension=/tmp/ext'],
});
let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent('serviceworker');
await ctx.route('http://site.test/**', (r) => r.fulfill({ contentType: 'text/html', body: `<!doctype html><meta charset=utf-8><style>body{margin:0;font-family:sans-serif}.hero{height:380px;background:linear-gradient(90deg,#FF8A5B,#6C8BFF,#FFD15C)}p{margin:20px}</style><div class=hero></div><p>${'网页正文。'.repeat(60)}</p>` }));
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('pageerror', e.message));
await page.goto('http://site.test/a'); await page.waitForTimeout(1500);
const sleep = (ms) => page.waitForTimeout(ms);
const st = (p = page) => p.evaluate(() => {
  const d = document.getElementById('arc-sidebar-overlay-host-v3')?.shadowRoot.querySelector('.dock');
  return { expanded: !!d?.classList.contains('expanded'), offset: document.documentElement.getAttribute('data-arc-sidebar-offset') };
});
let pass = 0, fail = 0;
const ping = () => sw.evaluate(async () => { const [t] = await chrome.tabs.query({ url: 'http://site.test/a' }); return chrome.tabs.sendMessage(t.id, { type: 'arc-sidebar:ping' }); });
const check = async (name, ok, extra = '') => { ok ? pass++ : fail++; console.log((ok ? '  ✓ ' : '  ✗ ') + name, ok ? '' : extra + ' ' + JSON.stringify(await ping().catch(() => ({})))); };
const away = async () => { await page.mouse.move(420, 420, { steps: 2 }); await sleep(700); };
const setZoom = (z) => sw.evaluate(async (z) => { const [t] = await chrome.tabs.query({ url: 'http://site.test/a' }); await chrome.tabs.setZoom(t.id, z); }, z);

console.log('悬停意图');
await check('初始：收起，网页让出 68px', JSON.stringify(await st()) === JSON.stringify({ expanded: false, offset: 'left-68' }), JSON.stringify(await st()));
await page.mouse.move(420, 300); await page.mouse.move(30, 300, { steps: 2 }); await sleep(90); await page.mouse.move(420, 300, { steps: 2 }); await sleep(500);
await check('快速划过胶囊：不展开', !(await st()).expanded);
await page.mouse.move(30, 300, { steps: 3 }); await sleep(150);
await check('停留 150ms：还没展开', !(await st()).expanded);
await sleep(300);
await check('停留约 450ms：展开（预览）', (await st()).expanded);
await check('预览不推开网页', (await st()).offset === 'left-68');
await page.mouse.move(420, 300, { steps: 2 }); await sleep(150);
await check('离开 150ms：仍展开（缓冲中）', (await st()).expanded);
await page.mouse.move(150, 300, { steps: 2 }); await sleep(600);
await check('离开后很快回来：保持展开', (await st()).expanded);
await page.mouse.move(420, 300, { steps: 2 }); await sleep(700);
await check('离开超过缓冲：收起', !(await st()).expanded);

console.log('保持展开');
await page.mouse.move(30, 300, { steps: 3 }); await sleep(600);
await page.mouse.click(120, 32); await sleep(100); // 点搜索框
await page.keyboard.type('git');
await page.mouse.move(420, 300, { steps: 2 }); await sleep(800);
await check('搜索框在输入时离开：不收起', (await st()).expanded);
await page.mouse.move(150, 300, { steps: 2 }); await sleep(100);
await page.keyboard.press('Escape'); await page.keyboard.press('Escape'); await sleep(100);
await page.mouse.move(420, 300, { steps: 2 }); await sleep(800);
await check('清空并退出搜索后离开：收起', !(await st()).expanded);

console.log('胶囊上的图标');
await page.mouse.move(34, 140, { steps: 2 }); await sleep(60);
const popup = ctx.waitForEvent('page', { timeout: 1500 }).catch(() => null);
await page.mouse.click(34, 140); await sleep(500);
await check('先点图标：不再自动展开', !(await st()).expanded);
await away();

console.log('固定');
await page.mouse.move(34, 34, { steps: 2 }); await sleep(50);
await page.mouse.click(34, 34);
const frames = [];
for (const t of [0, 70, 150, 320]) { await sleep(t - (frames.length ? [0, 70, 150, 320][frames.length - 1] : 0)); await page.screenshot({ path: OUT + `anim-open-${t}.png`, clip: { x: 0, y: 0, width: 360, height: 700 } }); frames.push(t); }
await check('点展开按钮：固定展开并推开网页', JSON.stringify(await st()) === JSON.stringify({ expanded: true, offset: 'left-316' }), JSON.stringify(await st()));
await away(); await sleep(400);
await check('固定后鼠标离开：不收起', (await st()).expanded);
const page2 = await ctx.newPage(); await page2.goto('http://site.test/b'); await sleep(1200);
await check('新开的标签页也是固定展开', (await st(page2)).offset === 'left-316', JSON.stringify(await st(page2)));
await page.bringToFront();
await sw.evaluate(async () => { const [t] = await chrome.tabs.query({ url: 'http://site.test/a' }); await chrome.tabs.sendMessage(t.id, { type: 'arc-sidebar:toggle' }); });
await sleep(100);
await page.screenshot({ path: OUT + 'anim-close-100.png', clip: { x: 0, y: 0, width: 360, height: 700 } });
await sleep(600);
await check('工具栏图标 / 快捷键：收起并取消固定', JSON.stringify(await st()) === JSON.stringify({ expanded: false, offset: 'left-68' }), JSON.stringify(await st()));
await sleep(300);
await check('其他标签页同步取消固定', (await st(page2)).offset === 'left-68', JSON.stringify(await st(page2)));
await page2.close();

console.log('网页缩放');
for (const z of [1.5, 2, 0.67, 1.25, 1]) {
  await setZoom(z); await sleep(800);
  await away();
  await page.mouse.move(30, 300, { steps: 3 }); await sleep(600);
  const hov = (await st()).expanded;
  await away();
  await page.mouse.click(34, 34); await sleep(500);
  const clk = (await st()).expanded;
  await page.mouse.click(276, 32); await sleep(500); // 右上角收起按钮（未缩放坐标）
  await check(`缩放 ${z * 100}%：悬停展开 ${hov ? '✓' : '✗'}  点击展开 ${clk ? '✓' : '✗'}`, hov && clk);
  if ((await st()).expanded) { await sw.evaluate(async () => { const [t] = await chrome.tabs.query({ url: 'http://site.test/a' }); await chrome.tabs.sendMessage(t.id, { type: 'arc-sidebar:toggle' }); }); await sleep(500); }
}
console.log(`\n通过 ${pass}，失败 ${fail}`);
await ctx.close();
