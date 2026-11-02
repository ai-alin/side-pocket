// 侧栏界面：只负责显示和把用户操作发给后台。
// 数据由 background.js 维护在 storage.local；后台改完数据会更新 storage.session 里的 VIEW_KEY，
// 这里收到通知后重新读取。侧栏放在 Chrome 侧边栏里，每个窗口一个。

import * as M from './model.js';
import { LOCAL_KEY, VIEW_KEY } from './store.js';
import * as B from './bookmarks.js';

const $ = (sel) => document.querySelector(sel);
const SELF_PREFIX = chrome.runtime.getURL('');

let state = M.emptyState();
let v = M.view(state);
let tabs = []; // 所有窗口的普通标签
let winId = null; // 侧栏所在窗口
let activeUrl = ''; // 「当前标签」的网址，用来高亮
let renaming = null; // 正在重命名的节点 id
let drag = null; // { id }
let inflight = 0; // 已在本地生效、后台还没确认的操作数
let stale = false;
let rendering = false;
let syncStatus = 'saved';
let query = ''; // 搜索词
let selected = 0; // 搜索结果里键盘选中的下标
let results = []; // 当前搜索结果（节点）

/* ---------- 工具 ---------- */

function favicon(url, size = 32) {
  const u = new URL(chrome.runtime.getURL('/_favicon/'));
  u.searchParams.set('pageUrl', url);
  u.searchParams.set('size', String(size));
  return u.toString();
}

const SVG = {
  folder: '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M2.75 5.6c0-.97.78-1.75 1.75-1.75h3.05l1.65 1.8h6.3c.97 0 1.75.78 1.75 1.75v7.1c0 .97-.78 1.75-1.75 1.75h-11c-.97 0-1.75-.78-1.75-1.75z" fill="currentColor" fill-opacity=".16" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>',
  caret: '<svg viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="M4.2 2.5 7.7 6 4.2 9.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  x: '<svg viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="m3 3 6 6M9 3 3 9" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
  more: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="3.5" cy="8" r="1.3" fill="currentColor"/><circle cx="8" cy="8" r="1.3" fill="currentColor"/><circle cx="12.5" cy="8" r="1.3" fill="currentColor"/></svg>',
  save: '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4.5 2.5h7a1 1 0 0 1 1 1v10l-4.5-3-4.5 3v-10a1 1 0 0 1 1-1z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>',
  pin: '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M9.6 2.2 13.8 6.4l-1.5.4-2.6 2.6.2 2.8-1.2 1.2-2.4-2.4-3 3M5.1 7.1 4 8.3l1.2 1.2M5.1 7.1l2.6-2.6.4-1.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};

function svgIcon(svg, className) {
  const s = el('span', { class: className, 'aria-hidden': 'true' });
  s.innerHTML = svg; // 常量 SVG，不含用户数据
  return s;
}

function actBtn(act, title, svg) {
  const b = el('button', { type: 'button', 'data-act': act, title, 'aria-label': title });
  b.innerHTML = svg; // 常量 SVG
  return b;
}

const COLOR_NAMES = { grey: '灰', blue: '蓝', red: '红', yellow: '黄', green: '绿', pink: '粉', purple: '紫', cyan: '青', orange: '橙' };

function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, val] of Object.entries(attrs)) {
    if (val == null || val === false) continue;
    if (k === 'class') e.className = val;
    else if (k === 'style' || k.startsWith('data-') || k.startsWith('aria-') || ['title', 'draggable', 'src', 'type', 'role', 'tabindex', 'alt'].includes(k)) e.setAttribute(k, val);
    else e[k] = val;
  }
  for (const c of children) if (c != null) e.append(c);
  return e;
}

function displayTitle(n) {
  if (n.title) return n.title;
  try {
    return new URL(n.url).hostname;
  } catch {
    return n.url;
  }
}

const isSelf = (t) => (t.url || t.pendingUrl || '').startsWith(SELF_PREFIX);

/** 找到该网址已打开的标签：优先当前窗口 */
function findTab(url) {
  const u = M.normUrl(url);
  const hits = tabs.filter((t) => M.normUrl(t.url || t.pendingUrl) === u);
  return hits.find((t) => t.windowId === winId) || hits[0] || null;
}

/**
 * 贴边栏里，「当前标签」就是侧栏所在的这个标签页：看得见这个侧栏时它一定是当前标签，
 * 不用等标签列表刷新，切过来的第一帧高亮就是对的。其他模式用所在窗口的活动标签。
 */
