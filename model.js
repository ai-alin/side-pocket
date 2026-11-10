// 置顶和收藏的树形模型（纯函数，不依赖 chrome API，可在 node 里测试）
//
// 0.10.0 起这里只管置顶和收藏（数据在 Chrome 书签里，见 bookmarks.js）；
// 本机标签直接读 chrome.tabs，其他电脑的标签见 devices.js，都不经过这里。
//
// state = { nodes: { [id]: Node } }
// Node  = { id, type: 'link' | 'folder', title, url?, parent, pos, collapsed?, color? }
//   parent  'pinned' | 'root' | 某个文件夹 id
//   pos     在父容器里的排序值，按 (pos, id) 升序排列
// 侧栏改书签前先在本地副本上执行一次同样的操作，让界面立即变化，后台改完书签后再重新读取。

export const PINNED = 'pinned';
export const ROOT = 'root';
const CONTAINERS = new Set([PINNED, ROOT]);

/** 文件夹可选颜色：与 Chrome 标签组的 9 种颜色一致；不设颜色时显示为中性灰 */
export const FOLDER_COLORS = ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'];

const MAX_TITLE = 300;

export function emptyState() {
  return { nodes: {} };
}

export function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

export function isValidId(id) {
  return typeof id === 'string' && /^[a-z0-9]{4,32}$/.test(id) && !CONTAINERS.has(id) && id !== 'today';
}

/** 比较 URL 时忽略 #hash 和末尾斜杠 */
export function normUrl(u) {
  if (!u) return '';
  try {
    const x = new URL(u);
    x.hash = '';
    return x.href.replace(/\/$/, '');
  } catch {
    return String(u).split('#')[0].replace(/\/$/, '');
  }
}

const clip = (str) => String(str ?? '').slice(0, MAX_TITLE);

/**
 * 存成置顶 / 收藏时去掉标题里的未读数：「(3) 首页」「Inbox (479) - a@b.com - Gmail」。
 * 这个数字一直在变，存下来就过期了。年份（「电影 (2024) - 豆瓣」）不动。
 */
export function cleanTitle(title) {
  const s = String(title ?? '');
  const out = s
    .replace(/^\s*[(\[（【]\d{1,5}\+?[)\]）】]\s*/, '')
    .replace(/^([^()（）]{1,40}?)\s*[(（](?!(?:19|20)\d\d[)）])\d{1,3}(?:,?\d{3})*\+?[)）](?=\s+[-–—|·]\s)/, '$1')
    .trim();
  return out || s;
}

/* ---------- 推导视图 ---------- */

/**
 * 从节点推导每个容器的有序列表和每个节点的实际父容器。
 * 自我修复：父文件夹不存在、文件夹放进了置顶 → 归到收藏顶层；文件夹循环 → 环里 id 最小的归到顶层。
 */
export function view(s) {
  const nodes = s.nodes;
  const parent = {};
  for (const n of Object.values(nodes)) {
    let p = n.parent;
    if (CONTAINERS.has(p)) {
      if (n.type === 'folder' && p !== ROOT) p = ROOT;
    } else if (p === n.id || nodes[p]?.type !== 'folder') {
      p = ROOT;
    }
    parent[n.id] = p;
  }
  for (const start of Object.keys(parent)) {
    const path = [];
    const onPath = new Set();
    let cur = start;
    while (!CONTAINERS.has(cur) && !onPath.has(cur)) {
      onPath.add(cur);
      path.push(cur);
      cur = parent[cur];
    }
    if (onPath.has(cur)) {
      const cycle = path.slice(path.indexOf(cur)).sort();
      parent[cycle[0]] = ROOT;
    }
  }
  const order = { [PINNED]: [], [ROOT]: [] };
  for (const n of Object.values(nodes)) if (n.type === 'folder') order[n.id] = [];
  for (const [id, p] of Object.entries(parent)) order[p].push(id);
  const cmp = (a, b) => (nodes[a].pos || 0) - (nodes[b].pos || 0) || (a < b ? -1 : a > b ? 1 : 0);
  for (const k of Object.keys(order)) order[k].sort(cmp);
  return { order, parent };
}

/** container 是否等于 folderId 或在它内部 */
export function isInside(v, container, folderId) {
  let cur = container;
  while (cur && !CONTAINERS.has(cur)) {
    if (cur === folderId) return true;
    cur = v.parent[cur];
  }
  return false;
}

