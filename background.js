// 后台 service worker。分三块，互不干涉：
// 1. 置顶 / 收藏：侧栏发来的操作改 Chrome 书签（bookmarks.js）。
// 2. 其他电脑：把本机开着的网页清单上传到 chrome.storage.sync（devices.js），别的电脑只读。
//    标签有变化 2 秒后上传，两次上传至少隔 10 秒（Chrome 限制同步写入频率）；每 30 分钟心跳一次，
//    让别的电脑看到「最后更新」时间。关窗口、退出浏览器时不上传，清单保留最后的样子。
// 3. 升级清理：0.9.x 及以前的「今日」数据全部删掉，旧数据里的置顶 / 收藏搬进书签（legacy.js）。
// 本机标签不经过后台：侧栏直接读 chrome.tabs。
// 所有读写走一个串行队列，避免交错。

import * as M from './model.js';
import * as B from './bookmarks.js';
import * as D from './devices.js';
import * as L from './legacy.js';

const SELF_PREFIX = chrome.runtime.getURL('');
const UPLOAD_ALARM = 'side-pocket-upload';
const HEARTBEAT_ALARM = 'side-pocket-heartbeat';
const OLD_ALARMS = ['side-pocket-flush', 'arc-flush'];
const UPLOAD_DELAY = 2000;
const UPLOAD_GAP = 10000;
const HEARTBEAT_MIN = 30;
const LAST_KEY = 'devices.last'; // storage.local：上次上传的内容摘要和块数
const NAME_KEY = 'deviceName'; // storage.local：这台电脑的名字
const BACKUP_KEY = 'backup.before0100'; // storage.local：升级到 0.10.0 删除旧数据前的完整备份

const bm = chrome.bookmarks;
let deviceId = null;
let ready = null;
let status = 'saved';
let published = null;
let ids = null; // { root, pinned }：书签里 Side Pocket 和置顶文件夹的 id
let saved = {}; // 书签换算成的侧栏节点
let chain = Promise.resolve();

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
  ({ deviceId } = await chrome.storage.local.get('deviceId'));
  if (!D.isDeviceId(deviceId)) {
    deviceId = M.newId();
    await chrome.storage.local.set({ deviceId });
  }
  await reloadSaved();
  // 清理失败不能拖垮其他功能：旧数据还在原处、也有备份，下次启动再试
  await cleanupLegacy({ full: true }).catch((e) => console.error('[side-pocket] 清理旧数据失败', e));
  chrome.alarms.create(HEARTBEAT_ALARM, { periodInMinutes: HEARTBEAT_MIN });
  scheduleUpload();
}

/** 通知侧栏同步状态（只在变化时） */
async function publish() {
  if (status === published) return;
  published = status;
  await chrome.storage.session.set({ [D.VIEW_KEY]: { at: Date.now(), status } });
}

/* ---------- 置顶和收藏（Chrome 书签） ---------- */

const isSaved = (id) => typeof id === 'string' && id.startsWith('bkm');
const validParent = (p) => p == null || p === M.ROOT || p === M.PINNED || isSaved(p);
const bookmarkable = (u) => typeof u === 'string' && u.length <= 8000 && /^(https?|file|ftp|chrome):/i.test(u);

