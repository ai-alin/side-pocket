// UI 设置：与侧栏数据分开存储，单独几个小键，可在 node 里测
export const MODE_KEY = 'ui.collapseMode';
export const SIDE_KEY = 'ui.sidebarSide';
export const HOVER_KEY = 'ui.hoverExpand'; // 图标收起时，鼠标停留是否自动展开（默认开）

export const MODE_ICON_RAIL = 'icon-rail'; // 图标收起（52px 纯图标窄栏）
export const MODE_FULL_HIDE = 'full-hide'; // 完全隐藏（移出屏幕，边缘感应唤出）
export const DEFAULT_MODE = MODE_ICON_RAIL;
/** 旧版的值，读取时都当作 icon-rail */
export const LEGACY_MODES = ['always', 'auto'];

export const SIDE_LEFT = 'left';
export const SIDE_RIGHT = 'right';
export const DEFAULT_SIDE = SIDE_LEFT;

/** 规范化收起模式：只有 full-hide 和 icon-rail 两种；旧值 always / auto / 未知值 → icon-rail */
export function normalizeMode(v) {
  return v === MODE_FULL_HIDE ? MODE_FULL_HIDE : MODE_ICON_RAIL;
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

export async function getHoverExpand(storageArea) {
  const data = await storageArea.get(HOVER_KEY);
  return data[HOVER_KEY] !== false;
}

export async function setHoverExpand(storageArea, on) {
  await storageArea.set({ [HOVER_KEY]: !!on });
  return !!on;
}
