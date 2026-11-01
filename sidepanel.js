// 侧栏界面：只负责显示和把用户操作发给后台。
// 数据由 background.js 维护在 storage.local；后台改完数据会更新 storage.session 里的 VIEW_KEY，
// 这里收到通知后重新读取。每个网页都有一个贴边栏 iframe，页面在后台（不可见）时不刷新，
// 切回来时再补一次，所以开很多标签也不会每个都在干活。

import * as M from './model.js';
import { LOCAL_KEY, VIEW_KEY } from './store.js';
import {
  getCollapseMode,
  setCollapseMode,
  getSidebarSide,
  setSidebarSide,
  isFullHideMode,
  MODE_KEY,
  SIDE_KEY,
  SIDE_RIGHT,
} from './settings.js';

const $ = (sel) => document.querySelector(sel);
const SELF_PREFIX = chrome.runtime.getURL('');
const PAGE_MODE = new URLSearchParams(location.search).get('mode') || 'sidepanel';
const IS_POPUP = PAGE_MODE === 'popup';
const IS_OVERLAY = PAGE_MODE === 'overlay';
if (IS_OVERLAY) document.documentElement.classList.add('is-collapsed');

let state = M.emptyState();
let v = M.view(state);
let tabs = []; // 所有窗口的普通标签
let winId = null; // 侧栏所在窗口
let renaming = null; // 正在重命名的节点 id
let drag = null; // { id }
let inflight = 0; // 已在本地生效、后台还没确认的操作数
let stale = false;
let rendering = false;
let syncStatus = 'saved';

/* ---------- 工具 ---------- */

function favicon(url) {
  const u = new URL(chrome.runtime.getURL('/_favicon/'));
  u.searchParams.set('pageUrl', url);
  u.searchParams.set('size', '32');
  return u.toString();
}

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

const FOLDER_SVG = '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M2.5 4.5h3.2l1.1 1.2H13.5v6.3a1.5 1.5 0 0 1-1.5 1.5h-8A1.5 1.5 0 0 1 2.5 12V4.5z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M2.5 6.2h11" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" opacity=".45"/></svg>';
const CARET_SVG = '<svg viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="M4.2 2.5 7.7 6 4.2 9.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';

function icon(svg, className) {
  const s = el('span', { class: className, 'aria-hidden': 'true' });
  s.innerHTML = svg; // 常量 SVG，不含用户数据
  return s;
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

const openCls = (t) => (t ? ' open' : '') + (t?.active && t.windowId === winId ? ' active' : '');

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
  if (!st || st === syncStatus) return;
  syncStatus = st;
  if (SYNC_MSG[st]) showStatus(SYNC_MSG[st], 'warn');
  else if ($('#status').classList.contains('warn')) $('#status').hidden = true;
}

/* ---------- 数据 ---------- */

async function loadState() {
  const d = await chrome.storage.local.get(LOCAL_KEY);
  state = { nodes: d[LOCAL_KEY]?.nodes || {} };
  if (renaming && !state.nodes[renaming]) renaming = null;
}

async function resolveWindowId() {
  try {
    if (IS_OVERLAY) {
      const t = await chrome.tabs.getCurrent();
      if (t?.windowId != null) return t.windowId;
    }
    const cur = await chrome.windows.getCurrent();
    if (cur?.type === 'normal') return cur.id;
    const last = await chrome.windows.getLastFocused({ windowTypes: ['normal'] });
    if (last?.id != null) return last.id;
  } catch (e) {
    console.warn('[arc-sidebar] 取窗口失败', e);
  }
  return tabs[0]?.windowId ?? null;
}

async function refresh() {
  if (document.hidden || inflight) {
    stale = true;
    return;
  }
  stale = false;
  const [all] = await Promise.all([chrome.tabs.query({}), loadState()]);
  tabs = all.filter((t) => !isSelf(t));
  winId = await resolveWindowId();
  render();
}

let refreshTimer;
function refreshSoon(ms = 80) {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refresh, ms);
}

