import {
  getCollapseMode,
  setCollapseMode,
  MODE_KEY,
  SIDE_KEY,
  MODE_AUTO,
  MODE_ICON_RAIL,
} from './settings.js';
import * as M from './model.js';
import { createStore } from './store.js';

const SELF_PREFIX = chrome.runtime.getURL('');

/** 窗口 id → 是否因 NTP 等不可注入页临时启用了原生 sidePanel */
const nativeFallbackWindows = new Set();

function isInjectableUrl(u) {
  if (!u || typeof u !== 'string') return false;
  return u.startsWith('http://') || u.startsWith('https://') || u.startsWith('file://');
}

/**
 * 禁用 Chrome 原生右侧 sidePanel，避免与页面内贴边栏同时出现「双侧边栏」。
 * 保持 openPanelOnActionClick=false；仅 NTP fallback 时临时 enabled。
 */
async function disableNativeSidePanel() {
  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
  } catch (_) {}
  try {
    await chrome.sidePanel.setOptions({ enabled: false });
  } catch (_) {}
}

async function enableNativeSidePanel() {
  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
  } catch (_) {}
  try {
    await chrome.sidePanel.setOptions({ enabled: true, path: 'sidepanel.html' });
  } catch (_) {}
}

/**
 * 向所有已打开的标签页动态注入 overlay.js（无需刷新即可生效）。
 */
async function ensureOverlayInAllTabs({ flashActive = false } = {}) {
  let activeInjected = false;
  let activeUrl = '';
  try {
    const allTabs = await chrome.tabs.query({});
    const activeTab = allTabs.find((t) => t.active && !(t.url || '').startsWith(SELF_PREFIX));
    if (activeTab) activeUrl = activeTab.url || activeTab.pendingUrl || '';

    for (const t of allTabs) {
      const url = t.url || t.pendingUrl || '';
      if (!t.id || !isInjectableUrl(url)) continue;
      try {
        await chrome.scripting.executeScript({
          target: { tabId: t.id },
          files: ['overlay.js'],
        });
        if (activeTab && t.id === activeTab.id) {
          activeInjected = true;
          if (flashActive) {
            await chrome.tabs.sendMessage(t.id, { type: 'arc-sidebar:flash' }).catch(() => {});
          }
        }
      } catch (_) {}
    }
  } catch (e) {
    console.warn('ensureOverlayInAllTabs', e);
  }
  return { activeInjected, activeUrl };
}

async function refreshMode({ fromUserSwitch = false } = {}) {
  await disableNativeSidePanel();
  try {
    const { todayTabMap } = await chrome.storage.local.get('todayTabMap');
    if (todayTabMap) {
      await chrome.storage.local.set({ todayTabMap: M.sanitizeTabMap(todayTabMap) });
    }
  } catch (_) {}
  // 老安装若仍存 always，写成 icon-rail，避免幽灵状态
  try {
    const mode = await getCollapseMode(chrome.storage.sync);
    if (mode === MODE_ICON_RAIL || mode === MODE_AUTO) {
      // already fine
    }
    await setCollapseMode(chrome.storage.sync, mode);
  } catch (_) {}
  await ensureOverlayInAllTabs({ flashActive: fromUserSwitch });
}

async function openNativeFallback(windowId) {
  if (windowId == null) return false;
  try {
    await enableNativeSidePanel();
    if (chrome.sidePanel?.open) {
      await chrome.sidePanel.open({ windowId });
      nativeFallbackWindows.add(windowId);
      return true;
    }
  } catch (e) {
    console.warn('sidePanel.open fallback', e);
  }
  try {
    await chrome.windows.create({
      url: chrome.runtime.getURL('sidepanel.html?mode=popup'),
      type: 'popup',
      width: 380,
      height: 720,
      focused: true,
    });
    return true;
  } catch (e) {
    console.warn('popup fallback', e);
    return false;
  }
}

