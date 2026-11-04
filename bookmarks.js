// 收藏和置顶存在 Chrome 书签里：其他书签 / Side Pocket，置顶是里面的「置顶」子文件夹。
// 书签属于登录 Chrome 的 Google 账号，由 Chrome 自己同步；卸载插件书签也还在，重装后自动找回。
// 「今日」不在这里，仍由 store.js 存在 chrome.storage.sync。
//
// 换算成侧栏用的节点（和 model.js 的节点同一格式，可以直接交给 view() 等函数）：
//   id     'bkm' + 书签 id。书签 id 每台电脑不一样，所以这些 id 只在本机有意义，不往云端写
//   parent PINNED / ROOT / 父文件夹节点 id
//   pos    在书签父文件夹里的下标（和 Chrome 书签管理器里的顺序一致）
//   bp     书签父文件夹 id
//   path   文件夹路径（如「AI/工具」），用来存颜色
// 书签存不了颜色和折叠状态：
//   颜色按文件夹路径存在 storage.sync（书签 id 各台电脑不同，只能按路径对上），换台电脑也一样；
//   折叠状态按节点 id 存在 storage.local，每台电脑各记各的。
// 这两样卸载重装后会丢，收藏内容本身不受影响。
//
// bm 参数是 chrome.bookmarks（Promise 风格），测试里换成模拟对象。

import * as M from './model.js';

export const ROOT_TITLE = 'Side Pocket';
export const PINNED_TITLE = '置顶';
export const COLOR_KEY = 'ui.folderColors'; // storage.sync：{ 文件夹路径: 颜色 }
export const COLLAPSE_KEY = 'ui.folderCollapsed'; // storage.local：{ 节点 id: true }
const PREFIX = 'bkm';
const MAX_TITLE = 300;

export const toId = (bid) => PREFIX + bid;
export const toBid = (id) => String(id).slice(PREFIX.length);

const isFolder = (b) => !b.url && b.type !== 'separator';
const clip = (t) => String(t ?? '').trim().slice(0, MAX_TITLE);
/** 同名文件夹有好几个时，用最早建的那个（各台电脑结论一致） */
const byAge = (a, b) => (a.dateAdded || 0) - (b.dateAdded || 0) || Number(a.id) - Number(b.id);
const withIndex = (o, index) => (index == null ? o : { ...o, index });

/* ---------- 找到 / 建立 Side Pocket 文件夹 ---------- */

/** 「其他书签」：登录了 Google 账号时优先用跟着账号同步的那一份 */
async function otherFolder(bm) {
  const top = await bm.getChildren('0');
  const others = top.filter((b) => b.folderType === 'other');
  return others.find((b) => b.syncing) || others[0] || top.find((b) => b.id === '2') || top[1] || top[0] || null;
}

async function hasLinks(bm, id) {
  const [t] = await bm.getSubTree(id);
  const walk = (b) => !!b.url || (b.children || []).some(walk);
  return walk(t);
}

/**
 * 同名文件夹有好几个时（比如新电脑上书签还没同步下来就先建了一个空的），
 * 用里面有网址的那个，都没有就用最早建的；create 时把多出来的空文件夹删掉。
 */
async function pickFolder(bm, folders, create) {
  if (folders.length <= 1) return folders[0] || null;
  let keep = folders[0];
  for (const f of folders) {
    if (await hasLinks(bm, f.id)) {
      keep = f;
      break;
    }
  }
  if (create) {
    for (const f of folders) {
      if (f !== keep && !(await hasLinks(bm, f.id))) await bm.removeTree(f.id).catch(() => {});
    }
  }
  return keep;
}

/**
 * 返回 { root, pinned }（书签 id）。create=false 时只找不建，找不到返回 null / pinned 为 null。
 * 只有后台用 create=true，侧栏只读，免得两边同时各建一个。
 */
export async function resolveRoot(bm, { create = false } = {}) {
  const other = await otherFolder(bm);
  if (!other) return null;
  const roots = (await bm.getChildren(other.id)).filter((b) => isFolder(b) && b.title === ROOT_TITLE).sort(byAge);
  let root = await pickFolder(bm, roots, create);
  if (!root) {
    if (!create) return null;
    root = await bm.create({ parentId: other.id, title: ROOT_TITLE });
  }
  const pins = (await bm.getChildren(root.id)).filter((b) => isFolder(b) && b.title === PINNED_TITLE).sort(byAge);
  let pinned = await pickFolder(bm, pins, create);
  if (!pinned) {
    if (!create) return { root: root.id, pinned: null };
    pinned = await bm.create({ parentId: root.id, title: PINNED_TITLE, index: 0 });
  }
  return { root: root.id, pinned: pinned.id };
}

