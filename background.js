// 后台 service worker：唯一负责数据的地方。
// - 标签事件 → 「今日」对账；远端变更 → 合并、处处关闭；侧栏发来的操作 → 执行。
// - 所有读写走一个串行队列，避免交错。
// - 改动先存 storage.local（立即生效），再合并成批写入 storage.sync（节流，避免被 Chrome 限流）。
// 侧栏（无论开了多少个）只负责显示，不再各自对账、各自写云端。
// 0.9.0 起收藏和置顶存在 Chrome 书签里（见 bookmarks.js），这里的 engine 只管「今日」。

import * as M from './model.js';
import * as B from './bookmarks.js';
import { createEngine, VIEW_KEY } from './store.js';

const SELF_PREFIX = chrome.runtime.getURL('');
const BIND_KEY = 'tabBindings'; // storage.session：tabId -> 今日条目，浏览器重启即清空（tab id 也会变）
const FLUSH_ALARM = 'side-pocket-flush';
const LEGACY_FLUSH_ALARM = 'arc-flush'; // 0.7.x 及以前的闹钟名，改名时可能还有一个没触发
const BACKUP_KEY = 'backup.beforeBookmarks'; // storage.local：迁移到书签前的完整旧数据，出问题时可以恢复
const RECONCILE_DELAY = 400;
const FLUSH_DELAY = 1500;
const FLUSH_GAP = 3000;

let engine = null;
let ready = null;
let bindings = {};
let status = 'saved';
let published = { version: -1, status: null };
const closing = new Set(); // 正在被本扩展关闭的 tabId
let chain = Promise.resolve();
const bm = chrome.bookmarks;
let ids = null; // { root, pinned }：书签里 Side Pocket 和置顶文件夹的 id
let saved = {}; // 书签换算成的侧栏节点（收藏和置顶）
let savedUrls = new Set();

const isSelf = (t) => (t.url || t.pendingUrl || '').startsWith(SELF_PREFIX);

/* ---------- 串行队列 ---------- */

function run(fn) {
  const p = chain.then(async () => {
    await ensureReady();
    const out = await fn();
    await publish();
    return out;
  });
  chain = p.catch((e) => console.error('[side-pocket]', e));
  return p;
}

async function ensureReady() {
  if (!ready) {
    ready = init().catch((e) => {
      ready = null;
      throw e;
    });
  }
  await ready;
}

async function init() {
  let { deviceId } = await chrome.storage.local.get('deviceId');
  if (!deviceId) {
    deviceId = M.newId();
    await chrome.storage.local.set({ deviceId });
  }
  engine = createEngine({
    sync: chrome.storage.sync,
    local: chrome.storage.local,
    deviceId,
    onStatus: (k) => {
      status = k;
    },
  });
  bindings = (await chrome.storage.session.get(BIND_KEY))[BIND_KEY] || {};
  const res = await engine.init();
  await reloadSaved();
  // 搬家失败不能拖垮「今日」：旧数据还在原处、也有备份，下次启动再试
  await absorbLegacy().catch((e) => console.error('[side-pocket] 收藏搬进书签失败', e));
  await closeTabsFor(res.closed);
  await reconcileNow();
  scheduleFlush();
}

/** 通知侧栏重新读取（只在数据或同步状态变化时） */
async function publish() {
  if (!engine) return;
  if (engine.version === published.version && status === published.status) return;
  published = { version: engine.version, status };
  await chrome.storage.session.set({ [VIEW_KEY]: { at: Date.now(), status } });
}

/** 本机开着的标签占着的今日条目 id */
function boundIds(tabs) {
  const out = new Set();
  for (const t of tabs) {
    const bd = bindings[String(t.id)];
    if (bd?.id) out.add(bd.id);
  }
  return [...out];
}

async function saveBindings(next) {
  if (JSON.stringify(next) === JSON.stringify(bindings)) return;
  bindings = next;
  await chrome.storage.session.set({ [BIND_KEY]: bindings });
}

/* ---------- 收藏和置顶（Chrome 书签） ---------- */

const isSaved = (id) => typeof id === 'string' && id.startsWith('bkm');

/** 重新读取书签；Side Pocket 文件夹被删掉了就重新建一个空的 */
async function reloadSaved() {
  ids = await B.resolveRoot(bm, { create: true });
  saved = await B.loadNodes(bm, ids);
  savedUrls = B.urlSet(saved);
}