function updateActiveUrl() {
  const t = tabs.find((x) => x.active && x.windowId === winId);
  activeUrl = t ? M.normUrl(t.url || t.pendingUrl) : '';
}

const openCls = (t, url) => (t ? ' open' : '') + (activeUrl && M.normUrl(url) === activeUrl ? ' active' : '');

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = el('textarea', { value: text });
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  showStatus('已复制链接', 'info', 1500);
}

let statusTimer;
function showStatus(text, kind = 'info', ms = 0) {
  const s = $('#status');
  clearTimeout(statusTimer);
  s.textContent = text;
  s.className = 'status' + (kind === 'warn' ? ' warn' : '');
  s.hidden = false;
  if (ms) statusTimer = setTimeout(() => (s.hidden = true), ms);
}

const SYNC_MSG = {
  quota: '同步空间已满（Chrome 限制约 100KB），部分更改只保存在本机。删掉一些条目后会自动重试。',
  rate: '写入太频繁，被 Chrome 限流，稍后自动重试同步。',
  toolarge: '有条目的网址太长（超过 Chrome 单项 8KB 限制），它只保存在本机。',
  error: '同步失败，更改已保存在本机，稍后自动重试。',
};

function showSync(st) {
  if (!st) return;
  const badge = $('#sync-state');
  badge.textContent = SYNC_MSG[st] ? '未同步' : '已同步';
  badge.classList.toggle('warn', !!SYNC_MSG[st]);
  badge.title = SYNC_MSG[st] || '今日已同步到你的 Google 账号；置顶和收藏存在 Chrome 书签里，由 Chrome 同步';
  if (st === syncStatus) return;
  syncStatus = st;
  if (SYNC_MSG[st]) showStatus(SYNC_MSG[st], 'warn', 8000);
  else if ($('#status').classList.contains('warn')) $('#status').hidden = true;
}

/* ---------- 数据 ---------- */

/** 今日来自后台维护的 storage.local；收藏和置顶直接读 Chrome 书签（只读，不建文件夹，建由后台负责） */
async function loadState() {
  const [d, sync, ids] = await Promise.all([
    chrome.storage.local.get([LOCAL_KEY, B.COLLAPSE_KEY]),
    chrome.storage.sync.get(B.COLOR_KEY),
    B.resolveRoot(chrome.bookmarks).catch(() => null),
  ]);
  const saved = await B.loadNodes(chrome.bookmarks, ids, { colors: sync[B.COLOR_KEY], collapsed: d[B.COLLAPSE_KEY] }).catch((e) => {
    console.warn('[side-pocket] 读取书签失败', e);
    return {};
  });
  state = { nodes: { ...(d[LOCAL_KEY]?.nodes || {}), ...saved } };
  if (renaming && !state.nodes[renaming]) renaming = null;
}

async function resolveWindowId() {
  try {
    const cur = await chrome.windows.getCurrent();
    if (cur?.type === 'normal') return cur.id;
    const last = await chrome.windows.getLastFocused({ windowTypes: ['normal'] });
    if (last?.id != null) return last.id;
  } catch (e) {
    console.warn('[side-pocket] 取窗口失败', e);
  }
  return tabs[0]?.windowId ?? null;
}

/** force：侧栏暂时看不见时也刷新（第一次加载） */
async function refresh({ force = false } = {}) {
  if (inflight || (document.hidden && !force)) {
    stale = true;
    return;
  }
  stale = false;
  const [all, , wid] = await Promise.all([chrome.tabs.query({}), loadState(), winId ?? resolveWindowId()]);
  tabs = all.filter((t) => !isSelf(t));
  winId = wid;
  updateActiveUrl();
  render();
}

let refreshTimer;
function refreshSoon(ms = 80) {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refresh, ms);
}

/** 先在本地副本上执行（立即显示），再交给后台执行（权威结果）；返回后台的执行结果 */
async function op(name, args = {}) {
  try {
    M.applyOp(state, name, args);
    M.takeChanges(state);
  } catch (e) {
    console.warn('[side-pocket]', e);
    return null;
  }
  render();
  inflight++;
  try {
    const r = await chrome.runtime.sendMessage({ type: 'side-pocket:op', op: name, args });
    if (!r?.ok) showStatus('操作失败：' + (r?.error || '未知错误'), 'warn', 4000);
    return r?.ok ? r.result : null;
  } catch (e) {
    showStatus('操作失败：' + (e?.message || e), 'warn', 4000);
    return null;
  } finally {
    inflight--;
    if (!inflight) refresh();
  }
}

async function openNode(n) {
  const t = findTab(n.url);
  if (t) {
    await chrome.tabs.update(t.id, { active: true });
    if (t.windowId !== winId) await chrome.windows.update(t.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url: n.url, windowId: winId ?? undefined });
  }
}