/* ---------- 读：书签 → 侧栏节点 ---------- */

export async function loadNodes(bm, ids, meta = {}) {
  const nodes = {};
  if (!ids?.root) return nodes;
  const [rootNode] = await bm.getSubTree(ids.root);
  const colors = meta.colors || {};
  const collapsed = meta.collapsed || {};
  const walk = (list, parent, bp, path) => {
    for (const b of list || []) {
      if (b.url) {
        const id = toId(b.id);
        nodes[id] = { id, type: 'link', title: b.title || '', url: b.url, parent, pos: b.index ?? 0, bp, t: 0 };
      } else if (isFolder(b)) {
        if (parent === M.ROOT && b.id === ids.pinned) {
          walk(b.children, M.PINNED, b.id, '');
          continue;
        }
        const id = toId(b.id);
        const p = path ? path + '/' + b.title : b.title;
        const n = { id, type: 'folder', title: b.title || '未命名文件夹', parent, pos: b.index ?? 0, bp, path: p, collapsed: !!collapsed[id], t: 0 };
        if (M.FOLDER_COLORS.includes(colors[p])) n.color = colors[p];
        nodes[id] = n;
        walk(b.children, id, b.id, p);
      }
    }
  };
  walk(rootNode?.children, M.ROOT, ids.root, '');
  return nodes;
}

/** 收藏和置顶里所有网址（比较用的 normUrl） */
export function urlSet(nodes) {
  const out = new Set();
  for (const n of Object.values(nodes)) if (n.type === 'link') out.add(M.normUrl(n.url));
  return out;
}

/** { 文件夹节点 id: 路径 } */
export function folderPaths(nodes) {
  const out = {};
  for (const n of Object.values(nodes)) if (n.type === 'folder') out[n.id] = n.path;
  return out;
}

/**
 * 文件夹改名、移动、删除后，颜色跟着走：before / after 是操作前后的 folderPaths。
 * 返回新的颜色表，没有变化时返回 null。
 */
export function carryColors(colors, before, after) {
  const out = { ...colors };
  let changed = false;
  const live = new Set(Object.values(after));
  for (const [id, oldPath] of Object.entries(before)) {
    const newPath = after[id];
    if (newPath === oldPath || !(oldPath in colors)) continue;
    if (newPath != null && out[newPath] !== colors[oldPath]) {
      out[newPath] = colors[oldPath];
      changed = true;
    }
    if (!live.has(oldPath) && oldPath in out) {
      delete out[oldPath];
      changed = true;
    }
  }
  return changed ? out : null;
}

/* ---------- 写：侧栏操作 → 书签 ---------- */

const containerBid = (ids, key) => (key === M.ROOT ? ids.root : key === M.PINNED ? ids.pinned : toBid(key));

function isContainer(nodes, key) {
  return key === M.ROOT || key === M.PINNED || nodes[key]?.type === 'folder';
}

/**
 * 侧栏里「放在 parent 列表第 index 位」（index 是移动前列表里的下标，和 model.move 一样）
 * 对应的书签下标：就是那个位置上现在那一项的书签下标，Chrome 的 move 也按移动前的下标算。
 * 放到末尾、或者那一项其实不在这个书签文件夹里时，返回 undefined（加到末尾）。
 */
export function bmIndex(nodes, v, parent, index, bid) {
  const list = v.order[parent] || [];
  if (index == null || index < 0 || index >= list.length) return undefined;
  const n = nodes[list[index]];
  return n && n.bp === bid ? n.pos : undefined;
}

export async function addFolder(bm, ids, nodes, v, { title, parent = M.ROOT, index } = {}) {
  if (parent === M.PINNED) throw new Error('该区域不能放文件夹');
  if (!isContainer(nodes, parent)) throw new Error('目标不存在: ' + parent);
  const bid = containerBid(ids, parent);
  const b = await bm.create(withIndex({ parentId: bid, title: clip(title) || '新文件夹' }, bmIndex(nodes, v, parent, index, bid)));
  return toId(b.id);
}