/**
 * 把旧格式里不在今日的节点（收藏、置顶）搬进书签，再从旧存储里删掉。
 * 升级到 0.9.0 时执行一次；以后没升级的旧版设备又写回来旧格式的收藏时，也会被搬过来。
 * 搬之前把完整旧数据备份在本机。
 */
async function absorbLegacy() {
  const v = M.view(engine.state);
  if (!Object.keys(engine.state.nodes).some((id) => v.parent[id] !== M.TODAY)) return;
  if (!(await chrome.storage.local.get(BACKUP_KEY))[BACKUP_KEY]) {
    await chrome.storage.local.set({ [BACKUP_KEY]: { at: Date.now(), nodes: engine.state.nodes } });
  }
  const r = await B.importNodes(bm, ids, engine.state.nodes);
  if (Object.keys(r.colors).length) {
    const cur = (await chrome.storage.sync.get(B.COLOR_KEY))[B.COLOR_KEY] || {};
    await chrome.storage.sync.set({ [B.COLOR_KEY]: { ...r.colors, ...cur } });
  }
  if (Object.keys(r.collapsed).length) {
    const cur = (await chrome.storage.local.get(B.COLLAPSE_KEY))[B.COLLAPSE_KEY] || {};
    await chrome.storage.local.set({ [B.COLLAPSE_KEY]: { ...cur, ...r.collapsed } });
  }
  await engine.apply((s) => {
    for (const id of r.drop) M.remove(s, id);
  });
  await reloadSaved();
  scheduleFlush();
}

async function getColors() {
  return (await chrome.storage.sync.get(B.COLOR_KEY))[B.COLOR_KEY] || {};
}

async function setFolderColor(id, color) {
  const n = saved[id];
  if (n?.type !== 'folder') return false;
  const cur = await getColors();
  if (M.FOLDER_COLORS.includes(color)) cur[n.path] = color;
  else delete cur[n.path];
  await chrome.storage.sync.set({ [B.COLOR_KEY]: cur });
  return true;
}

async function setFolderCollapsed(id, on) {
  if (saved[id]?.type !== 'folder') return false;
  const cur = (await chrome.storage.local.get(B.COLLAPSE_KEY))[B.COLLAPSE_KEY] || {};
  if (on) cur[id] = true;
  else delete cur[id];
  await chrome.storage.local.set({ [B.COLLAPSE_KEY]: cur });
  return true;
}

/** 涉及收藏 / 置顶的操作：改书签；今日 ↔ 收藏之间的移动同时改今日 */
async function savedOp(op, a) {
  await reloadSaved();
  if (op === 'setColor') return setFolderColor(a.id, a.color);
  if (op === 'setCollapsed') return setFolderCollapsed(a.id, a.collapsed);
  const v = M.view({ nodes: saved });
  const before = B.folderPaths(saved);
  let result = false;
  if (op === 'addFolder') result = await B.addFolder(bm, ids, saved, v, a);
  else if (op === 'rename') result = await B.rename(bm, saved, a.id, a.title);
  else if (op === 'remove') result = await B.removeSaved(bm, saved, a.id);
  else if (op === 'unpin') result = v.parent[a.id] === M.PINNED && (await B.moveSaved(bm, ids, saved, v, a.id, M.ROOT));
  else if (op === 'move' || op === 'pin') {
    const parent = op === 'pin' ? M.PINNED : a.parent;
    const n = saved[a.id];
    const today = engine.state.nodes[a.id];
    if (n && parent === M.TODAY) {
      // 收藏 → 今日
      if (n.type !== 'link') return false;
      await B.removeSaved(bm, saved, a.id);
      await engine.apply((s) => M.addLink(s, { title: n.title, url: n.url }, M.TODAY, a.index));
      result = true;
    } else if (n) {
      if (op === 'pin' && n.type !== 'link') return false;
      result = await B.moveSaved(bm, ids, saved, v, a.id, parent, a.index);
    } else if (today?.type === 'link' && M.view(engine.state).parent[a.id] === M.TODAY) {
      // 今日 → 收藏 / 置顶：建一个书签，今日里这条去掉（不关标签）
      if (!savedUrls.has(M.normUrl(today.url))) {
        await B.createLink(bm, ids, saved, v, today, parent, a.index);
      }
      await engine.apply((s) => M.remove(s, a.id));
      result = true;
    }
  }
  await reloadSaved();
  const next = B.carryColors(await getColors(), before, B.folderPaths(saved));
  if (next) await chrome.storage.sync.set({ [B.COLOR_KEY]: next });
  return result;
}

