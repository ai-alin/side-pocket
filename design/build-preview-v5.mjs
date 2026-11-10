// 生成 design/preview-v5.html：用真实的 sidepanel.html 结构，套上现在的样式和第五轮的三版候选，并排对比。
// 每一版 = sidepanel-v4.css（第四轮的整理结果）+ v5-common.css（三版共用的三处改动）+ v5-<版>.css。
// 里面的网页、文件夹都是摆出来的假数据。运行：node design/build-preview-v5.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

const SVG = {
  folder: '<svg viewBox="0 0 20 20" fill="none"><path d="M2.75 5.6c0-.97.78-1.75 1.75-1.75h3.05l1.65 1.8h6.3c.97 0 1.75.78 1.75 1.75v7.1c0 .97-.78 1.75-1.75 1.75h-11c-.97 0-1.75-.78-1.75-1.75z" fill="currentColor" fill-opacity=".16" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>',
  caret: '<svg viewBox="0 0 12 12" fill="none"><path d="M4.2 2.5 7.7 6 4.2 9.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  x: '<svg viewBox="0 0 12 12" fill="none"><path d="m3 3 6 6M9 3 3 9" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
  more: '<svg viewBox="0 0 16 16"><circle cx="3.5" cy="8" r="1.3" fill="currentColor"/><circle cx="8" cy="8" r="1.3" fill="currentColor"/><circle cx="12.5" cy="8" r="1.3" fill="currentColor"/></svg>',
  save: '<svg viewBox="0 0 16 16" fill="none"><path d="M4.5 2.5h7a1 1 0 0 1 1 1v10l-4.5-3-4.5 3v-10a1 1 0 0 1 1-1z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>',
  pin: '<svg viewBox="0 0 16 16" fill="none"><path d="M9.6 2.2 13.8 6.4l-1.5.4-2.6 2.6.2 2.8-1.2 1.2-2.4-2.4-3 3M5.1 7.1 4 8.3l1.2 1.2M5.1 7.1l2.6-2.6.4-1.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};

/** 假的网站图标：圆角色块加一个字母 */
const fav = (letter, color) =>
  'data:image/svg+xml,' +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="${color}"/><text x="16" y="22.5" text-anchor="middle" font-family="-apple-system,Segoe UI,sans-serif" font-size="18" font-weight="600" fill="#fff">${letter}</text></svg>`,
  );
const SITES = {
  gh: ['G', '#24292F'], figma: ['F', '#A259FF'], notion: ['N', '#37352F'], mail: ['M', '#EA4335'], cal: ['C', '#1A73E8'],
  lark: ['飞', '#3370FF'], docs: ['D', '#4285F4'], yt: ['Y', '#FF0000'], x: ['X', '#111111'], hn: ['H', '#FF6600'], mdn: ['M', '#1F6FEB'], claude: ['C', '#D97757'],
};
const img = (k, cls = 'fav') => `<img class="${cls}" src="${fav(...SITES[k])}" alt="">`;
const btn = (svg) => `<button type="button">${svg}</button>`;
const actions = (...svgs) => `<span class="actions">${svgs.map(btn).join('')}</span>`;

const tile = (k, title, cls = '') => `<div class="tile ${cls}" title="${title}">${img(k, '')}</div>`;
const link = (k, title, cls = '', extra = '') =>
  `<div class="row link ${cls}">${img(k)}<span class="title">${title}</span>${extra}${actions(...(cls.includes('open') ? [SVG.x] : []), SVG.more)}</div>`;
const folder = (title, color, cnt, kids, collapsed = false) =>
  `<div class="folder-well${collapsed ? ' collapsed' : ''}"><div class="row folder${collapsed ? ' is-collapsed' : ''}"${color ? ` style="--fc:var(--c-${color})"` : ''}>` +
  `<span class="folder-ico">${SVG.folder}</span><span class="title">${title}</span><span class="cnt">${cnt}</span>${actions(SVG.more)}<span class="caret">${SVG.caret}</span></div>` +
  `<div class="folder-children-wrap"><div class="folder-children">${kids}</div></div></div>`;
const tab = (k, title, cls = '', claimed = false) =>
  `<div class="row tab open ${cls}">${img(k)}${claimed ? `<span class="claim-ico">${SVG.pin}</span>` : ''}<span class="title">${title}</span>${actions(SVG.save, SVG.pin, SVG.x)}</div>`;
const remote = (k, title, open = false) =>
  `<div class="row remote">${img(k)}<span class="title">${title}</span>${open ? '<span class="tag">已开着</span>' : ''}${actions(SVG.save, SVG.pin)}</div>`;

const PINNED = tile('mail', 'Gmail', 'open') + tile('cal', '日历') + tile('lark', '飞书', 'open active') + tile('gh', 'GitHub', 'open') + tile('figma', 'Figma') + tile('claude', 'Claude');
const SAVED =
  folder(
    '工作',
    'blue',
    '<span class="o">2</span><span class="n">4</span>',
    link('lark', '周会纪要 · 飞书文档', 'open') +
      link('figma', '侧栏改版 – Figma', 'open') +
      link('docs', '第四季度排期表') +
      folder('参考资料', '', '<span class="n">6</span>', link('mdn', 'x'), true),
  ) +
  folder('稍后读', 'orange', '<span class="n">12</span>', link('hn', 'x'), true) +
  link('notion', '读书笔记 – Notion') +
  link('yt', 'YouTube');
const TABS =
  tab('lark', '飞书 – 消息', 'active', true) +
  tab('gh', 'ai-alin/side-pocket: Chrome 侧边栏', '', true) +
  tab('mdn', 'chrome.sidePanel | API | Chrome for Developers', 'demo-hover') +
  tab('lark', '周会纪要 · 飞书文档', '', true) +
  tab('x', '首页 / X');
const DEVICES =
  `<div class="row device-head"><span class="caret">${SVG.caret}</span><span class="title">公司 MacBook</span><span class="when">3 小时前</span><span class="cnt"><span class="n">3</span></span>${actions(SVG.more)}</div>` +
  remote('gh', 'Pull requests · side-pocket', true) +
  remote('docs', '上架材料清单 – Google 文档') +
  remote('hn', 'Hacker News');

const MENU =
  '<button type="button">切换到该标签</button><button type="button">重命名</button><button type="button">复制链接</button><button type="button">置顶</button><button type="button">新建文件夹</button><button type="button">关闭标签</button><hr><button type="button" class="danger">删除</button>';
const TOAST = '<span class="status-text">已删除文件夹「稍后读」（含 12 项）</span><button type="button" class="status-act">撤销</button>';

const bodyOf = (html) => html.slice(html.indexOf('<body>') + 6, html.indexOf('<script'));

function frame(css, theme, state, key) {
  const dark = theme === 'dark';
  const style = css
    .replaceAll('@media (prefers-color-scheme: dark)', dark ? '@media all' : '@media not all')
    .replace('color-scheme: light dark', `color-scheme: ${theme}`);
  let body = bodyOf(read('sidepanel.html'))
    .replace('<div id="pinned" class="pinned-list"></div>', `<div id="pinned" class="pinned-list">${PINNED}</div>`)
    .replace('<div id="saved" class="tree"></div>', `<div id="saved" class="tree">${SAVED}</div>`)
    .replace('<div id="tabs" class="tree"></div>', `<div id="tabs" class="tree">${TABS}</div>`)
    .replace('<div id="devices" class="tree"></div>', `<div id="devices" class="tree">${DEVICES}</div>`)
    .replace('<span id="tab-count" class="num"></span>', '<span id="tab-count" class="num">5</span>');
  for (const id of ['pinned', 'saved', 'tabs', 'devices']) if (!body.includes(`id="${id}" class`) || body.includes(`id="${id}" class="${id === 'pinned' ? 'pinned-list' : 'tree'}"></div>`)) throw new Error('没填进去：' + id);
  if (state === 'menu') {
    body = body
      .replace('<div id="menu" class="menu" hidden></div>', `<div id="menu" class="menu" style="left:118px;top:298px">${MENU}</div>`)
      .replace('<div id="status" class="status" hidden></div>', `<div id="status" class="status">${TOAST}</div>`)
      .replace('<div class="row link open"><img', '<div class="row link open menu-open"><img');
  }
  if (state === 'settings') {
    body = body
      .replace('<div id="settings-pop" class="settings-pop" hidden>', '<div id="settings-pop" class="settings-pop">')
      .replace('id="device-name" class="settings-input" type="text"', 'id="device-name" class="settings-input" type="text" value="家里 iMac"')
      .replace('<kbd id="shortcut-key" class="shortcut-key"></kbd>', '<kbd id="shortcut-key" class="shortcut-key">⇧⌘Y</kbd>');
  }
  // 预览里没有鼠标：给一行摆出「鼠标停在上面」的样子
  const demo = '.demo-hover{background:var(--hover)}.demo-hover .actions{display:flex}';
  const doc = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>${style}${demo}</style></head><body>${body}</body></html>`;
  return `<iframe data-v="${key}" title="${key} ${theme} ${state}" srcdoc="${doc.replaceAll('&', '&amp;').replaceAll('"', '&quot;')}"></iframe>`;
}