export async function createLink(bm, ids, nodes, v, { title, url }, parent, index) {
  if (!url) throw new Error('缺少 url');
  if (!isContainer(nodes, parent)) throw new Error('目标不存在: ' + parent);
  const bid = containerBid(ids, parent);
  const b = await bm.create(withIndex({ parentId: bid, title: clip(title) || url, url }, bmIndex(nodes, v, parent, index, bid)));
  return toId(b.id);
}

/** 收藏 / 置顶之间移动（v 是包含这些节点的 view） */
export async function moveSaved(bm, ids, nodes, v, id, parent, index) {
  const n = nodes[id];
  if (!n || !isContainer(nodes, parent)) return false;
  if (n.type === 'folder' && (parent === M.PINNED || M.isInside(v, parent, id))) return false;
  const bid = containerBid(ids, parent);
  await bm.move(toBid(id), withIndex({ parentId: bid }, bmIndex(nodes, v, parent, index, bid)));
  return true;
}

export async function rename(bm, nodes, id, title) {
  const n = nodes[id];
  const t = clip(title);
  if (!n || !t || t === n.title) return false;
  await bm.update(toBid(id), { title: t });
  return true;
}

export async function removeSaved(bm, nodes, id) {
  const n = nodes[id];
  if (!n) return false;
  if (n.type === 'folder') await bm.removeTree(toBid(id));
  else await bm.remove(toBid(id));
  return true;
}

/* ---------- 旧数据迁移 ---------- */

/**
 * 把旧格式（0.8.x 及以前，收藏和置顶也存在 storage.sync 里）中不在今日的节点写进书签。
 * 按网址去重、同名文件夹合并，所以重复执行（迁移中途失败重试、两台电脑都迁移）不会出现重复。
 * 返回 { added, colors, collapsed, drop }：drop 是写完以后要从旧存储里删掉的顶层节点 id。
 */
export async function importNodes(bm, ids, allNodes) {
  // 今日条目（parent 'today'）绝不能搬进书签；model.view 已经不认 today，会把它们当成收藏
  const nodes = Object.fromEntries(Object.entries(allNodes).filter(([, n]) => n.parent !== 'today'));
  const v = M.view({ nodes });
  const [rootNode] = await bm.getSubTree(ids.root);
  const urls = new Set();
  const collect = (list) => {
    for (const b of list || []) {
      if (b.url) urls.add(M.normUrl(b.url));
      collect(b.children);
    }
  };
  collect(rootNode?.children);

  const folderMaps = new Map(); // 书签文件夹 id -> Map(标题 -> 子文件夹书签 id)
  const foldersIn = async (bid) => {
    if (!folderMaps.has(bid)) {
      const m = new Map();
      for (const b of await bm.getChildren(bid)) {
        if (isFolder(b) && b.id !== ids.pinned && !m.has(b.title)) m.set(b.title, b.id);
      }
      folderMaps.set(bid, m);
    }
    return folderMaps.get(bid);
  };

  let added = 0;
  const colors = {};
  const collapsed = {};
  const addLinkTo = async (n, bid) => {
    const u = M.normUrl(n.url);
    if (!n.url || urls.has(u)) return;
    await bm.create({ parentId: bid, title: clip(n.title) || n.url, url: n.url });
    urls.add(u);
    added++;
  };
  const walk = async (key, bid, path) => {
    for (const id of v.order[key]) {
      const n = nodes[id];
      if (n.type === 'link') {
        await addLinkTo(n, bid);
        continue;
      }
      const title = clip(n.title) || '新文件夹';
      const m = await foldersIn(bid);
      let fb = m.get(title);
      if (!fb) {
        fb = (await bm.create({ parentId: bid, title })).id;
        m.set(title, fb);
        added++;
      }
      const p = path ? path + '/' + title : title;
      if (n.color) colors[p] = n.color;
      if (n.collapsed) collapsed[toId(fb)] = true;
      await walk(id, fb, p);
    }
  };

  for (const id of v.order[M.PINNED]) await addLinkTo(nodes[id], ids.pinned);
  await walk(M.ROOT, ids.root, '');
  return { added, colors, collapsed, drop: [...v.order[M.PINNED], ...v.order[M.ROOT]] };
}