/** 新建文件夹并进入重命名。文件夹建在书签里，真正的 id 由后台返回，先用临时 id 显示 */
async function newFolder(parent = M.ROOT, index) {
  const tmp = M.newId();
  if (parent !== M.ROOT && state.nodes[parent]?.collapsed) op('setCollapsed', { id: parent, collapsed: false });
  renaming = tmp;
  const id = await op('addFolder', { id: tmp, parent, index });
  if (renaming === tmp) {
    renaming = typeof id === 'string' ? id : null;
    render();
  }
}

function startRename(id) {
  renaming = id;
  render();
}

/* ---------- 渲染 ---------- */

function render() {
  v = M.view(state);
  const old = document.querySelector('input.rename');
  const draft =
    old && old.dataset.id === renaming
      ? { value: old.value, start: old.selectionStart, end: old.selectionEnd }
      : null;
  rendering = true;
  try {
    const searching = !!query;
    $('#browse').hidden = searching;
    $('#results-section').hidden = !searching;
    if (searching) renderResults();
    else {
      renderPinned();
      renderSaved();
      renderTabs();
    }
  } finally {
    rendering = false;
  }
  const input = document.querySelector('input.rename');
  if (!input) return;
  if (draft) {
    // 重命名途中数据刷新了：保留已输入的内容和光标
    input.value = draft.value;
    input.focus();
    input.setSelectionRange(draft.start, draft.end);
  } else if (document.activeElement !== input) {
    input.focus();
    input.select();
  }
}

/* ---------- 增量更新 DOM ---------- */
// 每次渲染先生成新节点，再和页面上已有的对比，只改有变化的地方：
// 同一个条目（data-id / data-folder）复用原来的元素，网站图标不会重新加载，
// 鼠标下面的那一行也不会因为被换掉而闪一下悬停效果；拖拽中的元素也不会被换掉。

function keyOf(n) {
  if (n.nodeType !== 1) return null;
  const id = n.getAttribute('data-id') ?? n.getAttribute('data-folder');
  return id == null ? null : n.nodeName + '#' + id;
}

/** 输入框（重命名）不复用：它带着自己的事件和草稿，render() 会另外恢复内容和光标 */
const canPatch = (o, n) => o.nodeType === n.nodeType && o.nodeName === n.nodeName && o.nodeName !== 'INPUT';

function patchNode(o, n) {
  if (o.nodeType !== 1) {
    if (o.data !== n.data) o.data = n.data;
    return o;
  }
  for (const a of [...o.attributes]) if (!n.hasAttribute(a.name)) o.removeAttribute(a.name);
  for (const a of n.attributes) if (o.getAttribute(a.name) !== a.value) o.setAttribute(a.name, a.value);
  patchChildren(o, [...n.childNodes]);
  return o;
}

/** 把 parent 的子节点更新成 next：有 key 的按 key 对应，没 key 的按出现顺序对应 */
function patchChildren(parent, next) {
  const keyed = new Map();
  const loose = [];
  for (const o of parent.childNodes) {
    const k = keyOf(o);
    if (k) keyed.set(k, o);
    else loose.push(o);
  }
  let li = 0;
  const out = next.map((n) => {
    const k = keyOf(n);
    let o = null;
    if (k) {
      o = keyed.get(k) || null;
      keyed.delete(k);
    } else if (li < loose.length) {
      o = loose[li++];
    }
    return o && canPatch(o, n) ? patchNode(o, n) : n;
  });
  out.forEach((node, i) => {
    if (parent.childNodes[i] !== node) parent.insertBefore(node, parent.childNodes[i] || null);
  });
  while (parent.childNodes.length > out.length) parent.lastChild.remove();
}

const favImg = (url, cls, size) => el('img', { class: cls, src: favicon(url, size), alt: '', draggable: 'false' });

function renderPinned() {
  patchChildren(
    $('#pinned'),
    v.order[M.PINNED].map((id) => {
      const n = state.nodes[id];
      return el(
        'div',
        { class: 'tile' + openCls(findTab(n.url), n.url), title: displayTitle(n), draggable: 'true', 'data-id': id, role: 'button', tabindex: '0' },
        favImg(n.url, '', 64),
      );
    }),
  );
}

/** 文件夹里（含子文件夹）一共几个网站、其中几个开着 */
function folderStats(id) {
  let total = 0;
  let open = 0;
  for (const c of v.order[id] || []) {
    const n = state.nodes[c];
    if (n.type === 'folder') {
      const s = folderStats(c);
      total += s.total;
      open += s.open;
    } else {
      total++;
      if (findTab(n.url)) open++;
    }
  }
  return { total, open };
}