/** 重新读取书签；Side Pocket 文件夹被删掉了就重新建一个空的 */
async function reloadSaved() {
  ids = await B.resolveRoot(bm, { create: true });
  saved = await B.loadNodes(bm, ids);
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

async function savedOp(op, a) {
  if (!validParent(a.parent)) throw new Error('无效目标');
  if (a.id != null && !isSaved(a.id) && !(op === 'addFolder' && M.isValidId(a.id))) throw new Error('无效 id');
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
  else if (op === 'move') result = await B.moveSaved(bm, ids, saved, v, a.id, a.parent ?? M.ROOT, a.index);
  else if (op === 'pin') result = saved[a.id]?.type === 'link' && (await B.moveSaved(bm, ids, saved, v, a.id, M.PINNED, a.index));
  else if (op === 'saveTab') {
    // 把一个标签（本机的、或其他电脑清单里的）存成收藏 / 置顶。已经收藏过的网址：挪过去，不重复建
    if (!bookmarkable(a.url)) throw new Error('这个网址不能收藏');
    const parent = a.parent ?? M.ROOT;
    const exist = Object.values(saved).find((n) => n.type === 'link' && M.normUrl(n.url) === M.normUrl(a.url));
    if (exist) result = await B.moveSaved(bm, ids, saved, v, exist.id, parent, a.index);
    else result = !!(await B.createLink(bm, ids, saved, v, { title: a.title, url: a.url }, parent, a.index));
  } else throw new Error('未知操作: ' + op);
  await reloadSaved();
  const next = B.carryColors(await getColors(), before, B.folderPaths(saved));
  if (next) await chrome.storage.sync.set({ [B.COLOR_KEY]: next });
  return result;
}

/* ---------- 其他电脑：上传本机清单 ---------- */

async function getName() {
  const d = await chrome.storage.local.get(NAME_KEY);
  if (d[NAME_KEY]) return d[NAME_KEY];
  const os = (await chrome.runtime.getPlatformInfo().catch(() => ({})))?.os;
  return D.defaultName(os, deviceId);
}

function classify(e) {
  const m = String(e?.message || e);
  if (/MAX_WRITE_OPERATIONS|MaxWriteOperations|MAX_SUSTAINED|MaxSustained/i.test(m)) return 'rate';
  if (/quota|MAX_ITEMS|MaxItems/i.test(m)) return 'quota';
  return 'error';
}

let lastUpload = 0;

/** force：内容没变也上传（心跳、改名后），用来更新「最后更新」时间 */
async function upload({ force = false } = {}) {
  lastUpload = Date.now();
  const tabs = (await chrome.tabs.query({})).filter((t) => !isSelf(t));
  const items = D.buildSnapshot(tabs);
  const name = await getName();
  const hash = JSON.stringify([name, items]);
  const last = (await chrome.storage.local.get(LAST_KEY))[LAST_KEY] || {};
  if (!force && last.hash === hash && status === 'saved') return false;
  const write = async (opts) => {
    const plan = D.writePlan(deviceId, name, Date.now(), items, last.chunks || 0, opts);
    await chrome.storage.sync.set(plan.set);
    if (plan.remove.length) await chrome.storage.sync.remove(plan.remove);
    return plan;
  };
  let plan;
  try {
    plan = await write();
    status = 'saved';
  } catch (e) {
    const kind = classify(e);
    if (kind !== 'quota') {
      status = kind;
      chrome.alarms.create(UPLOAD_ALARM, { delayInMinutes: 1 });
      return false;
    }
    try {
      plan = await write({ maxChunks: 1 }); // 空间不够：只传第一块
      status = 'quota';
    } catch (e2) {
      status = classify(e2);
      return false;
    }
  }
  await chrome.storage.local.set({ [LAST_KEY]: { hash, chunks: plan.chunks, at: Date.now() } });
  chrome.alarms.clear(UPLOAD_ALARM);
  return true;
}

let uploadTimer = null;
/** 合并 UPLOAD_DELAY 内的标签事件；不重置计时，标题一直在变的页面也不会让上传无限推迟 */
function scheduleUpload() {
  if (uploadTimer) return;
  const wait = Math.max(UPLOAD_DELAY, lastUpload + UPLOAD_GAP - Date.now());
  uploadTimer = setTimeout(() => {
    uploadTimer = null;
    run(upload);
  }, wait);
  // service worker 在计时器触发前被回收时，由闹钟兜底
  chrome.alarms.create(UPLOAD_ALARM, { delayInMinutes: 0.5 });
}

chrome.tabs.onCreated.addListener(() => scheduleUpload());
chrome.tabs.onMoved.addListener(() => scheduleUpload());
chrome.tabs.onAttached.addListener(() => scheduleUpload());
chrome.tabs.onDetached.addListener(() => scheduleUpload());
chrome.tabs.onReplaced.addListener(() => scheduleUpload());
chrome.tabs.onUpdated.addListener((_id, info) => {
  if (info.url || info.title) scheduleUpload();
});
chrome.tabs.onRemoved.addListener((_id, info) => {
  // 关整个窗口 / 退出浏览器：不上传，别的电脑看到的清单保留最后的样子
  if (!info?.isWindowClosing) scheduleUpload();
});

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === UPLOAD_ALARM) run(upload);
  else if (a.name === HEARTBEAT_ALARM) run(() => upload({ force: true }));
  else if (OLD_ALARMS.includes(a.name)) chrome.alarms.clear(a.name);
});

async function deviceOp(op, a) {
  if (op === 'setDeviceName') {
    const name = D.cleanName(a.name);
    if (name) await chrome.storage.local.set({ [NAME_KEY]: name });
    else await chrome.storage.local.remove(NAME_KEY); // 清空 = 恢复默认名
    await upload({ force: true });
    return getName();
  }
  if (op === 'removeDevice') {
    if (!D.isDeviceId(a.id) || a.id === deviceId) throw new Error('无效设备');
    const keys = D.deviceKeys(await chrome.storage.sync.get(null), a.id);
    if (keys.length) await chrome.storage.sync.remove(keys);
    return keys.length > 0;
  }
  throw new Error('未知操作: ' + op);
}

