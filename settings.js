// UI 设置：与侧栏数据分片存储分开，单独几个小键，可在 node 里测
export const MODE_KEY = 'ui.collapseMode';
export const SIDE_KEY = 'ui.sidebarSide';

/** @deprecated 旧版「一直展开」；normalizeMode 会映射为 icon-rail */
export const MODE_ALWAYS = 'always';
export const MODE_AUTO = 'auto'; // 兼容旧值（等同于图标收起 icon-rail）
export const MODE_ICON_RAIL = 'icon-rail'; // 图标收起（52px 纯图标窄栏）
export const MODE_FULL_HIDE = 'full-hide'; // 完全隐藏（100% 移出屏幕，边缘感应唤出）
export const DEFAULT_MODE = MODE_ICON_RAIL;

export const SIDE_LEFT = 'left';
export const SIDE_RIGHT = 'right';
export const DEFAULT_SIDE = SIDE_LEFT;

/**
 * 规范化收起模式。旧值 always / 未知值 → icon-rail，避免老安装卡在已下线的「一直展开」。
 * auto 保留为存储值（设置 UI 单选），语义等同 icon-rail。
 */
export function normalizeMode(v) {
  if (v === MODE_FULL_HIDE) return MODE_FULL_HIDE;
  if (v === MODE_AUTO) return MODE_AUTO;
  if (v === MODE_ICON_RAIL) return MODE_ICON_RAIL;
  // always / 空 / 未知 → 图标收起
  return MODE_ICON_RAIL;
}

/** 是否使用页面贴边浮层（图标收起 / 完全隐藏）。always 已映射走，恒为 true。 */
export function isOverlayMode(v) {
  const m = normalizeMode(v);
  return m === MODE_AUTO || m === MODE_ICON_RAIL || m === MODE_FULL_HIDE;
}

export function isFullHideMode(v) {
  return normalizeMode(v) === MODE_FULL_HIDE;
}

export function normalizeSide(v) {
  return v === SIDE_RIGHT ? SIDE_RIGHT : SIDE_LEFT;
}

/** storageArea: Promise 风格 get/set（chrome.storage.sync 或 mock） */
export async function getCollapseMode(storageArea) {
  const data = await storageArea.get(MODE_KEY);
  return normalizeMode(data[MODE_KEY]);
}

export async function setCollapseMode(storageArea, mode) {
  const m = normalizeMode(mode);
  await storageArea.set({ [MODE_KEY]: m });
  return m;
}

export async function getSidebarSide(storageArea) {
  const data = await storageArea.get(SIDE_KEY);
  return normalizeSide(data[SIDE_KEY]);
}

export async function setSidebarSide(storageArea, side) {
  const s = normalizeSide(side);
  await storageArea.set({ [SIDE_KEY]: s });
  return s;
}