function renderSaved() {
  const walk = (parent) =>
    v.order[parent].map((id) => {
      const n = state.nodes[id];
      if (n.type !== 'folder') return linkRow(n);
      // 始终渲染子容器，靠 .collapsed + grid 过渡做展开/折叠动画；子项的树形连线由 CSS 画
      const kids = walk(id);
      if (!kids.length) kids.push(el('div', { class: 'empty' }, '空文件夹，把网站拖进来'));
      return el(
        'div',
        { class: 'folder-well' + (n.collapsed ? ' collapsed' : ''), 'data-folder': n.id },
        folderRow(n),
        el('div', { class: 'folder-children-wrap' }, el('div', { class: 'folder-children' }, ...kids)),
      );
    });
  const rows = walk(M.ROOT);
  if (!rows.length) rows.push(el('div', { class: 'empty' }, '还没有收藏。把「今日」里的网站拖到这里。'));
  patchChildren($('#saved'), rows);
}

function titleNode(n) {
  if (renaming !== n.id) return el('span', { class: 'title' }, displayTitle(n));
  const input = el('input', { class: 'rename', value: n.title || '', 'data-id': n.id });
  let done = false;
  const finish = (ok) => {
    if (done || rendering) return;
    done = true;
    renaming = null;
    const t = input.value.trim();
    if (ok && t && t !== n.title) op('rename', { id: n.id, title: t });
    else render();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') finish(true);
    if (e.key === 'Escape') finish(false);
    e.stopPropagation();
  });
  input.addEventListener('blur', () => finish(true));
  input.addEventListener('click', (e) => e.stopPropagation());
  return input;
}

function linkRow(n) {
  const t = findTab(n.url);
  return el(
    'div',
    { class: 'row link' + openCls(t, n.url), draggable: 'true', 'data-id': n.id, title: n.url },
    favImg(n.url, 'fav'),
    titleNode(n),
    el(
      'span',
      { class: 'actions' },
      t ? actBtn('close-tab', '关闭标签（保留在收藏里）', SVG.x) : null,
      actBtn('menu', '更多', SVG.more),
    ),
  );
}

function folderRow(n) {
  const { total, open } = folderStats(n.id);
  return el(
    'div',
    {
      class: 'row folder' + (n.collapsed ? ' is-collapsed' : ''),
      style: n.color ? `--fc:var(--c-${n.color})` : null,
      draggable: 'true',
      'data-id': n.id,
    },
    svgIcon(SVG.folder, 'folder-ico'),
    titleNode(n),
    el(
      'span',
      { class: 'cnt', title: open ? `${total} 个网站，${open} 个开着` : `${total} 个网站` },
      open ? el('span', { class: 'o' }, String(open)) : null,
      el('span', { class: 'n' }, String(total)),
    ),
    el('span', { class: 'actions' }, actBtn('menu', '更多', SVG.more)),
    svgIcon(SVG.caret, 'caret'),
  );
}

function renderTabs() {
  const ids = v.order[M.TODAY];
  $('#tab-count').textContent = ids.length ? String(ids.length) : '';
  $('#clear-today').hidden = !ids.some((id) => !findTab(state.nodes[id].url));
  const rows = ids.map((id) => {
    const n = state.nodes[id];
    return el(
      'div',
      { class: 'row tab' + openCls(findTab(n.url), n.url), draggable: 'true', 'data-id': n.id, title: n.url },
      favImg(n.url, 'fav'),
      titleNode(n),
      el(
        'span',
        { class: 'actions' },
        actBtn('save', '保存到收藏', SVG.save),
        actBtn('pin', '置顶', SVG.pin),
        actBtn('close', '关闭（所有设备）', SVG.x),
      ),
    );
  });
  if (!rows.length) rows.push(el('div', { class: 'empty' }, '打开的网页会出现在这里，并同步到你的其他设备'));
  patchChildren($('#tabs'), rows);
}

/* ---------- 搜索 ---------- */

/** 节点所在位置，显示在搜索结果右侧 */
function whereOf(id) {
  const names = [];
  let p = v.parent[id];
  while (state.nodes[p]?.type === 'folder') {
    names.unshift(state.nodes[p].title);
    p = v.parent[p];
  }
  if (p === M.PINNED) return '置顶';
  if (p === M.TODAY) return '今日';
  return names.length ? names.join(' / ') : '收藏';
}

