import * as M from './model.js';
import { createStore } from './store.js';
import {
  getCollapseMode,
  setCollapseMode,
  getSidebarSide,
  setSidebarSide,
  isOverlayMode,
  isFullHideMode,
  MODE_AUTO,
  MODE_ICON_RAIL,
  MODE_FULL_HIDE,
  MODE_KEY,
  SIDE_KEY,
  SIDE_LEFT,
  SIDE_RIGHT,
} from './settings.js';

const $ = (sel) => document.querySelector(sel);
const SELF_PREFIX = chrome.runtime.getURL('');
const PAGE_MODE = new URLSearchParams(location.search).get('mode') || 'sidepanel';
const IS_POPUP = PAGE_MODE === 'popup';
const IS_OVERLAY = PAGE_MODE === 'overlay';
if (IS_OVERLAY) {
  document.documentElement.classList.add('is-collapsed');
}


let state = M.emptyState();
let tabs = []; // 所有窗口的标签
let tabMap = {}; // 本机 tabId -> today nodeId 映射（纯 nodeId，不存 dismissed）
const ignoredTabUrls = new Map(); // 会话内临时忽略正在关闭/远端移除的 tabId -> normUrl
let winId = null; // 侧边栏所在窗口
let renaming = null; // 正在重命名的节点 id
let drag = null; // { kind: 'node', id } | { kind: 'tab', tab }
let store;

/* ---------- 工具 ---------- */

function favicon(url) {
  const u = new URL(chrome.runtime.getURL('/_favicon/'));
  u.searchParams.set('pageUrl', url);
  u.searchParams.set('size', '32');
  return u.toString();
}

function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'style' || k.startsWith('data-') || k.startsWith('aria-') || k === 'title' || k === 'draggable' || k === 'src' || k === 'type' || k === 'role' || k === 'tabindex') e.setAttribute(k, v);
    else e[k] = v;
  }
  for (const c of children) if (c != null) e.append(c);
  return e;
}

const FOLDER_SVG = '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M2.5 4.5h3.2l1.1 1.2H13.5v6.3a1.5 1.5 0 0 1-1.5 1.5h-8A1.5 1.5 0 0 1 2.5 12V4.5z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M2.5 6.2h11" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" opacity=".45"/></svg>';
const CARET_SVG = '<svg viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="M4.2 2.5 7.7 6 4.2 9.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';

function icon(svg, className) {
  const s = el('span', { class: className, 'aria-hidden': 'true' });
  s.innerHTML = svg;
  return s;
}

function displayTitle(n) {
  if (n.title) return n.title;
  try { return new URL(n.url).hostname; } catch { return n.url; }
}

/** 找到该 URL 已打开的标签：优先当前窗口 */
function findTab(url) {
  const u = M.normUrl(url);
  const hits = tabs.filter((t) => M.normUrl(t.url || t.pendingUrl) === u);
  return hits.find((t) => t.windowId === winId) || hits[0] || null;
}

function isSelf(t) {
  return (t.url || t.pendingUrl || '').startsWith(SELF_PREFIX);
}

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

/* ---------- 状态变更 ---------- */