export function countDescendants(v, id) {
  let c = 0;
  for (const x of v.order[id] || []) c += 1 + countDescendants(v, x);
  return c;
}

/* ---------- 修改（侧栏本地预演用） ---------- */

/** 把 n 放到 parentKey 列表的第 index 位（index 不含 n 自己） */
function place(s, n, parentKey, index, v) {
  const list = v.order[parentKey].filter((id) => id !== n.id);
  const i = index == null || index < 0 || index > list.length ? list.length : index;
  list.splice(i, 0, n.id);
  list.forEach((id, k) => {
    s.nodes[id].pos = k;
    s.nodes[id].parent = parentKey;
  });
}

export function addLink(s, { id = newId(), title, url }, parent = ROOT, index) {
  if (!url) throw new Error('缺少 url');
  if (!isValidId(id) || s.nodes[id]) throw new Error('无效 id: ' + id);
  const v = view(s);
  if (!v.order[parent]) throw new Error('目标不存在: ' + parent);
  const n = { id, type: 'link', title: clip(title || url), url };
  s.nodes[id] = n;
  place(s, n, parent, index, v);
  return id;
}

export function addFolder(s, { id = newId(), title = '新文件夹' } = {}, parent = ROOT, index) {
  if (parent === PINNED) throw new Error('该区域不能放文件夹');
  if (!isValidId(id) || s.nodes[id]) throw new Error('无效 id: ' + id);
  const v = view(s);
  if (!v.order[parent]) throw new Error('目标不存在: ' + parent);
  const n = { id, type: 'folder', title: clip(title) || '新文件夹', collapsed: false };
  s.nodes[id] = n;
  place(s, n, parent, index, v);
  return id;
}

export function rename(s, id, title) {
  const n = s.nodes[id];
  const t = clip(String(title ?? '').trim());
  if (!n || !t || t === n.title) return false;
  n.title = t;
  return true;
}

export function setCollapsed(s, id, collapsed) {
  const n = s.nodes[id];
  if (n?.type !== 'folder' || !!n.collapsed === !!collapsed) return false;
  n.collapsed = !!collapsed;
  return true;
}

/** 设置文件夹颜色；color 为空表示不设颜色 */
export function setColor(s, id, color) {
  const n = s.nodes[id];
  const c = FOLDER_COLORS.includes(color) ? color : undefined;
  if (n?.type !== 'folder' || n.color === c) return false;
  if (c) n.color = c;
  else delete n.color;
  return true;
}

/** 删除节点；文件夹连同里面的内容一起删 */
export function remove(s, id) {
  if (!s.nodes[id]) return false;
  const v = view(s);
  const rec = (x) => {
    for (const c of v.order[x] || []) rec(c);
    delete s.nodes[x];
  };
  rec(id);
  return true;
}

/** 把 id 移到 parent 列表的 index 位置（index 是移动前目标列表里的下标） */
export function move(s, id, parent, index) {
  const n = s.nodes[id];
  const v = view(s);
  if (!n || !v.order[parent]) return false;
  if (n.type === 'folder' && (parent === PINNED || isInside(v, parent, id))) return false;
  const from = v.parent[id];
  let i = index;
  if (from === parent && i != null) {
    const old = v.order[from].indexOf(id);
    if (i > old) i -= 1;
  }
  place(s, n, parent, i, v);
  return true;
}

export function pin(s, id, index) {
  return s.nodes[id]?.type === 'link' && move(s, id, PINNED, index);
}

export function unpin(s, id) {
  return view(s).parent[id] === PINNED && move(s, id, ROOT);
}

/** 侧栏发给后台的操作。侧栏先在本地副本上执行一次（立即显示），后台再改书签（权威结果） */
export function applyOp(s, op, a = {}) {
  switch (op) {
    case 'addFolder':
      return addFolder(s, { id: a.id, title: a.title }, a.parent ?? ROOT, a.index);
    case 'saveTab':
      return addLink(s, { title: a.title, url: a.url }, a.parent ?? ROOT, a.index);
    case 'rename':
      return rename(s, a.id, a.title);
    case 'setCollapsed':
      return setCollapsed(s, a.id, a.collapsed);
    case 'setColor':
      return setColor(s, a.id, a.color);
    case 'remove':
      return remove(s, a.id);
    case 'move':
      return move(s, a.id, a.parent, a.index);
    case 'pin':
      return pin(s, a.id, a.index);
    case 'unpin':
      return unpin(s, a.id);
    default:
      return false; // 和树无关的操作（设备名等），本地不用预演
  }
}