/* ---------- 升级清理 ---------- */

/**
 * full：删掉所有旧格式数据（升级后、每次启动）。
 * 否则只搬旧版电脑刚写回来的置顶 / 收藏，不碰它的今日（免得两边来回删写）。
 */
async function cleanupLegacy({ full = false } = {}) {
  const all = await chrome.storage.sync.get(null);
  const local = full ? await chrome.storage.local.get([...L.LOCAL_KEYS, BACKUP_KEY]) : {};
  const syncKeys = full ? L.legacySyncKeys(all) : L.savedKeys(all);
  const hasLocal = L.LOCAL_KEYS.some((k) => local[k] != null);
  if (!syncKeys.length && !hasLocal) return;
  if (full && !local[BACKUP_KEY]) {
    const old = Object.fromEntries(L.legacySyncKeys(all).map((k) => [k, all[k]]));
    await chrome.storage.local.set({ [BACKUP_KEY]: { at: Date.now(), sync: old, local: local.state2 || null } });
  }
  const nodes = L.savedNodes(all, full ? local.state2 : null);
  if (Object.keys(nodes).length) {
    const r = await B.importNodes(bm, ids, nodes);
    if (Object.keys(r.colors).length) await chrome.storage.sync.set({ [B.COLOR_KEY]: { ...r.colors, ...(await getColors()) } });
    if (Object.keys(r.collapsed).length) {
      const cur = (await chrome.storage.local.get(B.COLLAPSE_KEY))[B.COLLAPSE_KEY] || {};
      await chrome.storage.local.set({ [B.COLLAPSE_KEY]: { ...cur, ...r.collapsed } });
    }
    await reloadSaved();
  }
  if (syncKeys.length) await chrome.storage.sync.remove(syncKeys);
  if (full) {
    await chrome.storage.local.remove(L.LOCAL_KEYS);
    await chrome.storage.session.remove(L.SESSION_KEYS);
    for (const a of OLD_ALARMS) chrome.alarms.clear(a);
  }
}

let legacyTimer = null;
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync') return;
  // 还没升级的旧版电脑写回来了置顶 / 收藏
  const back = Object.entries(changes).some(([k, c]) => k.startsWith('n:') && c.newValue && c.newValue.p !== 'today');
  if (!back) return;
  clearTimeout(legacyTimer);
  legacyTimer = setTimeout(() => run(() => cleanupLegacy({ full: false })), 1000);
});

/* ---------- 侧栏发来的操作 ---------- */

const SAVED_OPS = new Set(['addFolder', 'rename', 'remove', 'move', 'pin', 'unpin', 'setColor', 'setCollapsed', 'saveTab']);
const DEVICE_OPS = new Set(['setDeviceName', 'removeDevice']);

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || !msg || typeof msg.type !== 'string') return false;
  // 只接受扩展自己页面（侧栏）发来的操作
  if (!(sender.url || '').startsWith(SELF_PREFIX)) return false;
  const reply = (p) => {
    p.then(
      (result) => sendResponse({ ok: true, result: result ?? null }),
      (e) => sendResponse({ ok: false, error: String(e?.message || e) }),
    );
    return true;
  };
  if (msg.type === 'side-pocket:op') {
    const a = msg.args || {};
    if (SAVED_OPS.has(msg.op)) return reply(run(() => savedOp(msg.op, a)));
    if (DEVICE_OPS.has(msg.op)) return reply(run(() => deviceOp(msg.op, a)));
    return reply(Promise.reject(new Error('未知操作')));
  }
  if (msg.type === 'side-pocket:upload') return reply(run(() => upload({ force: true })));
  if (msg.type === 'side-pocket:info') return reply(run(async () => ({ deviceId, name: await getName() })));
  return false;
});

/* ---------- 侧栏放在 Chrome 侧边栏里 ---------- */

/** 点工具栏图标 / 按快捷键：由 Chrome 打开或关闭侧边栏 */
async function setupSidePanel() {
  await chrome.sidePanel.setOptions({ enabled: true, path: 'sidepanel.html' }).catch(() => {});
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
}

chrome.runtime.onInstalled.addListener(async () => {
  await setupSidePanel();
  // 0.5.x / 0.6.0 浮出侧栏用过的本机状态
  await chrome.storage.local.remove(['ui.pinned', 'nativePanelOpen', 'ui.peekHandoff']).catch(() => {});
});
chrome.runtime.onStartup.addListener(() => setupSidePanel());

// 每次 service worker 启动：读书签、清理旧数据、上传本机清单（内容没变时不写）
run(() => {});
