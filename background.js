// 后台 service worker：唯一负责数据的地方。
// - 标签事件 → 「今日」对账；远端变更 → 合并、处处关闭；侧栏发来的操作 → 执行。
// - 所有读写走一个串行队列，避免交错。
// - 改动先存 storage.local（立即生效），再合并成批写入 storage.sync（节流，避免被 Chrome 限流）。
// 侧栏（无论开了多少个）只负责显示，不再各自对账、各自写云端。

import * as M from './model.js';
import { createEngine, VIEW_KEY } from './store.js';
import { MODE_KEY, normalizeMode } from './settings.js';

const SELF_PREFIX = chrome.runtime.getURL('');
const BIND_KEY = 'tabBindings'; // storage.session：tabId -> 今日条目，浏览器重启即清空（tab id 也会变）
const NATIVE_KEY = 'nativePanelOpen';
const FLUSH_ALARM = 'arc-flush';
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

const isSelf = (t) => (t.url || t.pendingUrl || '').startsWith(SELF_PREFIX);

function isInjectableUrl(u) {
  return typeof u === 'string' && (u.startsWith('http://') || u.startsWith('https://') || u.startsWith('file://'));
}

/* ---------- 串行队列 ---------- */

function run(fn) {
  const p = chain.then(async () => {
    await ensureReady();
    const out = await fn();
    await publish();
    return out;
  });
  chain = p.catch((e) => console.error('[arc-sidebar]', e));
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

async function saveBindings(next) {
  if (JSON.stringify(next) === JSON.stringify(bindings)) return;
  bindings = next;
  await chrome.storage.session.set({ [BIND_KEY]: bindings });
}

/* ---------- 「今日」对账 ---------- */

async function reconcileNow() {
  const tabs = (await chrome.tabs.query({})).filter((t) => !isSelf(t));
  const r = await engine.apply((s) => M.reconcileTabs(s, tabs, bindings, closing));
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
  if (info.status === 'complete' && isInjectableUrl(tab.url)) closeNativeFallback();
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
  const ids = M.tabsToClose(engine.state, closed, all.filter((t) => !isSelf(t)), bindings);
  if (!ids.length) return;
  const set = new Set(ids);
  const b = { ...bindings };
  for (const id of ids) {
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
    await chrome.tabs.remove(ids);
  } catch (e) {
    for (const id of ids) closing.delete(id);
    console.warn('[arc-sidebar] 关闭标签失败', e);
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
  if (a.name === FLUSH_ALARM) run(flushNow);
});

/* ---------- 侧栏发来的操作 ---------- */

const NO_RECONCILE = new Set(['rename', 'setCollapsed', 'addFolder']);

async function handleOp(op, a) {
  if (a.id != null && !M.isValidId(a.id)) throw new Error('无效 id');
  let result;
  if (op === 'closeToday') {
    const n = engine.state.nodes[a.id];
    if (!n) return false;
    result = await engine.apply((s) => M.applyOp(s, op, a));
    await closeTabsFor([{ id: a.id, url: n.url }]);
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
  if (msg.type === 'arc:op' && fromExtPage) return reply(run(() => handleOp(msg.op, msg.args || {})));
  if (msg.type === 'arc:sync' && fromExtPage) return reply(run(reconcileNow));
  if (msg.type === 'arc-sidebar:activate-auto') return reply(ensureOverlayInAllTabs());
  return false;
});

/* ---------- 贴边栏注入与原生侧栏回退 ---------- */

async function disableNativeSidePanel() {
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});
  await chrome.sidePanel.setOptions({ enabled: false }).catch(() => {});
}

/** 给已经打开的标签页注入贴边栏（manifest 的内容脚本只对之后加载的页面生效） */
async function ensureOverlayInAllTabs() {
  let activeInjected = false;
  let activeUrl = '';
  const all = await chrome.tabs.query({});
  const active = all.find((t) => t.active && !isSelf(t));
  if (active) activeUrl = active.url || active.pendingUrl || '';
  for (const t of all) {
    if (!t.id || !isInjectableUrl(t.url || t.pendingUrl)) continue;
    try {
      await chrome.scripting.executeScript({ target: { tabId: t.id }, files: ['overlay.js'] });
      if (active && t.id === active.id) activeInjected = true;
    } catch (e) {
      // 商店页、无文件访问权限的 file:// 等注入不了，属正常情况
      if (active && t.id === active.id) console.info('[arc-sidebar] 当前页无法注入', e?.message);
    }
  }
  return { activeInjected, activeUrl };
}

async function normalizeStoredMode() {
  const d = await chrome.storage.sync.get(MODE_KEY);
  const m = normalizeMode(d[MODE_KEY]);
  if (d[MODE_KEY] !== m) await chrome.storage.sync.set({ [MODE_KEY]: m });
}

chrome.runtime.onInstalled.addListener(async () => {
  await disableNativeSidePanel();
  await normalizeStoredMode().catch((e) => console.warn('[arc-sidebar]', e));
  await ensureOverlayInAllTabs();
});
chrome.runtime.onStartup.addListener(() => disableNativeSidePanel());

// 点扩展图标：普通网页 → 贴边栏展开/收起；新标签页、chrome:// 等 → 原生侧栏（失败再用弹窗）
chrome.action.onClicked.addListener(async (tab) => {
  const url = tab?.url || tab?.pendingUrl || '';
  if (tab?.id && isInjectableUrl(url)) {
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['overlay.js'] });
      await chrome.tabs.sendMessage(tab.id, { type: 'arc-sidebar:toggle' });
      return;
    } catch (e) {
      console.info('[arc-sidebar] 贴边栏不可用，改用回退', e?.message);
    }
  }
  openNativeFallback(tab?.windowId);
});

/** sidePanel.open 必须在用户点击的同一调用栈里发起，所以这里不 await 前面的步骤 */
function openNativeFallback(windowId) {
  chrome.sidePanel.setOptions({ enabled: true, path: 'sidepanel.html' }).catch(() => {});
  chrome.sidePanel
    .open({ windowId })
    .then(() => chrome.storage.session.set({ [NATIVE_KEY]: true }))
    .catch(() =>
      chrome.windows
        .create({ url: chrome.runtime.getURL('sidepanel.html?mode=popup'), type: 'popup', width: 380, height: 720 })
        .catch((e) => console.warn('[arc-sidebar] 弹窗回退失败', e)),
    );
}

/** 用户从新标签页进入普通网页后，关掉临时打开的原生侧栏，避免出现两个侧栏 */
async function closeNativeFallback() {
  const d = await chrome.storage.session.get(NATIVE_KEY);
  if (!d[NATIVE_KEY]) return;
  await chrome.storage.session.remove(NATIVE_KEY);
  await disableNativeSidePanel();
}

// 每次 service worker 启动：加载数据、合并云端、对账（没有变化时不会写任何东西）
run(() => {});
