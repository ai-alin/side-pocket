// 侧栏界面。放在 Chrome 侧边栏里，每个窗口一个。分四块，各读各的数据：
//   置顶、收藏   Chrome 书签（bookmarks.js）；修改发给后台
//   这个窗口     直接读 chrome.tabs，和 Chrome 标签栏一模一样（包括顺序、新标签页、设置页），不加工
//   其他电脑     读 chrome.storage.sync 里别的电脑上传的清单（devices.js），只读
// 置顶 / 收藏和标签的对应关系见 claims.js：只看这个窗口，每个最多认领一个标签，认领后跟着标签走。
// 其他电脑的网页：网址在这个窗口里开着，就标「已开着」。

import * as M from './model.js';
import * as B from './bookmarks.js';
import * as D from './devices.js';
import * as C from './claims.js';

const $ = (sel) => document.querySelector(sel);
const SELF_PREFIX = chrome.runtime.getURL('');
const DEV_COLLAPSE_KEY = 'ui.deviceCollapsed'; // storage.local：{ 设备 id: true }

let state = M.emptyState(); // 置顶和收藏
let v = M.view(state);
let tabs = []; // 所有窗口的标签（不含侧栏自己）
let winTabs = []; // 这个窗口的标签，按标签栏顺序
let winId = null; // 侧栏所在窗口
let winUrls = new Set(); // 这个窗口开着的网址
let claimsRaw = {}; // 这个窗口的认领记录 { 节点 id: 标签 id }
let idx = C.buildIndex([], []); // 置顶 / 收藏 ↔ 这个窗口的标签
let devices = []; // 其他电脑
let selfId = '';
let devCollapsed = {};
let renaming = null; // 正在重命名的收藏 id
let drag = null; // { kind: 'node', id } | { kind: 'tab', tabId } | { kind: 'remote', url, title }
let inflight = 0; // 已在本地生效、后台还没确认的操作数
let stale = false;
let rendering = false;
let syncStatus = 'saved';
let query = ''; // 搜索词
let selected = 0; // 搜索结果里键盘选中的下标
let results = []; // 当前搜索结果

/* ---------- 工具 ---------- */

