// 0.9.x 及以前的旧数据，只用于升级时清理。纯函数，可在 node 里测。
//
// 旧格式（store.js，已删除）：
//   sync   n:<id>  一个节点 { k: 'f'|'l', ti, p: 父容器, o, t, u?, c?, co? }；p 为 'today' 的是「今日」条目
//          d:<设备id>  删除记录 { id: [时间, 是否处处关闭] }
//          meta / c0 c1 …  0.3.x 更早的整份切片格式
//   local  state2 = { nodes, pending }  本机完整副本；mirror、todayTabMap 更早的版本
//   session tabBindings
// 0.10.0 起「今日」取消。旧数据里的置顶 / 收藏（还没升级的电脑可能写回来）搬进书签，其余全部删掉。

const NODE = 'n:';
const LOG = 'd:';
const TODAY = 'today';

export const LOCAL_KEYS = ['state2', 'mirror', 'todayTabMap'];
export const SESSION_KEYS = ['tabBindings'];

const validId = (id) => typeof id === 'string' && /^[a-z0-9]{4,32}$/.test(id);

function unpack(id, o) {
  if (!o || typeof o !== 'object' || !validId(id) || typeof o.p !== 'string') return null;
  const type = o.k === 'f' ? 'folder' : o.k === 'l' ? 'link' : null;
  if (!type || (type === 'link' && typeof o.u !== 'string')) return null;
  const n = { id, type, title: String(o.ti ?? ''), parent: o.p, pos: Number(o.o) || 0 };
  if (type === 'link') n.url = o.u;
  else {
    n.collapsed = !!o.c;
    if (typeof o.co === 'string') n.color = o.co;
  }
  return n;
}

/** sync 里的旧格式键 */
export function legacySyncKeys(all = {}) {
  return Object.keys(all).filter((k) => k.startsWith(NODE) || k.startsWith(LOG) || k === 'meta' || /^c\d+$/.test(k));
}

/**
 * 旧数据里还没删的置顶 / 收藏节点（不含今日）。来源：sync 里的 n: 键 + 本机 state2 副本。
 * 删除记录里有的不算；两边都有时用 sync 的。
 */
export function savedNodes(all = {}, localState = null) {
  const deleted = new Set();
  for (const [k, v] of Object.entries(all)) {
    if (k.startsWith(LOG) && v && typeof v === 'object') for (const id of Object.keys(v)) deleted.add(id);
  }
  const nodes = {};
  for (const n of Object.values(localState?.nodes || {})) {
    if (n && validId(n.id) && (n.type === 'link' || n.type === 'folder')) nodes[n.id] = { ...n };
  }
  for (const [k, v] of Object.entries(all)) {
    if (!k.startsWith(NODE)) continue;
    const n = unpack(k.slice(NODE.length), v);
    if (n) nodes[n.id] = n;
  }
  const out = {};
  for (const [id, n] of Object.entries(nodes)) {
    if (deleted.has(id) || n.parent === TODAY) continue;
    out[id] = n;
  }
  return out;
}

/** 只含置顶 / 收藏的 n: 键（旧版电脑写回来时只搬这些，不碰它的今日） */
export function savedKeys(all = {}) {
  return Object.keys(all).filter((k) => k.startsWith(NODE) && all[k]?.p !== TODAY);
}