function renderResults() {
  const q = query.toLowerCase();
  results = Object.values(state.nodes)
    .filter((n) => n.type === 'link' && (n.title.toLowerCase().includes(q) || n.url.toLowerCase().includes(q)))
    .sort((a, b) => {
      // 标题命中优先，其次开着的优先
      const at = a.title.toLowerCase().includes(q) ? 0 : 1;
      const bt = b.title.toLowerCase().includes(q) ? 0 : 1;
      return at - bt || (findTab(a.url) ? 0 : 1) - (findTab(b.url) ? 0 : 1);
    })
    .slice(0, 50);
  selected = Math.min(selected, Math.max(results.length - 1, 0));
  $('#result-count').textContent = results.length ? String(results.length) : '';
  const rows = results.map((n, i) =>
    el(
      'div',
      { class: 'row link' + openCls(findTab(n.url), n.url) + (i === selected ? ' selected' : ''), 'data-id': n.id, title: n.url },
      favImg(n.url, 'fav'),
      el('span', { class: 'title' }, displayTitle(n)),
      el('span', { class: 'where' }, whereOf(n.id)),
    ),
  );
  if (!rows.length) rows.push(el('div', { class: 'empty' }, `没有找到「${query}」。试试网址里的关键词。`));
  patchChildren($('#results'), rows);
}

function setQuery(q) {
  query = q.trim();
  selected = 0;
  $('#scroll').scrollTop = 0;
  render();
}

/* ---------- 菜单 ---------- */

function showMenu(x, y, entries, row) {
  const m = $('#menu');
  m.replaceChildren(
    ...entries.map((e) => {
      if (e === '-') return el('hr');
      if (e.heading) return el('div', { class: 'menu-label' }, e.heading);
      if (e.colors) return colorPicker(e.colors);
      return el('button', { type: 'button', class: e.danger ? 'danger' : '', onclick: () => { hideMenu(); e.run(); } }, e.label);
    }),
  );
  m.hidden = false;
  document.querySelectorAll('.menu-open').forEach((r) => r.classList.remove('menu-open'));
  row?.classList.add('menu-open');
  const r = m.getBoundingClientRect();
  m.style.left = Math.max(4, Math.min(x, innerWidth - r.width - 4)) + 'px';
  m.style.top = Math.max(4, Math.min(y, innerHeight - r.height - 4)) + 'px';
}

/** 文件夹颜色选择：Chrome 标签组的 9 色 + 「无颜色」 */
function colorPicker(id) {
  const cur = state.nodes[id]?.color || null;
  const pick = (color) => () => {
    hideMenu();
    op('setColor', { id, color });
  };
  return el(
    'div',
    { class: 'menu-colors', role: 'group', 'aria-label': '文件夹颜色' },
    ...M.FOLDER_COLORS.map((c) =>
      el('button', {
        type: 'button',
        class: 'swatch',
        style: `--sw:var(--c-${c})`,
        title: COLOR_NAMES[c],
        'aria-label': COLOR_NAMES[c],
        'aria-pressed': String(cur === c),
        onclick: pick(c),
      }),
    ),
    el('button', { type: 'button', class: 'swatch none', title: '无颜色', 'aria-label': '无颜色', 'aria-pressed': String(!cur), onclick: pick(null) }),
  );
}

function hideMenu() {
  if ($('#menu').hidden) return;
  $('#menu').hidden = true;
  document.querySelectorAll('.menu-open').forEach((r) => r.classList.remove('menu-open'));
}

function nodeMenu(id) {
  const n = state.nodes[id];
  const parent = v.parent[id];
  const after = () => v.order[parent].indexOf(id) + 1;
  if (n.type === 'folder') {
    const count = M.countDescendants(v, id);
    return [
      { label: '重命名', run: () => startRename(id) },
      { label: '新建子文件夹', run: () => newFolder(id) },
      { label: '新建文件夹', run: () => newFolder(parent, after()) },
      '-',
      { heading: '颜色' },
      { colors: id },
      '-',
      { label: count ? `删除文件夹（含 ${count} 项）` : '删除文件夹', danger: true, run: () => op('remove', { id }) },
    ];
  }
  const t = findTab(n.url);
  if (parent === M.TODAY) {
    return [
      { label: t ? '切换到该标签' : '打开', run: () => openNode(n) },
      { label: '保存到收藏', run: () => op('move', { id, parent: M.ROOT }) },
      { label: '置顶', run: () => op('pin', { id }) },
      { label: '重命名', run: () => startRename(id) },
      { label: '复制链接', run: () => copyText(n.url) },
      '-',
      { label: '关闭（所有设备）', danger: true, run: () => op('closeToday', { id }) },
    ];
  }
  const items = [
    { label: t ? '切换到该标签' : '打开', run: () => openNode(n) },
    { label: '重命名', run: () => startRename(id) },
    { label: '复制链接', run: () => copyText(n.url) },
    parent === M.PINNED
      ? { label: '取消置顶', run: () => op('unpin', { id }) }
      : { label: '置顶', run: () => op('pin', { id }) },
  ];
  if (parent !== M.PINNED) items.push({ label: '新建文件夹', run: () => newFolder(parent, after()) });
  if (t) items.push({ label: '关闭标签', run: () => chrome.tabs.remove(t.id) });
  items.push('-', { label: '删除', danger: true, run: () => op('remove', { id }) });
  return items;
}