/** 先在本地副本上执行（立即显示），再交给后台执行（权威结果） */
async function op(name, args = {}) {
  try {
    M.applyOp(state, name, args);
    M.takeChanges(state);
  } catch (e) {
    console.warn('[arc-sidebar]', e);
    return;
  }
  render();
  inflight++;
  try {
    const r = await chrome.runtime.sendMessage({ type: 'arc:op', op: name, args });
    if (!r?.ok) showStatus('操作失败：' + (r?.error || '未知错误'), 'warn', 4000);
  } catch (e) {
    showStatus('操作失败：' + (e?.message || e), 'warn', 4000);
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

function newFolder(parent = M.ROOT, index) {
  const id = M.newId();
  if (parent !== M.ROOT && state.nodes[parent]?.collapsed) op('setCollapsed', { id: parent, collapsed: false });
  renaming = id;
  op('addFolder', { id, parent, index });
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
    renderPinned();
    renderSaved();
    renderTabs();
    renderRail();
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

function linkIcons(list, extraCls = '') {
  return list.map((n) =>
    el(
      'button',
      { type: 'button', class: 'rail-item' + extraCls + openCls(findTab(n.url)), title: displayTitle(n), 'data-id': n.id },
      el('img', { src: favicon(n.url), alt: '', draggable: 'false' }),
    ),
  );
}

function renderRail() {
  const pinBox = $('#rail-pinned');
  const tabBox = $('#rail-tabs');
  if (!pinBox || !tabBox) return;
  const pinned = v.order[M.PINNED].map((id) => state.nodes[id]).filter((n) => n.type === 'link');
  pinBox.replaceChildren(...linkIcons(pinned, ' pinned-ico'));
  const divider = $('#rail-divider');
  if (divider) divider.hidden = pinned.length === 0;

  const saved = [];
  const collect = (parent) => {
    for (const id of v.order[parent] || []) {
      const n = state.nodes[id];
      if (n.type === 'folder') collect(id);
      else saved.push(n);
    }
  };
  collect(M.ROOT);
  const today = v.order[M.TODAY].map((id) => state.nodes[id]);
  tabBox.replaceChildren(...linkIcons([...saved, ...today]));
}

function renderPinned() {
  $('#pinned').replaceChildren(
    ...v.order[M.PINNED].map((id) => {
      const n = state.nodes[id];
      return el(
        'div',
        { class: 'tile' + openCls(findTab(n.url)), title: displayTitle(n), draggable: 'true', 'data-id': id, role: 'button', tabindex: '0' },
        el('img', { src: favicon(n.url), alt: '', draggable: 'false' }),
      );
    }),
  );
}

function renderSaved() {
  const walk = (parent, depth) =>
    v.order[parent].map((id) => {
      const n = state.nodes[id];
      if (n.type !== 'folder') return linkRow(n, depth);
      // 始终渲染子容器，靠 .collapsed + grid 过渡做展开/折叠动画
      return el(
        'div',
        { class: 'folder-well' + (n.collapsed ? ' collapsed' : ''), 'data-folder': n.id },
        folderRow(n, depth),
        el('div', { class: 'folder-children-wrap' }, el('div', { class: 'folder-children' }, ...walk(id, depth + 1))),
      );
    });
  const rows = walk(M.ROOT, 0);
  if (!rows.length) rows.push(el('div', { class: 'empty' }, '还没有收藏。从「今日」点 ＋ 或拖到这里。'));
  $('#saved').replaceChildren(...rows);
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

function linkRow(n, depth) {
  const t = findTab(n.url);
  return el(
    'div',
    { class: 'row link' + openCls(t), style: `--depth:${depth}`, draggable: 'true', 'data-id': n.id, title: n.url },
    el('img', { class: 'fav', src: favicon(n.url), alt: '', draggable: 'false' }),
    titleNode(n),
    el(
      'span',
      { class: 'actions' },
      t ? el('button', { 'data-act': 'close-tab', title: '关闭标签（保留在侧边栏）' }, '✕') : null,
      el('button', { 'data-act': 'menu', title: '更多' }, '⋯'),
    ),
  );
}

function folderRow(n, depth) {
  return el(
    'div',
    { class: 'row folder' + (n.collapsed ? ' is-collapsed' : ''), style: `--depth:${depth}`, draggable: 'true', 'data-id': n.id },
    icon(FOLDER_SVG, 'folder-ico'),
    titleNode(n),
    el('span', { class: 'count' }, String(v.order[n.id].length || '')),
    el('span', { class: 'actions' }, el('button', { 'data-act': 'menu', title: '更多' }, '⋯')),
    icon(CARET_SVG, 'caret'),
  );
}

function renderTabs() {
  const ids = v.order[M.TODAY];
  $('#tab-count').textContent = ids.length ? String(ids.length) : '';
  const rows = ids.map((id) => {
    const n = state.nodes[id];
    return el(
      'div',
      { class: 'row tab' + openCls(findTab(n.url)), draggable: 'true', 'data-id': n.id, title: n.url },
      el('img', { class: 'fav', src: favicon(n.url), alt: '', draggable: 'false' }),
      titleNode(n),
      el(
        'span',
        { class: 'actions' },
        el('button', { 'data-act': 'save', title: '保存到侧边栏' }, '＋'),
        el('button', { 'data-act': 'pin', title: '固定' }, '📌'),
        el('button', { 'data-act': 'close', title: '关闭（所有设备）' }, '✕'),
      ),
    );
  });
  if (!rows.length) rows.push(el('div', { class: 'empty' }, '今天还没有其他标签'));
  $('#tabs').replaceChildren(...rows);
}

/* ---------- 菜单 ---------- */

function postToHost(type, open) {
  if (!IS_OVERLAY) return;
  window.parent.postMessage({ source: 'arc-sidebar', type, ...(open == null ? {} : { open: !!open }) }, '*');
}

function showMenu(x, y, entries, row) {
  const m = $('#menu');
  m.replaceChildren(
    ...entries.map((e) =>
      e === '-'
        ? el('hr')
        : el('button', { class: e.danger ? 'danger' : '', onclick: () => { hideMenu(); e.run(); } }, e.label),
    ),
  );
  m.hidden = false;
  document.querySelectorAll('.menu-open').forEach((r) => r.classList.remove('menu-open'));
  row?.classList.add('menu-open');
  postToHost('menu', true);
  const r = m.getBoundingClientRect();
  m.style.left = Math.max(4, Math.min(x, innerWidth - r.width - 4)) + 'px';
  m.style.top = Math.max(4, Math.min(y, innerHeight - r.height - 4)) + 'px';
}

function hideMenu() {
  if ($('#menu').hidden) return;
  $('#menu').hidden = true;
  document.querySelectorAll('.menu-open').forEach((r) => r.classList.remove('menu-open'));
  postToHost('menu', false);
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
      { label: count ? `删除文件夹（含 ${count} 项）` : '删除文件夹', danger: true, run: () => op('remove', { id }) },
    ];
  }
  const t = findTab(n.url);
  if (parent === M.TODAY) {
    return [
      { label: t ? '切换到该标签' : '打开', run: () => openNode(n) },
      { label: '保存到侧边栏', run: () => op('move', { id, parent: M.ROOT }) },
      { label: '固定', run: () => op('pin', { id }) },
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
      ? { label: '取消固定', run: () => op('unpin', { id }) }
      : { label: '固定', run: () => op('pin', { id }) },
  ];
  if (parent !== M.PINNED) items.push({ label: '新建文件夹', run: () => newFolder(parent, after()) });
  if (t) items.push({ label: '关闭标签', run: () => chrome.tabs.remove(t.id) });
  items.push('-', { label: '删除', danger: true, run: () => op('remove', { id }) });
  return items;
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
  if (e.target.closest('#new-tab, #rail-new-tab')) return chrome.tabs.create({ windowId: winId ?? undefined });
  if (e.target.closest('#rail-expand')) {
    postToHost('request-expand');
    document.documentElement.classList.remove('is-collapsed');
    return;
  }
  if (e.target.closest('#toggle-collapse')) {
    postToHost('request-collapse');
    document.documentElement.classList.add('is-collapsed');
    return;
  }
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
      console.warn('[arc-sidebar] tabs.move 失败', err);
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

async function refreshSettingsUi() {
  const [mode, side] = await Promise.all([getCollapseMode(chrome.storage.sync), getSidebarSide(chrome.storage.sync)]);
  document.querySelectorAll('input[name=collapseMode]').forEach((x) => (x.checked = x.value === mode));
  document.querySelectorAll('input[name=sidebarSide]').forEach((x) => (x.checked = x.value === side));
  document.documentElement.dataset.side = side;
  document.documentElement.dataset.collapseStyle = isFullHideMode(mode) ? 'full-hide' : 'icon-rail';
}

function setupChromeUi() {
  const gear = $('#open-settings');
  const pop = $('#settings-pop');

  if (IS_POPUP) {
    document.body.classList.add('is-popup');
  } else if (IS_OVERLAY) {
    document.body.classList.add('is-overlay');
    window.addEventListener('message', (ev) => {
      if (ev.source !== window.parent) return;
      const d = ev.data;
      if (!d || d.source !== 'arc-sidebar-host' || d.type !== 'state') return;
      document.documentElement.classList.toggle('is-collapsed', !!d.collapsed);
      if (d.mode === 'full-hide' || d.mode === 'icon-rail') document.documentElement.dataset.collapseStyle = d.mode;
      if (d.side === 'left' || d.side === 'right') document.documentElement.dataset.side = d.side;
    });
    postToHost('ready');
  }

  const setPop = (open) => {
    if (pop.hidden === !open) return;
    pop.hidden = !open;
    postToHost('settings', open);
    if (open) refreshSettingsUi();
  };

  gear.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    setPop(pop.hidden);
  });
  pop.addEventListener('click', (e) => e.stopPropagation());
  document.addEventListener('click', () => setPop(false));

  pop.querySelectorAll('input[name=collapseMode]').forEach((input) => {
    input.addEventListener('change', async () => {
      if (!input.checked) return;
      const mode = await setCollapseMode(chrome.storage.sync, input.value);
      setPop(false);
      const label = isFullHideMode(mode) ? '完全隐藏（移到边缘唤出）' : '图标收起（仅显示网页图标）';
      if (IS_OVERLAY) return showStatus(`已切换为${label}`, 'info', 2500);
      // 从系统侧栏 / 弹窗里切换：确认当前网页能不能贴边
      try {
        const res = await chrome.runtime.sendMessage({ type: 'arc-sidebar:activate-auto' });
        const r = res?.result;
        if (r && !r.activeInjected) {
          const isFile = String(r.activeUrl || '').startsWith('file:');
          showStatus(
            isFile
              ? '本地文件页请在 chrome://extensions 详情中开启「允许访问文件网址」以启用贴边栏；其他网页已生效。'
              : '当前页面受浏览器限制无法贴边；切到普通网页即可。点扩展图标可在系统侧栏打开。',
            'warn',
            6000,
          );
          return;
        }
      } catch (e) {
        console.warn('[arc-sidebar]', e);
      }
      showStatus(`已切换为${label}`, 'info', 2500);
    });
  });

  pop.querySelectorAll('input[name=sidebarSide]').forEach((input) => {
    input.addEventListener('change', async () => {
      if (!input.checked) return;
      setPop(false);
      const side = await setSidebarSide(chrome.storage.sync, input.value);
      await refreshSettingsUi();
      showStatus(`已切换至网页${side === SIDE_RIGHT ? '右侧' : '左侧'}`, 'info', 2000);
    });
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && (changes[MODE_KEY] || changes[SIDE_KEY])) refreshSettingsUi();
  });
  refreshSettingsUi();
}

async function init() {
  setupChromeUi();
  const s = await chrome.storage.session.get(VIEW_KEY);
  showSync(s[VIEW_KEY]?.status);
  const has = await chrome.storage.local.get(LOCAL_KEY);
  if (!has[LOCAL_KEY]) {
    // 新版本第一次运行：等后台完成迁移 / 首次对账
    await chrome.runtime.sendMessage({ type: 'arc:sync' }).catch((e) => console.warn('[arc-sidebar]', e));
  }
  await refresh();
}

init();