function commit({ immediate = false } = {}) {
  M.normalize(state);
  render();
  const snap = structuredClone(state);
  if (immediate) store.save(snap);
  else store.saveSoon(snap);
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

function saveTab(tab, parent = M.ROOT, index) {
  const url = tab.url || tab.pendingUrl;
  const existingToday = M.findTodayByUrl(state, url);
  if (existingToday) {
    M.move(state, existingToday, parent, index);
    commit({ immediate: true });
    return existingToday;
  }
  const id = M.addLink(state, { title: tab.title, url }, parent, index);
  commit({ immediate: true });
  return id;
}

async function closeTodayNode(id) {
  const n = state.nodes[id];
  if (!n) return;
  const nu = M.normUrl(n.url);
  const matchingTabs = tabs.filter((t) => M.normUrl(t.url || t.pendingUrl) === nu);
  for (const [tid, nid] of Object.entries(tabMap)) {
    if (nid === id) {
      ignoredTabUrls.set(String(tid), nu);
      delete tabMap[tid];
    }
  }
  for (const t of matchingTabs) {
    ignoredTabUrls.set(String(t.id), nu);
    delete tabMap[String(t.id)];
  }
  M.remove(state, id);
  chrome.storage.local.set({ todayTabMap: M.sanitizeTabMap(tabMap) });
  commit({ immediate: true });
  for (const t of matchingTabs) {
    try {
      await chrome.tabs.remove(t.id);
    } catch (_) {}
  }
}

function newFolder(parent = M.ROOT, index) {
  const id = M.addFolder(state, '新文件夹', parent, index);
  if (parent !== M.ROOT) state.nodes[parent].collapsed = false;
  renaming = id;
  commit();
}

function startRename(id) {
  renaming = id;
  render();
}

/* ---------- 渲染 ---------- */

function render() {
  renderPinned();
  renderSaved();
  renderTabs();
  renderRail();
  const input = document.querySelector('input.rename');
  if (input && document.activeElement !== input) {
    input.focus();
    input.select();
  }
}

function renderRail() {
  const pinBox = $('#rail-pinned');
  const tabBox = $('#rail-tabs');
  const divider = $('#rail-divider');
  if (!pinBox || !tabBox) return;

  // 1. 置顶图标
  const pinItems = (state.order[M.PINNED] || [])
    .map((id) => state.nodes[id])
    .filter((n) => n && n.type === 'link')
    .map((n) => {
      const t = findTab(n.url);
      return el(
        'button',
        {
          type: 'button',
          class:
            'rail-item pinned-ico' +
            (t ? ' open' : '') +
            (t?.active && t.windowId === winId ? ' active' : ''),
          title: displayTitle(n),
          'data-id': n.id,
        },
        el('img', { src: favicon(n.url), alt: '', draggable: 'false' }),
      );
    });
  pinBox.replaceChildren(...pinItems);
  if (divider) divider.hidden = pinItems.length === 0;

  // 2. 收藏（深度优先收集所有链接）+ 今日链接，纯图标展示
  const savedLinks = [];
  const collectSaved = (parent) => {
    for (const id of state.order[parent] || []) {
      const n = state.nodes[id];
      if (!n) continue;
      if (n.type === 'folder') collectSaved(id);
      else if (n.type === 'link') savedLinks.push(n);
    }
  };
  collectSaved(M.ROOT);
  const todayLinks = (state.order[M.TODAY] || [])
    .map((id) => state.nodes[id])
    .filter((n) => n && n.type === 'link');

  const allRailLinks = [...savedLinks, ...todayLinks];
  tabBox.replaceChildren(
    ...allRailLinks.map((n) => {
      const t = findTab(n.url);
      return el(
        'button',
        {
          type: 'button',
          class:
            'rail-item' +
            (t ? ' open' : '') +
            (t?.active && t.windowId === winId ? ' active' : ''),
          title: displayTitle(n),
          'data-id': n.id,
        },
        el('img', { src: favicon(n.url), alt: '', draggable: 'false' }),
      );
    }),
  );
}

function renderPinned() {
  const box = $('#pinned');
  box.replaceChildren(
    ...state.order[M.PINNED].map((id) => {
      const n = state.nodes[id];
      const t = findTab(n.url);
      return el(
        'div',
        {
          class: 'tile' + (t ? ' open' : '') + (t?.active && t.windowId === winId ? ' active' : ''),
          title: displayTitle(n),
          draggable: 'true',
          'data-id': id,
          role: 'button',
          tabindex: '0',
        },
        el('img', { src: favicon(n.url), alt: '', draggable: 'false' }),
      );
    }),
  );
}

function renderSaved() {
  const box = $('#saved');
  const rows = [];
  const walk = (parent, depth) => {
    const out = [];
    for (const id of state.order[parent]) {
      const n = state.nodes[id];
      if (n.type === 'folder') {
        // 始终渲染井结构，靠 .collapsed + grid 过渡做展开/折叠动画
        const kids = walk(id, depth + 1);
        out.push(
          el(
            'div',
            {
              class: 'folder-well' + (n.collapsed ? ' collapsed' : ''),
              'data-folder': n.id,
            },
            folderRow(n, depth === 0 ? 0 : depth),
            el('div', { class: 'folder-children-wrap' }, el('div', { class: 'folder-children' }, ...kids)),
          ),
        );
      } else {
        out.push(linkRow(n, depth));
      }
    }
    return out;
  };
  rows.push(...walk(M.ROOT, 0));
  if (!rows.length) rows.push(el('div', { class: 'empty' }, '还没有收藏。点下方的 ＋ 或拖到这里。'));
  box.replaceChildren(...rows);
}

function titleNode(n) {
  if (renaming === n.id) {
    const input = el('input', { class: 'rename', value: n.title || '' });
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      renaming = null;
      if (ok) M.rename(state, n.id, input.value);
      commit();
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
  return el('span', { class: 'title' }, displayTitle(n));
}

function linkRow(n, depth) {
  const t = findTab(n.url);
  return el(
    'div',
    {
      class: 'row link' + (t ? ' open' : '') + (t?.active && t.windowId === winId ? ' active' : ''),
      style: `--depth:${depth}`,
      draggable: 'true',
      'data-id': n.id,
      title: n.url,
    },
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
    {
      class: 'row folder' + (n.collapsed ? ' is-collapsed' : ''),
      style: `--depth:${depth}`,
      draggable: 'true',
      'data-id': n.id,
    },
    icon(FOLDER_SVG, 'folder-ico'),
    titleNode(n),
    el('span', { class: 'count' }, String(state.order[n.id].length || '')),
    el('span', { class: 'actions' }, el('button', { 'data-act': 'menu', title: '更多' }, '⋯')),
    icon(CARET_SVG, 'caret'),
  );
}

function syncableWindowTabs() {
  return tabs
    .filter((t) => !isSelf(t))
    .sort((a, b) => (a.windowId - b.windowId) || (a.index - b.index));
}

async function resolveNormalWindowId() {
  try {
    const cur = await chrome.windows.getCurrent();
    if (cur && cur.type === 'normal') return cur.id;
    const last = await chrome.windows.getLastFocused({ windowTypes: ['normal'] });
    if (last && last.id != null) return last.id;
  } catch (_) {}
  const firstNormal = tabs.find((t) => !isSelf(t));
  return firstNormal ? firstNormal.windowId : null;
}

function renderTabs() {
  const ids = state.order[M.TODAY] || [];
  $('#tab-count').textContent = ids.length ? String(ids.length) : '';
  const rows = ids
    .map((id) => state.nodes[id])
    .filter(Boolean)
    .map((n) => {
      const t = findTab(n.url);
      return el(
        'div',
        {
          class: 'row tab' + (t ? ' open' : '') + (t?.active && t.windowId === winId ? ' active' : ''),
          draggable: 'true',
          'data-id': n.id,
          'data-tab': t ? t.id : null,
          title: n.url,
        },
        el('img', { class: 'fav', src: favicon(n.url), alt: '', draggable: 'false' }),
        titleNode(n),
        el(
          'span',
          { class: 'actions' },
          el('button', { 'data-act': 'save', title: '保存到侧边栏' }, '＋'),
          el('button', { 'data-act': 'pin', title: '固定' }, '📌'),
          el('button', { 'data-act': 'close', title: '关闭' }, '✕'),
        ),
      );
    });
  if (!rows.length) rows.push(el('div', { class: 'empty' }, '今天还没有其他标签'));
  $('#tabs').replaceChildren(...rows);
}

/* ---------- 菜单 ---------- */

function notifyOverlayMenu(open) {
  if (!IS_OVERLAY) return;
  try {
    window.parent.postMessage({ source: 'arc-sidebar', type: 'menu', open: !!open }, '*');
  } catch (_) {}
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
  notifyOverlayMenu(true);
  const r = m.getBoundingClientRect();
  m.style.left = Math.max(4, Math.min(x, innerWidth - r.width - 4)) + 'px';
  m.style.top = Math.max(4, Math.min(y, innerHeight - r.height - 4)) + 'px';
}

function hideMenu() {
  $('#menu').hidden = true;
  document.querySelectorAll('.menu-open').forEach((r) => r.classList.remove('menu-open'));
  notifyOverlayMenu(false);
}

function nodeMenu(id) {
  const n = state.nodes[id];
  const parent = M.parentOf(state, id);
  if (n.type === 'folder') {
    const count = M.countDescendants(state, id);
    return [
      { label: '重命名', run: () => startRename(id) },
      { label: '新建子文件夹', run: () => newFolder(id) },
      { label: '新建文件夹', run: () => newFolder(parent, state.order[parent].indexOf(id) + 1) },
      '-',
      { label: count ? `删除文件夹（含 ${count} 项）` : '删除文件夹', danger: true, run: () => { M.remove(state, id); commit(); } },
    ];
  }
  const t = findTab(n.url);
  if (parent === M.TODAY) {
    return [
      { label: t ? '切换到该标签' : '打开', run: () => openNode(n) },
      { label: '保存到侧边栏', run: () => { M.move(state, id, M.ROOT); commit({ immediate: true }); } },
      { label: '固定', run: () => { M.pin(state, id); commit({ immediate: true }); } },
      { label: '重命名', run: () => startRename(id) },
      { label: '复制链接', run: () => copyText(n.url) },
      '-',
      { label: '关闭标签', danger: true, run: () => closeTodayNode(id) },
    ];
  }
  const items = [
    { label: t ? '切换到该标签' : '打开', run: () => openNode(n) },
    { label: '重命名', run: () => startRename(id) },
    { label: '复制链接', run: () => copyText(n.url) },
    parent === M.PINNED
      ? { label: '取消固定', run: () => { M.unpin(state, id); commit(); } }
      : { label: '固定', run: () => { M.pin(state, id); commit(); } },
  ];
  if (parent !== M.PINNED) items.push({ label: '新建文件夹', run: () => newFolder(parent, state.order[parent].indexOf(id) + 1) });
  if (t) items.push({ label: '关闭标签', run: () => chrome.tabs.remove(t.id) });
  items.push('-', { label: '删除', danger: true, run: () => { M.remove(state, id); commit(); } });
  return items;
}

function tabMenu(tab) {
  return [
    { label: '保存到侧边栏', run: () => saveTab(tab) },
    { label: '固定', run: () => saveTab(tab, M.PINNED) },
    { label: '复制链接', run: () => copyText(tab.url) },
    { label: '新建文件夹', run: () => newFolder() },
    '-',
    { label: '关闭标签', danger: true, run: () => chrome.tabs.remove(tab.id) },
  ];
}

/* ---------- 交互事件 ---------- */

function targetOf(e) {
  const row = e.target.closest('[data-id], [data-tab]');
  if (!row) return {};
  if (row.dataset.id) return { row, id: row.dataset.id, node: state.nodes[row.dataset.id] };
  return { row, tab: tabs.find((t) => t.id === Number(row.dataset.tab)) };
}

document.addEventListener('click', (e) => {
  if (!e.target.closest('#menu')) hideMenu();
  if (e.target.closest('input.rename')) return;
  const { row, node, tab } = targetOf(e);
  if (e.target.closest('#new-folder')) return newFolder();
  if (e.target.closest('#new-tab, #rail-new-tab')) return chrome.tabs.create({ windowId: winId ?? undefined });
  if (e.target.closest('#rail-expand')) {
    try {
      window.parent.postMessage({ source: 'arc-sidebar', type: 'request-expand' }, '*');
    } catch (_) {}
    document.documentElement.classList.remove('is-collapsed');
    return;
  }
  if (e.target.closest('#toggle-collapse')) {
    try {
      window.parent.postMessage({ source: 'arc-sidebar', type: 'request-collapse' }, '*');
    } catch (_) {}
    document.documentElement.classList.add('is-collapsed');
    return;
  }
  if (!row) return;
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (act === 'menu') {
    const r = e.target.getBoundingClientRect();
    return showMenu(r.left, r.bottom + 2, node ? nodeMenu(node.id) : tabMenu(tab), row);
  }
  if (node) {
    if (act === 'save') {
      M.move(state, node.id, M.ROOT);
      return commit({ immediate: true });
    }
    if (act === 'pin') {
      M.pin(state, node.id);
      return commit({ immediate: true });
    }
    if (act === 'close') {
      return closeTodayNode(node.id);
    }
    if (act === 'close-tab') {
      const t = findTab(node.url);
      if (t) chrome.tabs.remove(t.id);
      return;
    }
    if (node.type === 'folder') {
      node.collapsed = !node.collapsed;
      return commit();
    }
    return openNode(node);
  }
  if (tab) {
    if (act === 'save') return saveTab(tab);
    if (act === 'pin') return saveTab(tab, M.PINNED);
    if (act === 'close') return chrome.tabs.remove(tab.id);
    chrome.tabs.update(tab.id, { active: true });
  }
});

document.addEventListener('contextmenu', (e) => {
  if (e.target.closest('input')) return;
  e.preventDefault();
  const { row, node, tab } = targetOf(e);
  if (node) showMenu(e.clientX, e.clientY, nodeMenu(node.id), row);
  else if (tab) showMenu(e.clientX, e.clientY, tabMenu(tab), row);
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

function showInsertLine(el, after, horizontal = false) {
  const line = dropLine();
  if (!line || !el) return;
  const r = el.getBoundingClientRect();
  line.hidden = false;
  if (horizontal) {
    line.className = 'drop-line horizontal';
    line.style.left = (after ? r.right - 1 : r.left - 1) + 'px';
    line.style.top = r.top + 'px';
    line.style.width = '2px';
    line.style.height = r.height + 'px';
  } else {
    line.className = 'drop-line';
    line.style.left = r.left + 'px';
    line.style.width = r.width + 'px';
    line.style.height = '2px';
    line.style.top = (after ? r.bottom - 1 : r.top - 1) + 'px';
  }
}

/** dragover 时用坐标取元素，避免按钮/SVG 干扰 */
function hitEl(e) {
  return document.elementFromPoint(e.clientX, e.clientY) || e.target;
}

/**
 * 返回：
 *   { type:'node', parent, index, el, cls, after?, horizontal? }
 *   { type:'tab-move', index, el, cls, after? }
 *   null
 * index 语义：移动前目标列表中的插入下标（model.move 会自行修正同列表 off-by-one）
 */
function dropTarget(e) {
  if (!drag) return null;
  const under = hitEl(e);
  if (!under || under.closest?.('#menu, #drop-line, .side-footer, #status')) return null;

  // —— 今日区：今日条目上下拖拽排序（同步 order.today，且若本机已打开则联动 chrome.tabs.move）——
  if (under.closest('#tabs-section')) {
    const dragNode = drag.kind === 'node' ? state.nodes[drag.id] : null;
    if (!dragNode || dragNode.type !== 'link') return null;
    const row = under.closest('#tabs .row.tab[data-id]');
    if (row) {
      const targetId = row.dataset.id;
      if (targetId === drag.id) return null;
      const idx = state.order[M.TODAY].indexOf(targetId);
      if (idx === -1) return null;
      const r = row.getBoundingClientRect();
      const after = (e.clientY - r.top) / Math.max(r.height, 1) >= 0.5;
      const dragTab = findTab(dragNode.url);
      const targetNode = state.nodes[targetId];
      const targetTab = targetNode ? findTab(targetNode.url) : null;
      const tabMove =
        dragTab && targetTab
          ? { tabId: dragTab.id, index: after ? targetTab.index + 1 : targetTab.index }
          : null;
      return {
        type: 'node',
        parent: M.TODAY,
        index: idx + (after ? 1 : 0),
        el: row,
        cls: after ? 'drop-after' : 'drop-before',
        after,
        tabMove,
      };
    }
    return { type: 'node', parent: M.TODAY, index: null, el: $('#tabs'), cls: 'drop-zone' };
  }

  const dragNode = drag.kind === 'node' ? state.nodes[drag.id] : null;
  const isFolder = dragNode?.type === 'folder';
  const valid = (parent) =>
    !(isFolder && (parent === M.PINNED || M.isInside(state, parent, drag.id)));

  // folder-well 空白 / 子容器 → 丢进文件夹
  const well = under.closest('.folder-well[data-folder]');
  if (well && !under.closest('.row[data-id], .tile[data-id]')) {
    const id = well.dataset.folder;
    if (drag.kind === 'node' && drag.id === id) return null;
    return valid(id) && { type: 'node', parent: id, index: null, el: well, cls: 'drop-into' };
  }

  const row = under.closest('#saved .row[data-id], #pinned .tile[data-id]');
  if (row) {
    const id = row.dataset.id;
    if (drag.kind === 'node' && id === drag.id) return null;
    const n = state.nodes[id];
    if (!n) return null;
    const r = row.getBoundingClientRect();
    const parent = M.parentOf(state, id);
    const idx = state.order[parent].indexOf(id);

    if (row.classList.contains('tile')) {
      const after = e.clientX > r.left + r.width / 2;
      return valid(parent) && {
        type: 'node',
        parent,
        index: idx + (after ? 1 : 0),
        el: row,
        cls: after ? 'drop-after' : 'drop-before',
        after,
        horizontal: true,
      };
    }

    const ratio = (e.clientY - r.top) / Math.max(r.height, 1);
    // 文件夹中段：拖进；上下沿：在同级重排（避免误触展开动画区域）
    if (n.type === 'folder' && ratio > 0.28 && ratio < 0.72) {
      return valid(id) && { type: 'node', parent: id, index: null, el: row, cls: 'drop-into' };
    }
    const after = ratio >= 0.5;
    return valid(parent) && {
      type: 'node',
      parent,
      index: idx + (after ? 1 : 0),
      el: row,
      cls: after ? 'drop-after' : 'drop-before',
      after,
    };
  }

  if (under.closest('#pinned-section')) {
    return valid(M.PINNED) && { type: 'node', parent: M.PINNED, index: null, el: $('#pinned'), cls: 'drop-zone' };
  }
  if (under.closest('#saved-section')) {
    return { type: 'node', parent: M.ROOT, index: null, el: $('#saved'), cls: 'drop-zone' };
  }
  return null;
}

function markDrop(t) {
  clearDropMarks();
  if (!t) return;
  t.el.classList.add(t.cls);
  if (t.cls === 'drop-before' || t.cls === 'drop-after') {
    showInsertLine(t.el, !!t.after, !!t.horizontal);
  }
}

document.addEventListener('dragstart', (e) => {
  if (e.target.closest('button, input, a, [data-act]')) {
    // 操作按钮不启动拖拽
    e.preventDefault();
    return;
  }
  const { row, node, tab } = targetOf(e);
  if (!row || renaming) return e.preventDefault();
  drag = node ? { kind: 'node', id: node.id } : { kind: 'tab', tab };
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', node?.url || tab?.url || node?.title || 'move');
  try {
    const ghost = row.cloneNode(true);
    ghost.style.width = row.offsetWidth + 'px';
    ghost.style.position = 'absolute';
    ghost.style.top = '-9999px';
    ghost.style.opacity = '0.9';
    document.body.appendChild(ghost);
    e.dataTransfer.setDragImage(ghost, 16, 16);
    setTimeout(() => ghost.remove(), 0);
  } catch (_) {}
  row.classList.add('dragging');
  document.body.classList.add('is-dragging');
  hideMenu();
});

document.addEventListener('dragover', (e) => {
  const t = dropTarget(e);
  if (!t) {
    clearDropMarks();
    return;
  }
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  markDrop(t);
});

document.addEventListener('drop', async (e) => {
  const t = dropTarget(e);
  clearDropMarks();
  if (!t || !drag) return;
  e.preventDefault();
  const d = drag;
  drag = null;
  document.body.classList.remove('is-dragging');

  if (t.type === 'tab-move') {
    try {
      await chrome.tabs.move(d.tab.id, { index: t.index, windowId: winId ?? undefined });
      window.__lastTabMove = { id: d.tab.id, index: t.index }; // e2e 探针
    } catch (err) {
      console.error('tabs.move 失败', err);
    }
    await refreshTabs();
    return;
  }

  // type === 'node'：收藏/置顶/今日移动
  if (d.kind === 'node') {
    if (M.move(state, d.id, t.parent, t.index)) commit({ immediate: true });
    if (t.tabMove) {
      try {
        await chrome.tabs.move(t.tabMove.tabId, { index: t.tabMove.index, windowId: winId ?? undefined });
        window.__lastTabMove = { id: t.tabMove.tabId, index: t.tabMove.index };
      } catch (err) {
        console.error('tabs.move 失败', err);
      }
      await refreshTabs();
    }
  } else if (d.kind === 'tab') {
    saveTab(d.tab, t.parent, t.index);
    store.flush?.();
  }
});

document.addEventListener('dragend', () => {
  drag = null;
  clearDropMarks();
  document.body.classList.remove('is-dragging');
  document.querySelectorAll('.dragging').forEach((x) => x.classList.remove('dragging'));
});

/* ---------- 标签与同步监听 ---------- */

let tabTimer;
function refreshTabsSoon() {
  clearTimeout(tabTimer);
  tabTimer = setTimeout(refreshTabs, 60);
}
async function refreshTabs() {
  tabs = await chrome.tabs.query({});
  if (IS_POPUP || winId == null) {
    winId = await resolveNormalWindowId();
  }
  const res = M.reconcileToday(state, syncableWindowTabs(), tabMap, ignoredTabUrls);
  tabMap = res.tabMap;
  chrome.storage.local.set({ todayTabMap: tabMap });
  if (res.changed) {
    commit();
  } else if (!renaming) {
    render();
  }
}

for (const ev of ['onCreated', 'onRemoved', 'onUpdated', 'onActivated', 'onMoved', 'onAttached', 'onDetached', 'onReplaced']) {
  chrome.tabs[ev].addListener(refreshTabsSoon);
}

let remoteTimer;
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync') return;
  if (changes.meta && store.isOwnChange(changes.meta.newValue)) return;
  clearTimeout(remoteTimer);
  remoteTimer = setTimeout(applyRemote, 150);
});

async function applyRemote() {
  const before = store.lastRev;
  const r = await store.load();
  if (!r.state || r.rev === before) return; // 不完整（等下一批）或没有变化
  state = M.normalize(r.state);
  tabMap = M.syncRemoteToday(state, syncableWindowTabs(), tabMap, ignoredTabUrls);
  chrome.storage.local.set({ todayTabMap: tabMap });
  if (renaming && !state.nodes[renaming]) renaming = null;
  render();
}

function onStatus(s) {
  if (s === 'saved') $('#status').hidden = true;
  else if (s === 'quota') showStatus('同步空间已满（Chrome 限制约 100KB），本次更改只保存在本机。请删掉一些条目。', 'warn');
  else if (s === 'rate') showStatus('写入太频繁，被 Chrome 限流，1 分钟后自动重试同步。', 'warn');
  else if (s === 'error') showStatus('同步失败，更改已保存在本机。', 'warn');
}

async function refreshSettingsUi() {
  const [mode, side] = await Promise.all([
    getCollapseMode(chrome.storage.sync),
    getSidebarSide(chrome.storage.sync),
  ]);
  const uiMode = mode === MODE_ICON_RAIL ? MODE_AUTO : mode;
  document.querySelectorAll('input[name=collapseMode]').forEach((el) => {
    el.checked = el.value === uiMode;
  });
  document.querySelectorAll('input[name=sidebarSide]').forEach((el) => {
    el.checked = el.value === side;
  });
  document.documentElement.dataset.side = side;
  document.documentElement.dataset.collapseStyle = isFullHideMode(mode) ? 'full-hide' : 'icon-rail';
}

function setupChromeUi() {
  const gear = $('#open-settings');
  const pop = $('#settings-pop');

  if (IS_POPUP) {
    document.body.classList.add('is-popup');
    let t;
    window.addEventListener('resize', () => {
      clearTimeout(t);
      t = setTimeout(() => {
        chrome.storage.local.set({
          popupSize: { width: window.outerWidth, height: window.outerHeight },
        });
      }, 280);
    });
  } else if (IS_OVERLAY) {
    document.body.classList.add('is-overlay');
    window.addEventListener('message', (ev) => {
      const d = ev.data;
      if (!d || d.source !== 'arc-sidebar-host' || d.type !== 'state') return;
      document.documentElement.classList.toggle('is-collapsed', !!d.collapsed);
      if (d.mode) document.documentElement.dataset.collapseStyle = d.mode;
      if (d.side) document.documentElement.dataset.side = d.side;
    });
    try {
      window.parent.postMessage({ source: 'arc-sidebar', type: 'ready' }, '*');
    } catch (_) {}
  }

  async function applySideChoice(nextSide) {
    const side = await setSidebarSide(chrome.storage.sync, nextSide);
    await refreshSettingsUi();
    const sideLabel = side === SIDE_RIGHT ? '右侧' : '左侧';
    if (!IS_OVERLAY && !IS_POPUP) {
      chrome.runtime.sendMessage({ type: 'arc-sidebar:activate-auto' }).catch(() => {});
    }
    showStatus(`已切换至网页${sideLabel}`, 'info', 2000);
  }

  if (gear && pop) {
    gear.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const open = pop.hidden;
      pop.hidden = !open;
      if (open) {
        refreshSettingsUi();
        notifyOverlayMenu(true);
        try {
          window.parent.postMessage({ source: 'arc-sidebar', type: 'settings', open: true }, '*');
        } catch (_) {}
      } else {
        notifyOverlayMenu(false);
        try {
          window.parent.postMessage({ source: 'arc-sidebar', type: 'settings', open: false }, '*');
        } catch (_) {}
      }
    });
    pop.addEventListener('click', (e) => e.stopPropagation());
    document.addEventListener('click', () => {
      if (!pop.hidden) {
        pop.hidden = true;
        notifyOverlayMenu(false);
        try {
          window.parent.postMessage({ source: 'arc-sidebar', type: 'settings', open: false }, '*');
        } catch (_) {}
      }
    });
    pop.querySelectorAll('input[name=collapseMode]').forEach((el) => {
      el.addEventListener('change', async () => {
        if (!el.checked) return;
        const mode = await setCollapseMode(chrome.storage.sync, el.value);
        notifyOverlayMenu(false);
        try {
          window.parent.postMessage({ source: 'arc-sidebar', type: 'settings', open: false }, '*');
        } catch (_) {}
        pop.hidden = true;
        if (isOverlayMode(mode) && !IS_OVERLAY) {
          try {
            const res = await chrome.runtime.sendMessage({ type: 'arc-sidebar:activate-auto' });
            if (res && !res.activeInjected) {
              const isFile = String(res.activeUrl || '').startsWith('file:');
              showStatus(
                isFile
                  ? '本地文件页请在 chrome://extensions 详情中开启「允许访问文件网址」以启用贴边收起；其他网页已生效。'
                  : '当前页面受浏览器限制无法贴边；切到普通网页即可自动展开/收起。点扩展图标可在系统侧栏打开。',
                'warn',
                6000,
              );
            } else {
              const label = isFullHideMode(mode) ? '完全隐藏（移到边缘唤出）' : '图标收起（仅显示网页图标）';
              showStatus(`已切换为${label}`, 'info', 3500);
            }
          } catch (_) {
            showStatus('已切换贴边收起模式', 'info', 3500);
          }
        } else {
          const label = isFullHideMode(mode) ? '完全隐藏' : '图标收起';
          showStatus(`已切换为${label}`, 'info', 2000);
        }
      });
    });
    pop.querySelectorAll('input[name=sidebarSide]').forEach((el) => {
      el.addEventListener('change', async () => {
        if (!el.checked) return;
        notifyOverlayMenu(false);
        try {
          window.parent.postMessage({ source: 'arc-sidebar', type: 'settings', open: false }, '*');
        } catch (_) {}
        pop.hidden = true;
        await applySideChoice(el.value);
      });
    });
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && (changes[MODE_KEY] || changes[SIDE_KEY])) {
      refreshSettingsUi();
    }
  });
  refreshSettingsUi();
}

async function init() {
  setupChromeUi();
  let { deviceId, todayTabMap } = await chrome.storage.local.get(['deviceId', 'todayTabMap']);
  if (!deviceId) {
    deviceId = M.newId();
    await chrome.storage.local.set({ deviceId });
  }
  // 启动时立即清除任何旧版遗留的 dismissed:* 脏数据，恢复所有已打开标签显示
  tabMap = M.sanitizeTabMap(todayTabMap);
  await chrome.storage.local.set({ todayTabMap: tabMap });
  store = createStore({ sync: chrome.storage.sync, local: chrome.storage.local, deviceId, onStatus });
  const r = await store.load();
  state = M.normalize(r.state || r.fallback || M.emptyState());
  winId = await resolveNormalWindowId();
  await refreshTabs();
}

window.addEventListener('pagehide', () => store?.flush());

init();