const base = read('design/sidepanel-v4.css') + read('design/v5-common.css');
const VARIANTS = [
  { key: 'now', name: '现在', css: read('sidepanel.css') },
  { key: 'a', name: 'A · Chrome 原生', css: base + read('design/v5-a.css') },
  { key: 'b', name: 'B · 安静灰', css: base + read('design/v5-b.css') },
  { key: 'c', name: 'C · 有主题色', css: base + read('design/v5-c.css') },
];
const row = (title, theme, state) =>
  `<section><h2>${title}</h2><div class="pair">` +
  VARIANTS.map((v) => `<figure><figcaption>${v.name}</figcaption>${frame(v.css, theme, state, v.key)}</figure>`).join('') +
  `</div></section>`;
const HUES = [[268, '紫'], [245, '蓝'], [195, '青'], [150, '绿'], [75, '琥珀'], [20, '玫红']];

const page = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Side Pocket 外观第五轮：三版对比</title>
<style>
  body { margin: 0; padding: 32px 28px 64px; background: #D5D7DB; color: #1F1F1F; font: 14px/1.6 system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; }
  main { width: 1432px; margin: 0 auto; }
  h1 { margin: 0 0 6px; font-size: 20px; font-weight: 600; }
  p, li { color: #3A3D42; }
  p { margin: 0 0 8px; max-width: 900px; }
  ul { margin: 0 0 8px; padding-left: 20px; max-width: 900px; }
  h2 { margin: 40px 0 12px; font-size: 15px; font-weight: 600; }
  .pair { display: flex; gap: 24px; }
  figure { margin: 0; }
  figcaption { margin-bottom: 6px; font-size: 13px; font-weight: 600; }
  iframe { display: block; width: 340px; height: 900px; border: 1px solid rgba(0, 0, 0, 0.18); border-radius: 4px; background: #fff; }
  .hues { display: flex; align-items: center; gap: 8px; margin-top: 14px; font-size: 13px; }
  .hues button { width: 24px; height: 24px; padding: 0; border: 2px solid #D5D7DB; border-radius: 50%; cursor: pointer; }
  .hues button[aria-pressed="true"] { box-shadow: 0 0 0 2px #1F1F1F; }
</style>
</head>
<body>
<main>
  <h1>Side Pocket 外观第五轮：三版对比</h1>
  <p>最左边是现在的样子。三版用的是同一份侧栏页面结构，只换样式文件；网页和文件夹是假数据。每个面板都是活的：可以把鼠标移上去看悬停效果，也可以滚动。「这个窗口」第三行固定摆成了鼠标停在上面的样子。</p>
  <ul>
    <li><b>三版共同的改动</b>：字重 2 种、字号 3 种、去掉装饰阴影；开着的收藏字更重、没开的更淡；文件夹层级线鼠标移进收藏区才出现；悬停时操作按钮盖在行尾，不挤动标题。</li>
    <li><b>A · Chrome 原生</b>：白底、Chrome 蓝，当前标签是淡蓝底。像浏览器自带的。</li>
    <li><b>B · 安静灰</b>：暖灰底，几乎不用彩色，当前标签是中性灰底，行更紧凑（30px），置顶格子只有细描边。</li>
    <li><b>C · 有主题色</b>：整个面板带一点色调，当前标签是白卡片，置顶格子下面带标题。所有颜色由一个色相算出来。</li>
  </ul>
  <div class="hues">C 版主题色：${HUES.map(([h, n], i) => `<button type="button" data-h="${h}" title="${n}" aria-label="${n}" aria-pressed="${i === 0}" style="background:oklch(62% 0.16 ${h})"></button>`).join('')}</div>
  ${row('浅色', 'light', 'main')}
  ${row('深色', 'dark', 'main')}
  ${row('右键菜单和「撤销」提示（浅色）', 'light', 'menu')}
  ${row('设置（深色）', 'dark', 'settings')}
</main>
<script>
  document.querySelector('.hues').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    document.querySelectorAll('.hues button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    document.querySelectorAll('iframe[data-v="c"]').forEach((f) => f.contentDocument.documentElement.style.setProperty('--h', b.dataset.h));
  });
</script>
</body>
</html>
`;
writeFileSync(join(root, 'design/preview-v5.html'), page);
console.log('已生成 design/preview-v5.html');