async function clearToday() {
  const openUrls = tabs.map((t) => t.url || t.pendingUrl || '');
  const n = await op('clearToday', { openUrls });
  showStatus(n ? `已清除 ${n} 个没打开的网页` : '没有需要清除的网页', 'info', 2500);
}

/* ---------- 交互事件 ---------- */

function targetOf(e) {
  const row = e.target.closest('[data-id]');
  if (!row || !state.nodes[row.dataset.id]) return {};
  return { row, node: state.nodes[row.dataset.id] };
}

document.addEventListener('click', (e) => {
  if (!e.target.closest('#menu')) hideMenu();
  if (e.target.closest('input.rename')) return;
  if (e.target.closest('#new-folder')) return newFolder();
  if (e.target.closest('#clear-today')) return clearToday();
  if (e.target.closest('#new-tab')) return chrome.tabs.create({ windowId: winId ?? undefined });
  if (e.target.closest('#toggle-collapse')) return closeSidePanel();
  const { row, node } = targetOf(e);
  if (!node) return;
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (act === 'menu') {
    const r = e.target.getBoundingClientRect();
    return showMenu(r.left, r.bottom + 2, nodeMenu(node.id), row);
  }
  if (act === 'save') return op('move', { id: node.id, parent: M.ROOT });
  if (act === 'pin') return op('pin', { id: node.id });
  if (act === 'close') return op('closeToday', { id: node.id });
  if (act === 'close-tab') {
    const t = findTab(node.url);
    if (t) chrome.tabs.remove(t.id);
    return;
  }
  if (node.type === 'folder') return op('setCollapsed', { id: node.id, collapsed: !node.collapsed });
  return openNode(node);
});

document.addEventListener('contextmenu', (e) => {
  if (e.target.closest('input')) return;
  e.preventDefault();
  const { row, node } = targetOf(e);
  if (node) showMenu(e.clientX, e.clientY, nodeMenu(node.id), row);
  else if (e.target.closest('#saved-section')) showMenu(e.clientX, e.clientY, [{ label: '新建文件夹', run: () => newFolder() }]);
  else hideMenu();
});

document.addEventListener('keydown', (e) => e.key === 'Escape' && hideMenu());

const searchInput = $('#search');
searchInput.addEventListener('input', () => setQuery(searchInput.value));
searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.stopPropagation();
    if (searchInput.value) {
      searchInput.value = '';
      setQuery('');
    } else searchInput.blur();
    return;
  }
  if (!query || !results.length) return;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    selected = (selected + (e.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length;
    renderResults();
    document.querySelector('#results .row.selected')?.scrollIntoView({ block: 'nearest' });
  } else if (e.key === 'Enter') {
    e.preventDefault();
    openNode(results[selected]);
  }
});
window.addEventListener('blur', hideMenu);

/* ---------- 拖拽 ---------- */

const dropLine = () => $('#drop-line');

function clearDropMarks() {
  document
    .querySelectorAll('.drop-before, .drop-after, .drop-into, .drop-zone')
    .forEach((x) => x.classList.remove('drop-before', 'drop-after', 'drop-into', 'drop-zone'));
  const line = dropLine();
  if (line) line.hidden = true;
}

function showInsertLine(target, after, horizontal = false) {
  const line = dropLine();
  if (!line || !target) return;
  const r = target.getBoundingClientRect();
  line.hidden = false;
  if (horizontal) {
    line.className = 'drop-line horizontal';
    Object.assign(line.style, { left: (after ? r.right - 1 : r.left - 1) + 'px', top: r.top + 'px', width: '2px', height: r.height + 'px' });
  } else {
    line.className = 'drop-line';
    Object.assign(line.style, { left: r.left + 'px', width: r.width + 'px', height: '2px', top: (after ? r.bottom - 1 : r.top - 1) + 'px' });
  }
}