function favicon(url, size = 32) {
  const u = new URL(chrome.runtime.getURL('/_favicon/'));
  u.searchParams.set('pageUrl', url || 'chrome://newtab/');
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

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function displayTitle(n) {
  return n.title || hostOf(n.url);
}

const tabUrl = (t) => t.url || t.pendingUrl || '';
const tabTitle = (t) => t.title || (tabUrl(t).startsWith('chrome://newtab') ? '新标签页' : tabUrl(t)) || '新标签页';
const isSelf = (t) => tabUrl(t).startsWith(SELF_PREFIX);

/** 置顶 / 收藏对应的标签：{ tab, own } 或 null（own=false 表示点了会认领这个已开着的标签） */
const savedTab = (n) => (n?.type === 'link' ? idx.tabFor(n.id) : null);

/** 置顶 / 收藏：开着 = 点它会切到一个已开着的标签；高亮 = 那个标签就是当前标签 */
function openCls(n) {
  const r = savedTab(n);
  return (r ? ' open' : '') + (r?.tab.active ? ' active' : '');
}

/** 认领的标签已经跳到别的网址时，提示「现在：xxx」 */
function savedTip(n) {
  const r = savedTab(n);
  if (r?.own && M.normUrl(tabUrl(r.tab)) !== M.normUrl(n.url)) return `${n.url}\n现在：${tabTitle(r.tab)}`;
  return n.url;
}

/** 这个窗口里开着这个网址的标签（其他电脑的网页用） */
function findWinTab(url) {
  const u = M.normUrl(url);
  return winTabs.find((t) => t.active && M.normUrl(tabUrl(t)) === u) || winTabs.find((t) => M.normUrl(tabUrl(t)) === u) || null;
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
/** action：{ label, run }，提示右边加一个按钮（比如「撤销」） */
function showStatus(text, kind = 'info', ms = 0, action = null) {
  const s = $('#status');
  clearTimeout(statusTimer);
  s.replaceChildren(el('span', { class: 'status-text' }, text));
  if (action) {
    s.append(
      el('button', { type: 'button', class: 'status-act', onclick: () => { s.hidden = true; action.run(); } }, action.label),
    );
  }
  s.className = 'status' + (kind === 'warn' ? ' warn' : '');
  s.hidden = false;
  if (ms) statusTimer = setTimeout(() => (s.hidden = true), ms);
}

const SYNC_OFF_TIP = '这台电脑开着的网页不会同步到其他电脑（可以在设置里打开）；置顶和收藏存在 Chrome 书签里，不受影响';
const SYNC_MSG = {
  quota: '同步空间不够，这台电脑的网页只同步了一部分。可以在「其他电脑」里移除不再用的旧设备。',
  rate: '写入太频繁，被 Chrome 限流，稍后自动重试。',
  error: '同步失败，稍后自动重试。',
};

function showSync(st) {
  if (!st) return;
  const badge = $('#sync-state');
  badge.textContent = st === 'off' ? '未开启同步' : SYNC_MSG[st] ? '未同步' : '已同步';
  badge.classList.toggle('warn', !!SYNC_MSG[st]);
  badge.classList.toggle('off', st === 'off');
  badge.title = st === 'off' ? SYNC_OFF_TIP : SYNC_MSG[st] || '这台电脑开着的网页已同步到你的 Google 账号；置顶和收藏存在 Chrome 书签里';
  if (st === syncStatus) return;
  syncStatus = st;
  if (SYNC_MSG[st]) showStatus(SYNC_MSG[st], 'warn', 8000);
  else if ($('#status').classList.contains('warn')) $('#status').hidden = true;
}

/* ---------- 数据 ---------- */

/** 置顶和收藏直接读 Chrome 书签（只读，不建文件夹，建由后台负责） */
async function loadSaved() {
  const [d, sync, ids] = await Promise.all([
    chrome.storage.local.get(B.COLLAPSE_KEY),
    chrome.storage.sync.get(B.COLOR_KEY),
    B.resolveRoot(chrome.bookmarks).catch(() => null),
  ]);
  const nodes = await B.loadNodes(chrome.bookmarks, ids, { colors: sync[B.COLOR_KEY], collapsed: d[B.COLLAPSE_KEY] }).catch((e) => {
    console.warn('[side-pocket] 读取书签失败', e);
    return {};
  });
  state = { nodes };
  if (renaming && !state.nodes[renaming]) renaming = null;
}

async function loadDevices() {
  const [all, local] = await Promise.all([chrome.storage.sync.get(null), chrome.storage.local.get(['deviceId', DEV_COLLAPSE_KEY])]);
  selfId = local.deviceId || '';
  devCollapsed = local[DEV_COLLAPSE_KEY] || {};
  devices = D.parseDevices(all, selfId);
}

async function resolveWindowId() {
  try {
    const cur = await chrome.windows.getCurrent();
    if (cur?.id != null) return cur.id;
  } catch (e) {
    console.warn('[side-pocket] 取窗口失败', e);
  }
  return null;
}

/** 这个窗口的标签，和它们的认领记录 */
async function loadTabs() {
  const key = C.keyOf(winId);
  const [all, s] = await Promise.all([chrome.tabs.query({}), chrome.storage.session.get(key)]);
  tabs = all.filter((t) => !isSelf(t));
  winTabs = tabs.filter((t) => t.windowId === winId).sort((a, b) => a.index - b.index);
  winUrls = new Set(winTabs.map((t) => M.normUrl(tabUrl(t))));
  claimsRaw = s[key] || {};
}

// 哪几块数据变了，下次刷新只重新读这几块：标签一直在变，不用每次都重读书签和其他电脑的清单
const PARTS = ['tabs', 'saved', 'devices'];
const dirty = new Set(PARTS);
const LOADERS = { tabs: loadTabs, saved: loadSaved, devices: loadDevices };

/** force：侧栏暂时看不见时也刷新（第一次加载） */
async function refresh({ force = false } = {}) {
  if (inflight || (document.hidden && !force)) {
    stale = true;
    return;
  }
  stale = false;
  const need = [...dirty];
  dirty.clear();
  try {
    if (winId == null) winId = await resolveWindowId();
    await Promise.all(need.map((k) => LOADERS[k]()));
  } catch (e) {
    need.forEach((k) => dirty.add(k)); // 没读成的下次再读
    throw e;
  }
  render();
}

let refreshTimer;
/** parts：哪几块变了（'tabs' | 'saved' | 'devices'），不给就是全部 */
function refreshSoon(parts = PARTS, ms = 60) {
  for (const k of [].concat(parts)) dirty.add(k);
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refresh, ms);
}

/** 先在本地副本上执行（立即显示），再交给后台执行（权威结果）；返回后台的执行结果 */
async function op(name, args = {}) {
  try {
    M.applyOp(state, name, args);
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
    if (!inflight) {
      PARTS.forEach((k) => dirty.add(k));
      refresh();
    }
  }
}

function buildIdx() {
  const links = Object.values(state.nodes).filter((n) => n.type === 'link');
  idx = C.buildIndex(links, winTabs, claimsRaw);
}

/** 记下「这个标签归这个置顶 / 收藏」。由后台排队写，和后台自己处理的标签事件不会互相盖掉 */
async function claimTab(nid, tid) {
  claimsRaw = C.claim(claimsRaw, nid, tid);
  const r = await chrome.runtime.sendMessage({ type: 'side-pocket:claim', winId, nid, tid }).catch(() => null);
  if (r?.ok && r.result) {
    claimsRaw = r.result;
    return;
  }
  // 后台没接住：自己写
  const key = C.keyOf(winId);
  const cur = (await chrome.storage.session.get(key))[key] || {};
  claimsRaw = C.claim(cur, nid, tid);
  await chrome.storage.session.set({ [key]: claimsRaw });
}

/**
 * 点置顶 / 收藏：有自己的标签 → 切过去；没有 → 认领这个窗口里匹配的已开标签；都没有 → 在这个窗口新开并认领。
 * 已经在它的标签上时不动（想回到原网址用右键菜单）。
 */
async function openSaved(n) {
  const r = savedTab(n);
  if (r) {
    if (!r.own) await claimTab(n.id, r.tab.id);
    if (!r.tab.active) await activateTab(r.tab);
    else refreshSoon('tabs');
    return;
  }
  const t = await chrome.tabs.create({ url: n.url, windowId: winId ?? undefined, active: true });
  await claimTab(n.id, t.id);
}

/** 右键「回到原网址」：让它的标签重新打开置顶 / 收藏的网址 */
async function backToOrigin(n) {
  const r = savedTab(n);
  if (!r) return openSaved(n);
  if (!r.own) await claimTab(n.id, r.tab.id);
  await chrome.tabs.update(r.tab.id, { url: n.url, active: true });
}

/** 打开网址（其他电脑的网页）：这个窗口已经开着就切过去，否则在这个窗口新开 */
async function openUrl(url) {
  const t = findWinTab(url);
  if (t) return activateTab(t);
  await chrome.tabs.create({ url, windowId: winId ?? undefined });
}

async function activateTab(t) {
  await chrome.tabs.update(t.id, { active: true });
}

/** 把一个网页存进收藏 / 置顶（已收藏过的网址会挪过去，不重复建） */
function saveUrl(url, title, parent = M.ROOT, index) {
  if (!/^(https?|file|ftp|chrome):/i.test(url || '')) return showStatus('这个网页不能收藏', 'warn', 2500);
  return op('saveTab', { url, title, parent, index });
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

/** 删除置顶 / 收藏 / 文件夹，删完给几秒钟可以撤销 */
async function removeSaved(id) {
  const n = state.nodes[id];
  if (!n) return;
  const count = n.type === 'folder' ? M.countDescendants(v, id) : 0;
  const what = n.type === 'folder' ? `文件夹「${displayTitle(n)}」${count ? `（含 ${count} 项）` : ''}` : `「${displayTitle(n)}」`;
  const ok = await op('remove', { id });
  if (!ok) return;
  showStatus(`已删除${what}`, 'info', 8000, {
    label: '撤销',
    run: async () => {
      const back = await op('undoRemove');
      if (!back) showStatus('撤销不了了，这一项已经删掉', 'warn', 3000);
    },
  });
}

/* ---------- 渲染 ---------- */

function render() {
  v = M.view(state);
  buildIdx();
  const old = document.querySelector('input.rename');
  const draft = old && old.dataset.id === renaming ? { value: old.value, start: old.selectionStart, end: old.selectionEnd } : null;
  rendering = true;
  try {
    const searching = !!query;
    $('#browse').hidden = searching;
    $('#results-section').hidden = !searching;
    if (searching) renderResults();
    else {
      renderPinned();
      renderSaved();
      renderWindow();
      renderDevices();
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
// 同一个条目（data-id / data-folder / data-tab / data-remote / data-device）复用原来的元素，
// 网站图标不会重新加载，鼠标下面的那一行也不会闪；拖拽中的元素也不会被换掉。

const KEY_ATTRS = ['data-id', 'data-folder', 'data-tab', 'data-remote', 'data-device'];

function keyOf(n) {
  if (n.nodeType !== 1) return null;
  for (const a of KEY_ATTRS) {
    const id = n.getAttribute(a);
    if (id != null) return n.nodeName + '#' + a + '#' + id;
  }
  return null;
}

/** 输入框（重命名、设备名）不复用：它带着自己的事件和草稿 */
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
        { class: 'tile' + openCls(n), title: savedTip(n) === n.url ? displayTitle(n) : `${displayTitle(n)}\n现在：${tabTitle(savedTab(n).tab)}`, draggable: 'true', 'data-id': id, role: 'button', tabindex: '0' },
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
      if (savedTab(n)) open++;
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
  if (!rows.length) rows.push(el('div', { class: 'empty' }, '还没有收藏。把下面的网页拖到这里。'));
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
  const open = !!savedTab(n);
  return el(
    'div',
    { class: 'row link' + openCls(n), draggable: 'true', 'data-id': n.id, title: savedTip(n) },
    favImg(n.url, 'fav'),
    titleNode(n),
    el(
      'span',
      { class: 'actions' },
      open ? actBtn('close-tab', '关闭标签（保留在收藏里）', SVG.x) : null,
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

/** 这个窗口：和 Chrome 标签栏一模一样，一个标签一行 */
function tabRow(t) {
  const url = tabUrl(t);
  const web = /^(https?|file|ftp):/i.test(url);
  const owner = state.nodes[idx.ownerOf(t.id)];
  return el(
    'div',
    {
      class: 'row tab open' + (t.active ? ' active' : ''),
      draggable: 'true',
      'data-tab': String(t.id),
      title: owner ? `${url}\n属于${v.parent[owner.id] === M.PINNED ? '置顶' : '收藏'}「${displayTitle(owner)}」` : url,
    },
    favImg(url, 'fav'),
    owner ? svgIcon(SVG.pin, 'claim-ico') : null,
    el('span', { class: 'title' }, tabTitle(t)),
    el(
      'span',
      { class: 'actions' },
      web ? actBtn('save', '收藏', SVG.save) : null,
      web ? actBtn('pin', '置顶', SVG.pin) : null,
      actBtn('close', '关闭标签', SVG.x),
    ),
  );
}

function renderWindow() {
  $('#tab-count').textContent = winTabs.length ? String(winTabs.length) : '';
  patchChildren($('#tabs'), winTabs.map(tabRow));
}

function remoteRow(dev, i) {
  const t = dev.tabs[i];
  const open = winUrls.has(M.normUrl(t.url));
  return el(
    'div',
    { class: 'row remote' + (open ? ' local-open' : ''), draggable: 'true', 'data-remote': `${dev.id}|${i}`, title: t.url },
    favImg(t.url, 'fav'),
    el('span', { class: 'title' }, t.title || hostOf(t.url)),
    open ? el('span', { class: 'tag' }, '已开着') : null,
    el('span', { class: 'actions' }, actBtn('save', '收藏', SVG.save), actBtn('pin', '置顶', SVG.pin)),
  );
}

/** 其他电脑：按设备分组，只读；点一下在这台电脑打开 */
function renderDevices() {
  const out = [];
  for (const dev of devices) {
    const collapsed = !!devCollapsed[dev.id];
    out.push(
      el(
        'div',
        { class: 'row device-head' + (collapsed ? ' is-collapsed' : ''), 'data-device': dev.id, title: `${dev.name}：最后更新 ${new Date(dev.at).toLocaleString()}` },
        svgIcon(SVG.caret, 'caret'),
        el('span', { class: 'title' }, dev.name),
        el('span', { class: 'when' }, D.relTime(dev.at)),
        el('span', { class: 'cnt' }, el('span', { class: 'n' }, String(dev.tabs.length))),
        el('span', { class: 'actions' }, actBtn('device-menu', '更多', SVG.more)),
      ),
    );
    if (collapsed) continue;
    dev.tabs.forEach((_, i) => out.push(remoteRow(dev, i)));
    if (!dev.tabs.length) out.push(el('div', { class: 'empty', 'data-device': dev.id + '-empty' }, '这台电脑现在没有开着的网页'));
    if (dev.skipped) out.push(el('div', { class: 'empty', 'data-device': dev.id + '-more' }, `还有 ${dev.skipped} 个网页太多没同步过来`));
  }
  if (!devices.length) out.push(el('div', { class: 'empty' }, '在另一台电脑的 Chrome 里装上 Side Pocket，它开着的网页会出现在这里'));
  patchChildren($('#devices'), out);
}

/* ---------- 搜索 ---------- */

/** 收藏所在位置，显示在搜索结果右侧 */
function whereOf(id) {
  const names = [];
  let p = v.parent[id];
  while (state.nodes[p]?.type === 'folder') {
    names.unshift(state.nodes[p].title);
    p = v.parent[p];
  }
  if (p === M.PINNED) return '置顶';
  return names.length ? names.join(' / ') : '收藏';
}

function renderResults() {
  const q = query.toLowerCase();
  const hit = (title, url) => (title || '').toLowerCase().includes(q) || (url || '').toLowerCase().includes(q);
  const all = [];
  for (const t of winTabs) if (hit(tabTitle(t), tabUrl(t))) all.push({ attr: { 'data-tab': String(t.id) }, url: tabUrl(t), title: tabTitle(t), where: '这个窗口', rank: 0 });
  for (const n of Object.values(state.nodes)) {
    if (n.type === 'link' && hit(n.title, n.url)) all.push({ attr: { 'data-id': n.id }, url: n.url, title: displayTitle(n), where: whereOf(n.id), rank: 1 });
  }
  for (const dev of devices) {
    dev.tabs.forEach((t, i) => {
      if (hit(t.title, t.url)) all.push({ attr: { 'data-remote': `${dev.id}|${i}` }, url: t.url, title: t.title || hostOf(t.url), where: dev.name, rank: 2 });
    });
  }
  // 标题命中优先，其次本窗口 → 收藏 → 其他电脑
  const tHit = (r) => (r.title.toLowerCase().includes(q) ? 0 : 1);
  results = all.sort((a, b) => tHit(a) - tHit(b) || a.rank - b.rank).slice(0, 60);
  selected = Math.min(selected, Math.max(results.length - 1, 0));
  $('#result-count').textContent = results.length ? String(results.length) : '';
  const rows = results.map((r, i) =>
    el(
      'div',
      { class: 'row link' + (r.rank === 1 ? openCls(state.nodes[r.attr['data-id']]) : r.rank === 2 && winUrls.has(M.normUrl(r.url)) ? ' open' : '') + (i === selected ? ' selected' : ''), title: r.url, ...r.attr },
      favImg(r.url, 'fav'),
      el('span', { class: 'title' }, r.title),
      el('span', { class: 'where' }, r.where),
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
      { label: count ? `删除文件夹（含 ${count} 项）` : '删除文件夹', danger: true, run: () => removeSaved(id) },
    ];
  }
  const r = savedTab(n);
  const moved = r?.own && M.normUrl(tabUrl(r.tab)) !== M.normUrl(n.url);
  const items = [
    { label: r ? '切换到该标签' : '打开', run: () => openSaved(n) },
    { label: '重命名', run: () => startRename(id) },
    moved ? { label: '回到原网址', run: () => backToOrigin(n) } : null,
    { label: '复制链接', run: () => copyText(n.url) },
    parent === M.PINNED ? { label: '取消置顶', run: () => op('unpin', { id }) } : { label: '置顶', run: () => op('pin', { id }) },
  ];
  if (parent !== M.PINNED) items.push({ label: '新建文件夹', run: () => newFolder(parent, after()) });
  if (r) items.push({ label: '关闭标签', run: () => chrome.tabs.remove(r.tab.id) });
  items.push('-', { label: '删除', danger: true, run: () => removeSaved(id) });
  return items.filter(Boolean);
}

function tabMenu(t) {
  const url = tabUrl(t);
  const items = [];
  if (!t.active) items.push({ label: '切换到该标签', run: () => activateTab(t) });
  if (/^(https?|file|ftp):/i.test(url)) {
    items.push({ label: '收藏', run: () => saveUrl(url, t.title) }, { label: '置顶', run: () => saveUrl(url, t.title, M.PINNED) });
  }
  items.push({ label: '复制链接', run: () => copyText(url) }, '-', { label: '关闭标签', danger: true, run: () => chrome.tabs.remove(t.id) });
  return items;
}

function remoteMenu(r) {
  const open = winUrls.has(M.normUrl(r.url));
  return [
    { label: open ? '切换到该标签' : '在这台电脑打开', run: () => openUrl(r.url) },
    { label: '收藏', run: () => saveUrl(r.url, r.title) },
    { label: '置顶', run: () => saveUrl(r.url, r.title, M.PINNED) },
    { label: '复制链接', run: () => copyText(r.url) },
  ];
}

function deviceMenu(dev) {
  return [
    { heading: `${dev.name} · 最后更新 ${D.relTime(dev.at)}` },
    {
      label: '移除这台设备',
      danger: true,
      run: async () => {
        await op('removeDevice', { id: dev.id });
        showStatus(`已移除「${dev.name}」。如果它还在用，下次有变化时会重新出现。`, 'info', 4000);
      },
    },
  ];
}

/* ---------- 交互事件 ---------- */

/** 点到的是哪一行：{ kind: 'node' | 'tab' | 'remote' | 'device', row, ... } */
function targetOf(e) {
  const row = e.target.closest?.('[data-id], [data-tab], [data-remote], [data-device]');
  if (!row) return {};
  if (row.dataset.id != null) {
    const node = state.nodes[row.dataset.id];
    return node ? { kind: 'node', row, node } : {};
  }
  if (row.dataset.tab != null) {
    const tab = tabs.find((t) => String(t.id) === row.dataset.tab);
    return tab ? { kind: 'tab', row, tab } : {};
  }
  if (row.dataset.remote != null) {
    const [id, i] = row.dataset.remote.split('|');
    const r = devices.find((d) => d.id === id)?.tabs[Number(i)];
    return r ? { kind: 'remote', row, remote: r } : {};
  }
  const dev = devices.find((d) => d.id === row.dataset.device);
  return dev ? { kind: 'device', row, dev } : {};
}

function toggleDevice(id) {
  devCollapsed = { ...devCollapsed, [id]: !devCollapsed[id] };
  if (!devCollapsed[id]) delete devCollapsed[id];
  chrome.storage.local.set({ [DEV_COLLAPSE_KEY]: devCollapsed });
  render();
}

document.addEventListener('click', (e) => {
  if (!e.target.closest('#menu')) hideMenu();
  if (e.target.closest('input.rename, #settings-pop')) return;
  if (e.target.closest('#new-folder')) return newFolder();
  if (e.target.closest('#new-tab')) return chrome.tabs.create({ windowId: winId ?? undefined });
  if (e.target.closest('#toggle-collapse')) return closeSidePanel();
  const t = targetOf(e);
  if (!t.kind) return;
  const act = e.target.closest('[data-act]')?.dataset.act;
  const menuAt = (items) => {
    const r = e.target.getBoundingClientRect();
    showMenu(r.left, r.bottom + 2, items, t.row);
  };
  if (t.kind === 'device') return act === 'device-menu' ? menuAt(deviceMenu(t.dev)) : toggleDevice(t.dev.id);
  if (t.kind === 'tab') {
    const url = tabUrl(t.tab);
    if (act === 'save') return saveUrl(url, t.tab.title);
    if (act === 'pin') return saveUrl(url, t.tab.title, M.PINNED);
    if (act === 'close') return chrome.tabs.remove(t.tab.id);
    return activateTab(t.tab);
  }
  if (t.kind === 'remote') {
    if (act === 'save') return saveUrl(t.remote.url, t.remote.title);
    if (act === 'pin') return saveUrl(t.remote.url, t.remote.title, M.PINNED);
    return openUrl(t.remote.url);
  }
  const node = t.node;
  if (act === 'menu') return menuAt(nodeMenu(node.id));
  if (act === 'close-tab') {
    const x = savedTab(node);
    if (x) chrome.tabs.remove(x.tab.id);
    return;
  }
  if (node.type === 'folder') return op('setCollapsed', { id: node.id, collapsed: !node.collapsed });
  return openSaved(node);
});

document.addEventListener('contextmenu', (e) => {
  if (e.target.closest('input')) return;
  e.preventDefault();
  const t = targetOf(e);
  const at = (items) => showMenu(e.clientX, e.clientY, items, t.row);
  if (t.kind === 'node') at(nodeMenu(t.node.id));
  else if (t.kind === 'tab') at(tabMenu(t.tab));
  else if (t.kind === 'remote') at(remoteMenu(t.remote));
  else if (t.kind === 'device') at(deviceMenu(t.dev));
  else if (e.target.closest('#saved-section')) showMenu(e.clientX, e.clientY, [{ label: '新建文件夹', run: () => newFolder() }]);
  else hideMenu();
});

document.addEventListener('keydown', (e) => e.key === 'Escape' && hideMenu());

/** 搜索结果里按回车 */
function openResult(r) {
  const tid = r.attr['data-tab'];
  if (tid != null) {
    const t = tabs.find((x) => String(x.id) === tid);
    if (t) return activateTab(t);
  }
  const nid = r.attr['data-id'];
  if (nid != null && state.nodes[nid]) return openSaved(state.nodes[nid]);
  return openUrl(r.url);
}

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
    openResult(results[selected]);
  }
});
window.addEventListener('blur', hideMenu);

/* ---------- 拖拽 ---------- */
// 收藏 ↔ 收藏：移动书签；标签 / 其他电脑的网页 → 收藏、置顶：新建书签（标签照常开着）；
// 这个窗口里上下拖：移动真实标签；收藏 / 其他电脑的网页 → 这个窗口：在那个位置打开。

const dropLine = () => $('#drop-line');

function clearDropMarks() {
  document.querySelectorAll('.drop-before, .drop-after, .drop-into, .drop-zone').forEach((x) => x.classList.remove('drop-before', 'drop-after', 'drop-into', 'drop-zone'));
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

/** 正在拖的东西是网址（标签、其他电脑的网页、收藏里的链接）时返回 { url, title } */
function dragLink() {
  if (!drag) return null;
  if (drag.kind === 'remote') return { url: drag.url, title: drag.title };
  if (drag.kind === 'tab') {
    const t = tabs.find((x) => x.id === drag.tabId);
    return t ? { url: tabUrl(t), title: t.title } : null;
  }
  const n = state.nodes[drag.id];
  return n?.type === 'link' ? { url: n.url, title: n.title } : null;
}

/**
 * 返回放下的位置或 null：
 *   { zone: 'window', index: Chrome 标签下标（null = 末尾）, el, cls, after? }
 *   { zone: 'saved', parent, index: 移动前目标列表里的下标, el, cls, after?, horizontal? }
 */
function dropTarget(e) {
  if (!drag) return null;
  const under = document.elementFromPoint(e.clientX, e.clientY) || e.target;
  if (!under || under.closest?.('#menu, #drop-line, .side-footer, #status, #devices-section')) return null;
  const link = dragLink();
  const dragNode = drag.kind === 'node' ? state.nodes[drag.id] : null;
  const isFolder = dragNode?.type === 'folder';

  // 这个窗口
  if (under.closest('#window-section')) {
    if (!link) return null;
    if (drag.kind === 'tab' && !tabs.find((t) => t.id === drag.tabId && t.windowId === winId)) return null;
    const row = under.closest('#tabs .row.tab[data-tab]');
    if (!row) return { zone: 'window', index: null, el: $('#tabs'), cls: 'drop-zone' };
    const target = winTabs.find((t) => String(t.id) === row.dataset.tab);
    if (!target || (drag.kind === 'tab' && target.id === drag.tabId)) return null;
    const r = row.getBoundingClientRect();
    const after = (e.clientY - r.top) / Math.max(r.height, 1) >= 0.5;
    return { zone: 'window', index: target.index + (after ? 1 : 0), el: row, cls: after ? 'drop-after' : 'drop-before', after };
  }

  if (drag.kind !== 'node' && !link) return null;
  const valid = (parent) => !(isFolder && (parent === M.PINNED || M.isInside(v, parent, drag.id)));
  const self = (id) => drag.kind === 'node' && id === drag.id;

  // 文件夹的空白处 / 子容器 → 放进文件夹
  const well = under.closest('.folder-well[data-folder]');
  if (well && !under.closest('.row[data-id], .tile[data-id]')) {
    const id = well.dataset.folder;
    if (self(id)) return null;
    return valid(id) ? { zone: 'saved', parent: id, index: null, el: well, cls: 'drop-into' } : null;
  }

  const row = under.closest('#saved .row[data-id], #pinned .tile[data-id]');
  if (row) {
    const id = row.dataset.id;
    const n = state.nodes[id];
    if (self(id) || !n) return null;
    const r = row.getBoundingClientRect();
    const parent = v.parent[id];
    const idx = v.order[parent].indexOf(id);
    if (row.classList.contains('tile')) {
      if (isFolder) return null;
      const after = e.clientX > r.left + r.width / 2;
      return { zone: 'saved', parent, index: idx + (after ? 1 : 0), el: row, cls: after ? 'drop-after' : 'drop-before', after, horizontal: true };
    }
    const ratio = (e.clientY - r.top) / Math.max(r.height, 1);
    // 文件夹中段：放进去；上下沿：同级重排
    if (n.type === 'folder' && ratio > 0.28 && ratio < 0.72) {
      return valid(id) ? { zone: 'saved', parent: id, index: null, el: row, cls: 'drop-into' } : null;
    }
    const after = ratio >= 0.5;
    return valid(parent) ? { zone: 'saved', parent, index: idx + (after ? 1 : 0), el: row, cls: after ? 'drop-after' : 'drop-before', after } : null;
  }

  if (under.closest('#pinned-section')) {
    return valid(M.PINNED) ? { zone: 'saved', parent: M.PINNED, index: null, el: $('#pinned'), cls: 'drop-zone' } : null;
  }
  if (under.closest('#saved-section')) return { zone: 'saved', parent: M.ROOT, index: null, el: $('#saved'), cls: 'drop-zone' };
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
  const t = targetOf(e);
  if (!t.kind || t.kind === 'device' || renaming) return e.preventDefault();
  let text = '';
  if (t.kind === 'node') {
    drag = { kind: 'node', id: t.node.id };
    text = t.node.url || t.node.title;
  } else if (t.kind === 'tab') {
    drag = { kind: 'tab', tabId: t.tab.id };
    text = tabUrl(t.tab);
  } else {
    drag = { kind: 'remote', url: t.remote.url, title: t.remote.title };
    text = t.remote.url;
  }
  e.dataTransfer.effectAllowed = 'copyMove';
  e.dataTransfer.setData('text/plain', text || 'move');
  const row = t.row;
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
  e.dataTransfer.dropEffect = drag.kind === 'node' && t.zone === 'saved' ? 'move' : 'copy';
  markDrop(t);
});

document.addEventListener('drop', async (e) => {
  const t = dropTarget(e);
  clearDropMarks();
  if (!t || !drag) return;
  e.preventDefault();
  const d = drag;
  const link = dragLink();
  drag = null;
  document.body.classList.remove('is-dragging');
  try {
    if (t.zone === 'saved') {
      if (d.kind === 'node') op('move', { id: d.id, parent: t.parent, index: t.index });
      else saveUrl(link.url, link.title, t.parent, t.index);
    } else if (d.kind === 'tab') {
      const cur = winTabs.find((x) => x.id === d.tabId);
      let index = t.index ?? -1;
      if (index >= 0 && cur && cur.index < index) index -= 1; // tabs.move 的 index 是移动后的位置
      await chrome.tabs.move(d.tabId, { index, windowId: winId });
    } else {
      await chrome.tabs.create({ url: link.url, windowId: winId ?? undefined, index: t.index ?? undefined, active: true });
    }
  } catch (err) {
    console.warn('[side-pocket] 拖拽操作失败', err);
    showStatus('操作失败：' + (err?.message || err), 'warn', 3000);
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
  chrome.tabs[ev].addListener(() => refreshSoon('tabs'));
}

// 书签变了（包括在 Chrome 书签管理器里改的、从别的电脑同步来的）
for (const ev of ['onCreated', 'onRemoved', 'onChanged', 'onMoved', 'onChildrenReordered', 'onImportEnded']) {
  chrome.bookmarks[ev]?.addListener(() => refreshSoon('saved'));
}

chrome.storage.onChanged.addListener((changes, area) => {
  const keys = Object.keys(changes);
  if (area === 'sync' && keys.includes(B.COLOR_KEY)) refreshSoon('saved', 150);
  if (area === 'sync' && keys.some((k) => k.startsWith(D.META) || k.startsWith(D.CHUNK))) refreshSoon('devices', 150);
  if (area === 'local' && changes[B.COLLAPSE_KEY]) refreshSoon('saved');
});

chrome.storage.session.onChanged.addListener((changes) => {
  if (winId != null && changes[C.keyOf(winId)]) refreshSoon('tabs', 30);
  if (changes[D.VIEW_KEY]) showSync(changes[D.VIEW_KEY].newValue?.status);
});

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && stale) refresh();
});

// 「3 分钟前」这类时间每分钟更新一次
setInterval(() => {
  if (!document.hidden && !query && devices.length && !drag) renderDevices();
}, 60e3);

/* ---------- 设置 ---------- */

/** 设置里显示当前快捷键和这台电脑的名字 */
async function refreshSettingsUi() {
  const [cmds, info] = await Promise.all([
    chrome.commands.getAll().catch(() => []),
    chrome.runtime.sendMessage({ type: 'side-pocket:info' }).catch(() => null),
  ]);
  const key = cmds.find((c) => c.name === '_execute_action')?.shortcut || '';
  const k = $('#shortcut-key');
  k.textContent = key || '未设置';
  k.classList.toggle('warn', !key);
  $('#shortcut-hint').hidden = !!key;
  const input = $('#device-name');
  if (document.activeElement !== input && info?.ok) input.value = info.result.name;
  if (info?.ok) $('#share-tabs').checked = info.result.share !== false;
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

  const nameInput = $('#device-name');
  let lastName = null;
  const saveName = async () => {
    const name = nameInput.value.trim();
    if (name === lastName) return;
    lastName = name;
    const r = await chrome.runtime.sendMessage({ type: 'side-pocket:op', op: 'setDeviceName', args: { name } }).catch(() => null);
    if (r?.ok) {
      nameInput.value = r.result;
      lastName = r.result;
      showStatus(`这台电脑叫「${r.result}」，其他电脑上会这样显示`, 'info', 2500);
    }
  };
  nameInput.addEventListener('focus', () => (lastName = nameInput.value.trim()));
  nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') nameInput.blur();
    e.stopPropagation();
  });
  nameInput.addEventListener('blur', saveName);

  // 关掉后：这台电脑开着的网页不再上传，已经上传的清单从同步存储里删掉；别的电脑的清单照常能看
  const share = $('#share-tabs');
  share.addEventListener('change', async () => {
    const on = share.checked;
    const r = await chrome.runtime.sendMessage({ type: 'side-pocket:op', op: 'setShare', args: { on } }).catch(() => null);
    if (!r?.ok) {
      share.checked = !on;
      return showStatus('没改成：' + (r?.error || '后台没有响应'), 'warn', 3000);
    }
    showStatus(on ? '已打开：这台电脑开着的网页会出现在你其他电脑的侧栏里' : '已关闭：这台电脑的网页清单已从同步里删掉', 'info', 3500);
  });

  // 从设置页改完回来，侧栏重新拿到焦点时更新显示
  window.addEventListener('focus', () => !pop.hidden && refreshSettingsUi());
}

async function init() {
  setupChromeUi();
  const s = await chrome.storage.session.get(D.VIEW_KEY);
  showSync(s[D.VIEW_KEY]?.status);
  await refresh({ force: true });
}

init();