// 书签有变化（包括在 Chrome 书签管理器里改的、从别的电脑同步过来的）：重新读取，今日跟着对账
let bmTimer = null;
function onBookmarks() {
  clearTimeout(bmTimer);
  bmTimer = setTimeout(
    () =>
      run(async () => {
        await reloadSaved();
        await reconcileNow();
      }),
    300,
  );
}
for (const ev of ['onCreated', 'onRemoved', 'onChanged', 'onMoved', 'onChildrenReordered', 'onImportEnded']) {
  bm[ev]?.addListener(onBookmarks);
}

/* ---------- 「今日」对账 ---------- */

async function reconcileNow() {
  const tabs = (await chrome.tabs.query({})).filter((t) => !isSelf(t));
  const r = await engine.apply((s) => M.reconcileTabs(s, tabs, bindings, closing, savedUrls));
  await saveBindings(r.bindings);
  scheduleFlush();
}

let reconcileTimer = null;
/** 合并 RECONCILE_DELAY 内的标签事件；不重置计时，标题一直在变的页面也不会让对账无限推迟 */
function reconcileSoon() {
  if (reconcileTimer) return;
  reconcileTimer = setTimeout(() => {
    reconcileTimer = null;
    run(reconcileNow);
  }, RECONCILE_DELAY);
}

chrome.tabs.onCreated.addListener(() => reconcileSoon());
chrome.tabs.onAttached.addListener(() => reconcileSoon());
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.url || info.title || info.status === 'complete') reconcileSoon();
});

chrome.tabs.onReplaced.addListener((added, removed) =>
  run(async () => {
    const k = String(removed);
    if (bindings[k]) {
      const b = { ...bindings, [String(added)]: bindings[k] };
      delete b[k];
      await saveBindings(b);
    }
    await reconcileNow();
  }),
);

chrome.tabs.onRemoved.addListener((tabId, info) =>
  run(async () => {
    if (closing.delete(tabId)) return; // 本扩展关的，绑定已提前清掉
    const open = (await chrome.tabs.query({})).filter((t) => t.id !== tabId && !isSelf(t));
    const r = await engine.apply((s) =>
      M.tabClosed(s, tabId, bindings, open, { windowClosing: !!info?.isWindowClosing }),
    );
    await saveBindings(r.bindings);
    if (r.removed) scheduleFlush();
  }),
);

/** 关掉被（本机侧栏或别的设备）处处关闭的今日条目对应的本机标签 */
async function closeTabsFor(closed) {
  if (!closed?.length) return;
  const all = await chrome.tabs.query({});
  const toClose = M.tabsToClose(engine.state, closed, all.filter((t) => !isSelf(t)), bindings, savedUrls);
  if (!toClose.length) return;
  const set = new Set(toClose);
  const b = { ...bindings };
  for (const id of toClose) {
    closing.add(id);
    delete b[String(id)];
  }
  await saveBindings(b);
  // 某个窗口的标签要被全部关掉时，先开一个新标签，免得窗口被关
  const byWin = new Map();
  for (const t of all) byWin.set(t.windowId, [...(byWin.get(t.windowId) || []), t]);
  for (const [windowId, list] of byWin) {
    if (list.every((t) => set.has(t.id))) await chrome.tabs.create({ windowId, active: true }).catch(() => {});
  }
  try {
    await chrome.tabs.remove(toClose);
  } catch (e) {
    for (const id of toClose) closing.delete(id);
    console.warn('[side-pocket] 关闭标签失败', e);
  }
}

/* ---------- 远端变更 ---------- */

let remoteTimer = null;
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync') return;
  if (!Object.keys(changes).some((k) => k.startsWith('n:') || k.startsWith('d:'))) return;
  clearTimeout(remoteTimer);
  remoteTimer = setTimeout(
    () =>
      run(async () => {
        const res = await engine.mergeRemote();
        await absorbLegacy().catch((e) => console.error('[side-pocket] 收藏搬进书签失败', e)); // 还没升级的旧版设备写回来的收藏
        await closeTabsFor(res.closed);
        if (res.changed) await reconcileNow();
        scheduleFlush();
      }),
    200,
  );
});

/* ---------- 写入云端（节流 + 闹钟兜底） ---------- */

let flushTimer = null;
let lastFlush = 0;