/** 返回 { parent, index, el, cls, after?, horizontal?, tabMove? } 或 null。index 是移动前目标列表里的下标 */
function dropTarget(e) {
  if (!drag) return null;
  const dragNode = state.nodes[drag.id];
  if (!dragNode) return null;
  const under = document.elementFromPoint(e.clientX, e.clientY) || e.target;
  if (!under || under.closest?.('#menu, #drop-line, .side-footer, #status')) return null;
  const isFolder = dragNode.type === 'folder';

  // 今日区：只接收链接；今日内上下排序，并在同一窗口里联动移动真实标签
  if (under.closest('#tabs-section')) {
    if (isFolder) return null;
    const row = under.closest('#tabs .row.tab[data-id]');
    if (!row) return { parent: M.TODAY, index: null, el: $('#tabs'), cls: 'drop-zone' };
    const targetId = row.dataset.id;
    if (targetId === drag.id) return null;
    const idx = v.order[M.TODAY].indexOf(targetId);
    if (idx === -1) return null;
    const r = row.getBoundingClientRect();
    const after = (e.clientY - r.top) / Math.max(r.height, 1) >= 0.5;
    const dragTab = findTab(dragNode.url);
    const targetTab = findTab(state.nodes[targetId].url);
    let tabMove = null;
    if (dragTab && targetTab && dragTab.windowId === targetTab.windowId) {
      let index = after ? targetTab.index + 1 : targetTab.index;
      if (dragTab.index < index) index -= 1; // tabs.move 的 index 是移动后的位置
      tabMove = { tabId: dragTab.id, windowId: targetTab.windowId, index };
    }
    return { parent: M.TODAY, index: idx + (after ? 1 : 0), el: row, cls: after ? 'drop-after' : 'drop-before', after, tabMove };
  }

  const valid = (parent) => !(isFolder && (parent === M.PINNED || M.isInside(v, parent, drag.id)));

  // 文件夹的空白处 / 子容器 → 放进文件夹
  const well = under.closest('.folder-well[data-folder]');
  if (well && !under.closest('.row[data-id], .tile[data-id]')) {
    const id = well.dataset.folder;
    if (id === drag.id) return null;
    return valid(id) ? { parent: id, index: null, el: well, cls: 'drop-into' } : null;
  }

  const row = under.closest('#saved .row[data-id], #pinned .tile[data-id]');
  if (row) {
    const id = row.dataset.id;
    const n = state.nodes[id];
    if (id === drag.id || !n) return null;
    const r = row.getBoundingClientRect();
    const parent = v.parent[id];
    const idx = v.order[parent].indexOf(id);
    if (row.classList.contains('tile')) {
      const after = e.clientX > r.left + r.width / 2;
      return valid(parent)
        ? { parent, index: idx + (after ? 1 : 0), el: row, cls: after ? 'drop-after' : 'drop-before', after, horizontal: true }
        : null;
    }
    const ratio = (e.clientY - r.top) / Math.max(r.height, 1);
    // 文件夹中段：放进去；上下沿：同级重排
    if (n.type === 'folder' && ratio > 0.28 && ratio < 0.72) {
      return valid(id) ? { parent: id, index: null, el: row, cls: 'drop-into' } : null;
    }
    const after = ratio >= 0.5;
    return valid(parent)
      ? { parent, index: idx + (after ? 1 : 0), el: row, cls: after ? 'drop-after' : 'drop-before', after }
      : null;
  }

  if (under.closest('#pinned-section')) {
    return valid(M.PINNED) ? { parent: M.PINNED, index: null, el: $('#pinned'), cls: 'drop-zone' } : null;
  }
  if (under.closest('#saved-section')) return { parent: M.ROOT, index: null, el: $('#saved'), cls: 'drop-zone' };
  return null;
}

function markDrop(t) {
  clearDropMarks();
  if (!t) return;
  t.el.classList.add(t.cls);
  if (t.cls === 'drop-before' || t.cls === 'drop-after') showInsertLine(t.el, !!t.after, !!t.horizontal);
}

document.addEventListener('dragstart', (e) => {
  if (e.target.closest?.('button, input, a, [data-act]')) {
    e.preventDefault(); // 操作按钮不启动拖拽
    return;
  }
  const { row, node } = targetOf(e);
  if (!node || renaming) return e.preventDefault();
  drag = { id: node.id };
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', node.url || node.title || 'move');
  const ghost = row.cloneNode(true);
  Object.assign(ghost.style, { width: row.offsetWidth + 'px', position: 'absolute', top: '-9999px', opacity: '0.9' });
  document.body.appendChild(ghost);
  e.dataTransfer.setDragImage(ghost, 16, 16);
  setTimeout(() => ghost.remove(), 0);
  row.classList.add('dragging');
  document.body.classList.add('is-dragging');
  hideMenu();
});