/** overlay 在可注入页挂载成功后，关掉该窗口的原生侧栏，杜绝双侧边栏 */
async function clearNativeFallbackForWindow(windowId) {
  if (windowId == null) return;
  if (!nativeFallbackWindows.has(windowId) && nativeFallbackWindows.size === 0) {
    // 仍统一关掉，防止残留 enabled
    await disableNativeSidePanel();
    return;
  }
  nativeFallbackWindows.delete(windowId);
  await disableNativeSidePanel();
}

chrome.runtime.onInstalled.addListener(() => {
  refreshMode();
});
chrome.runtime.onStartup.addListener(() => {
  refreshMode();
});
disableNativeSidePanel();
refreshMode();

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && (changes[MODE_KEY] || changes[SIDE_KEY])) {
    disableNativeSidePanel();
    // 设置变更不 flash，避免收起手感发黏
    ensureOverlayInAllTabs({ flashActive: false });
  }
});

// 点击扩展图标：可注入页 → overlay 展开/收起；NTP / chrome:// 等 → 原生 sidePanel（或 popup）回退
chrome.action.onClicked.addListener(async (tab) => {
  const url = tab?.url || tab?.pendingUrl || '';
  if (tab?.id && isInjectableUrl(url)) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['overlay.js'],
      });
      await chrome.tabs.sendMessage(tab.id, { type: 'arc-sidebar:toggle' });
      await clearNativeFallbackForWindow(tab.windowId);
      return;
    } catch (_) {
      // 注入失败则走回退
    }
  }
  await openNativeFallback(tab?.windowId);
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'arc-sidebar:activate-auto') {
    disableNativeSidePanel().then(() =>
      ensureOverlayInAllTabs({ flashActive: false }).then((res) => {
        sendResponse(res);
      }),
    );
    return true;
  }
  if (msg?.type === 'arc-sidebar:overlay-mounted') {
    const windowId = sender?.tab?.windowId;
    clearNativeFallbackForWindow(windowId).then(() => sendResponse({ ok: true }));
    return true;
  }
  return false;
});

// 从 NTP 导航到普通页：注入 overlay，并关掉临时原生侧栏
chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (info.status !== 'complete') return;
  const url = tab.url || '';
  if (!isInjectableUrl(url)) return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['overlay.js'],
    });
    if (tab.windowId != null) await clearNativeFallbackForWindow(tab.windowId);
  } catch (_) {}
});

/* ---------- 后台「今日」标签同步（仅在没有任何侧边栏视图打开时介入） ---------- */

async function hasOpenSidepanelView() {
  if (chrome.runtime.getContexts) {
    try {
      const ctxs = await chrome.runtime.getContexts({});
      if (ctxs.some((c) => (c.documentUrl || '').includes('sidepanel.html'))) return true;
    } catch (_) {}
  }
  return false;
}

let bgTimer = null;
function scheduleBgReconcile() {
  clearTimeout(bgTimer);
  bgTimer = setTimeout(runBgReconcile, 500);
}

async function runBgReconcile() {
  if (await hasOpenSidepanelView()) return;
  let { deviceId, todayTabMap } = await chrome.storage.local.get(['deviceId', 'todayTabMap']);
  if (!deviceId) {
    deviceId = M.newId();
    await chrome.storage.local.set({ deviceId });
  }
  const store = createStore({ sync: chrome.storage.sync, local: chrome.storage.local, deviceId });
  const r = await store.load();
  const state = M.normalize(r.state || r.fallback || M.emptyState());
  const allTabs = await chrome.tabs.query({});
  const validTabs = allTabs.filter((t) => !(t.url || t.pendingUrl || '').startsWith(SELF_PREFIX));
  const res = M.reconcileToday(state, validTabs, M.sanitizeTabMap(todayTabMap));
  await chrome.storage.local.set({ todayTabMap: res.tabMap });
  if (res.changed) {
    await store.save(state);
  }
}

for (const ev of ['onCreated', 'onRemoved', 'onUpdated', 'onReplaced']) {
  chrome.tabs[ev].addListener(scheduleBgReconcile);
}