function scheduleFlush() {
  if (flushTimer || !engine?.pendingCount()) return;
  const wait = Math.max(FLUSH_DELAY, lastFlush + FLUSH_GAP - Date.now());
  flushTimer = setTimeout(() => {
    flushTimer = null;
    run(flushNow);
  }, wait);
  // service worker 在计时器触发前被回收时，由闹钟兜底
  chrome.alarms.create(FLUSH_ALARM, { delayInMinutes: 1 });
}

async function flushNow() {
  lastFlush = Date.now();
  const r = await engine.flush();
  if (!r.ok && (r.kind === 'rate' || r.kind === 'other')) {
    chrome.alarms.create(FLUSH_ALARM, { delayInMinutes: 1 });
    return;
  }
  // 配额满：不反复重试，等下一次改动（比如用户删了条目）再试
  if (r.ok && engine.pendingCount()) scheduleFlush();
  else if (r.ok) chrome.alarms.clear(FLUSH_ALARM);
}

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === FLUSH_ALARM || a.name === LEGACY_FLUSH_ALARM) run(flushNow);
});

/* ---------- 侧栏发来的操作 ---------- */

const NO_RECONCILE = new Set(['rename', 'setCollapsed', 'setColor', 'addFolder']);

async function handleOp(op, a) {
  if (a.id != null && !M.isValidId(a.id)) throw new Error('无效 id');
  const p = a.parent;
  if (p != null && p !== M.ROOT && p !== M.PINNED && p !== M.TODAY && !M.isValidId(p)) throw new Error('无效目标');
  let result;
  if (op === 'clearToday') {
    // 「本机开着哪些」以后台查到的为准，不信任侧栏传来的
    const tabs = (await chrome.tabs.query({})).filter((t) => !isSelf(t) && !t.incognito);
    const openUrls = tabs.map((t) => t.url || t.pendingUrl || '');
    result = await engine.apply((s) => M.applyOp(s, op, { openUrls, openIds: boundIds(tabs) }));
  } else if (op === 'closeToday') {
    if (!engine.state.nodes[a.id]) return false;
    const tabs = (await chrome.tabs.query({})).filter((t) => !isSelf(t) && !t.incognito);
    const keep = boundIds(tabs).filter((x) => x !== a.id); // 本机其他标签占着的条目不删
    const closed = await engine.apply((s) => M.applyOp(s, op, { id: a.id, keep }));
    await closeTabsFor(closed);
    result = closed.length > 0;
  } else if (isSaved(a.id) || op === 'addFolder' || op === 'pin' || (op === 'move' && p !== M.TODAY)) {
    result = await savedOp(op, a);
  } else {
    result = await engine.apply((s) => M.applyOp(s, op, a));
  }
  // 移动/删除会改变「哪些网址已收藏」，重新对账让今日跟上
  if (!NO_RECONCILE.has(op)) await reconcileNow();
  scheduleFlush();
  return result;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || !msg || typeof msg.type !== 'string') return false;
  // 只接受扩展自己页面（侧栏）发来的数据操作；网页里的内容脚本不行
  const fromExtPage = (sender.url || '').startsWith(SELF_PREFIX);
  const reply = (p) => {
    p.then(
      (result) => sendResponse({ ok: true, result: result ?? null }),
      (e) => sendResponse({ ok: false, error: String(e?.message || e) }),
    );
    return true;
  };
  if (msg.type === 'side-pocket:op' && fromExtPage) return reply(run(() => handleOp(msg.op, msg.args || {})));
  if (msg.type === 'side-pocket:sync' && fromExtPage) return reply(run(reconcileNow));
  return false;
});

/* ---------- 侧栏放在 Chrome 侧边栏里 ---------- */

/** 点工具栏图标 / 按快捷键：由 Chrome 打开或关闭侧边栏，所有页面都一样，包括新标签页和 chrome:// 页面 */
async function setupSidePanel() {
  await chrome.sidePanel.setOptions({ enabled: true, path: 'sidepanel.html' }).catch(() => {});
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
}

chrome.runtime.onInstalled.addListener(async () => {
  await setupSidePanel();
  // 0.5.x / 0.6.0 浮出侧栏用过的本机状态，用不到了
  await chrome.storage.local.remove(['ui.pinned', 'nativePanelOpen', 'ui.peekHandoff']).catch(() => {});
});
chrome.runtime.onStartup.addListener(() => setupSidePanel());

// 每次 service worker 启动：加载数据、合并云端、对账（没有变化时不会写任何东西）
run(() => {});