document.addEventListener('dragover', (e) => {
  const t = dropTarget(e);
  if (!t) return clearDropMarks();
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  markDrop(t);
});

document.addEventListener('drop', async (e) => {
  const t = dropTarget(e);
  clearDropMarks();
  if (!t || !drag) return;
  e.preventDefault();
  const id = drag.id;
  drag = null;
  document.body.classList.remove('is-dragging');
  op('move', { id, parent: t.parent, index: t.index });
  if (t.tabMove) {
    try {
      await chrome.tabs.move(t.tabMove.tabId, { index: t.tabMove.index, windowId: t.tabMove.windowId });
    } catch (err) {
      console.warn('[side-pocket] tabs.move 失败', err);
    }
  }
});

document.addEventListener('dragend', () => {
  drag = null;
  clearDropMarks();
  document.body.classList.remove('is-dragging');
  document.querySelectorAll('.dragging').forEach((x) => x.classList.remove('dragging'));
});

/* ---------- 监听 ---------- */

for (const ev of ['onCreated', 'onRemoved', 'onUpdated', 'onActivated', 'onMoved', 'onAttached', 'onDetached', 'onReplaced']) {
  chrome.tabs[ev].addListener(() => refreshSoon());
}

// 书签变了（包括在 Chrome 书签管理器里改的、从别的电脑同步来的）、文件夹颜色 / 折叠变了：重新读取
for (const ev of ['onCreated', 'onRemoved', 'onChanged', 'onMoved', 'onChildrenReordered', 'onImportEnded']) {
  chrome.bookmarks[ev]?.addListener(() => refreshSoon());
}
chrome.storage.onChanged.addListener((changes, area) => {
  if ((area === 'sync' && changes[B.COLOR_KEY]) || (area === 'local' && changes[B.COLLAPSE_KEY])) refreshSoon();
});

chrome.storage.session.onChanged.addListener((changes) => {
  const c = changes[VIEW_KEY];
  if (!c) return;
  showSync(c.newValue?.status);
  refreshSoon(30);
});

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && stale) refresh();
});

/* ---------- 设置 ---------- */

/** 设置里显示当前快捷键；没设置（比如被别的扩展占了）时明确提示 */
async function refreshSettingsUi() {
  const cmds = await chrome.commands.getAll().catch(() => []);
  const key = cmds.find((c) => c.name === '_execute_action')?.shortcut || '';
  const el = $('#shortcut-key');
  el.textContent = key || '未设置';
  el.classList.toggle('warn', !key);
  $('#shortcut-hint').hidden = !!key;
}

/** 关闭 Chrome 侧边栏（Chrome 标题栏上的 ✕、再按一次快捷键也可以） */
function closeSidePanel() {
  if (chrome.sidePanel.close && winId != null) chrome.sidePanel.close({ windowId: winId }).catch(() => window.close());
  else window.close();
}

function setupChromeUi() {
  const pop = $('#settings-pop');
  const setPop = (open) => {
    if (pop.hidden === !open) return;
    pop.hidden = !open;
    if (open) refreshSettingsUi();
  };

  $('#open-settings').addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    setPop(pop.hidden);
  });
  pop.addEventListener('click', (e) => e.stopPropagation());
  document.addEventListener('click', () => setPop(false));

  // 扩展不能自己改快捷键，只能打开 Chrome 的快捷键设置页
  $('#edit-shortcut').addEventListener('click', () => {
    setPop(false);
    chrome.tabs.create({ url: 'chrome://extensions/shortcuts', windowId: winId ?? undefined });
  });
  // 从设置页改完回来，侧栏重新拿到焦点时更新显示
  window.addEventListener('focus', () => !pop.hidden && refreshSettingsUi());
}

async function init() {
  setupChromeUi();
  const [s, has] = await Promise.all([chrome.storage.session.get(VIEW_KEY), chrome.storage.local.get(LOCAL_KEY)]);
  showSync(s[VIEW_KEY]?.status);
  if (!has[LOCAL_KEY]) {
    // 新版本第一次运行：等后台完成迁移 / 首次对账
    await chrome.runtime.sendMessage({ type: 'side-pocket:sync' }).catch((e) => console.warn('[side-pocket]', e));
  }
  // 在后台打开的网页也先画一次，切过来时直接有内容，不会先空白再出现
  await refresh({ force: true });
}

init();
