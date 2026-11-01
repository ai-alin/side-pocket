// 数据模型（纯函数，不依赖 chrome API，可在 node 里测试）
//
// state = { nodes: { [id]: Node } }
// Node  = { id, type: 'link' | 'folder', title, url?, parent, pos, collapsed?, t }
//   parent  'pinned' | 'root' | 'today' | 某个文件夹 id
//   pos     在父容器里的排序值（小数），按 (pos, id) 升序排列
//   t       最后修改时间；多台设备改了同一条目时，按它决定谁赢
//
// 每个节点独立存储、独立同步：两台设备改不同条目时互不覆盖。
// 各容器的顺序列表不存储，由 view() 从 parent / pos 推导。
// 变更记在 s.changes 里（put / del），由 store.js 的引擎取走并上传。

export const PINNED = 'pinned';
export const ROOT = 'root';
export const TODAY = 'today';
const CONTAINERS = new Set([PINNED, ROOT, TODAY]);

/** 文件夹可选颜色：与 Chrome 标签组的 9 种颜色一致；不设颜色时显示为中性灰 */
export const FOLDER_COLORS = ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'];

/** 网址太长的标签不进「今日」：chrome.storage.sync 单项上限 8KB */
export const MAX_URL = 6000;
const MAX_TITLE = 300;

export function emptyState() {
  return { nodes: {} };
}

export function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

export function isValidId(id) {
  return typeof id === 'string' && /^[a-z0-9]{4,32}$/.test(id) && !CONTAINERS.has(id);
}

/** http / https / file 标签页可以进「今日」；chrome://、扩展页、about: 等内部页不进 */
export function isSyncableTabUrl(u) {
  if (!u || typeof u !== 'string') return false;
  try {
    const x = new URL(u);
    return x.protocol === 'http:' || x.protocol === 'https:' || x.protocol === 'file:';
  } catch {
    return false;
  }
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
const tabUrl = (t) => t.url || t.pendingUrl || '';

/* ---------- 变更记录 ---------- */

function changes(s) {
  if (!s.changes) s.changes = { put: new Set(), del: new Map() };
  return s.changes;
}

function touch(s, n) {
  n.t = Math.max(Date.now(), (n.t || 0) + 1);
  const c = changes(s);
  c.put.add(n.id);
  c.del.delete(n.id);
}

function drop(s, id, close) {
  delete s.nodes[id];
  const c = changes(s);
  c.put.delete(id);
  c.del.set(id, !!close || !!c.del.get(id));
}

/** 取走并清空本次变更：{ put: Set<id>, del: Map<id, 是否处处关闭> } */
export function takeChanges(s) {
  const c = s.changes || { put: new Set(), del: new Map() };
  delete s.changes;
  return c;
}

/* ---------- 推导视图 ---------- */

/**
 * 从节点推导每个容器的有序列表和每个节点的实际父容器。
 * 自我修复（不写回存储，各设备推导结果一致）：
 * - 父文件夹不存在、文件夹放进了置顶/今日 → 归到收藏顶层
 * - 多设备同时移动造成的文件夹循环 → 环里 id 最小的那个归到收藏顶层
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
  const order = { [PINNED]: [], [ROOT]: [], [TODAY]: [] };
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

const inToday = (n) => !!n && n.type === 'link' && n.parent === TODAY;

/** 置顶 + 收藏（含所有文件夹内）的网址集合，不含今日 */
export function savedUrlSet(s, v = view(s)) {
  const out = new Set();
  for (const n of Object.values(s.nodes)) {
    if (n.type === 'link' && v.parent[n.id] !== TODAY) out.add(normUrl(n.url));
  }
  return out;
}

/* ---------- 修改 ---------- */

/** 把 n 放到 parentKey 列表的第 index 位（index 不含 n 自己） */
function place(s, n, parentKey, index, v) {
  const list = v.order[parentKey].filter((id) => id !== n.id);
  const i = index == null || index < 0 || index > list.length ? list.length : index;
  const prev = s.nodes[list[i - 1]]?.pos;
  const next = s.nodes[list[i]]?.pos;
  let pos;
  if (prev == null && next == null) pos = 0;
  else if (prev == null) pos = next - 1;
  else if (next == null) pos = prev + 1;
  else if (next - prev > 1e-6) pos = (prev + next) / 2;
  else {
    // 两个邻居的排序值挨得太近，整列重新编号
    list.splice(i, 0, n.id);
    list.forEach((id, k) => {
      const m = s.nodes[id];
      if (m.pos !== k || m.parent !== parentKey) {
        m.pos = k;
        m.parent = parentKey;
        touch(s, m);
      }
    });
    return;
  }
  n.parent = parentKey;
  n.pos = pos;
  touch(s, n);
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
  if (parent === PINNED || parent === TODAY) throw new Error('该区域不能放文件夹');
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
  touch(s, n);
  return true;
}

export function setCollapsed(s, id, collapsed) {
  const n = s.nodes[id];
  if (n?.type !== 'folder' || !!n.collapsed === !!collapsed) return false;
  n.collapsed = !!collapsed;
  touch(s, n);
  return true;
}

/** 设置文件夹颜色；color 为空表示不设颜色 */
export function setColor(s, id, color) {
  const n = s.nodes[id];
  const c = FOLDER_COLORS.includes(color) ? color : undefined;
  if (n?.type !== 'folder' || n.color === c) return false;
  if (c) n.color = c;
  else delete n.color;
  touch(s, n);
  return true;
}

/**
 * 清除「今日」里本机没有打开的条目，返回清除的条数。
 * 不带「处处关闭」：别的设备上还开着的标签不会被关，它们下次对账时会重新出现在今日里；
 * 哪台设备都没开着的条目就此消失。
 */
export function clearUnopenedToday(s, openUrls = []) {
  const open = new Set([...openUrls].map(normUrl));
  const v = view(s);
  let count = 0;
  for (const id of v.order[TODAY]) {
    if (!open.has(normUrl(s.nodes[id].url))) {
      remove(s, id);
      count++;
    }
  }
  return count;
}

/** 删除节点；文件夹连同里面的内容一起删。close=true 表示「今日」条目要在所有设备上关掉对应标签 */
export function remove(s, id, { close = false } = {}) {
  if (!s.nodes[id]) return false;
  const v = view(s);
  const rec = (x) => {
    for (const c of v.order[x] || []) rec(c);
    drop(s, x, close && v.parent[x] === TODAY);
  };
  rec(id);
  return true;
}

/** 把 id 移到 parent 列表的 index 位置（index 是移动前目标列表里的下标） */
export function move(s, id, parent, index) {
  const n = s.nodes[id];
  const v = view(s);
  if (!n || !v.order[parent]) return false;
  if (n.type === 'folder' && (parent === PINNED || parent === TODAY || isInside(v, parent, id))) return false;
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

/** 侧栏发给后台的操作。侧栏先在本地副本上执行一次（立即显示），后台再执行一次（权威结果） */
export function applyOp(s, op, a = {}) {
  switch (op) {
    case 'addFolder':
      return addFolder(s, { id: a.id, title: a.title }, a.parent ?? ROOT, a.index);
    case 'rename':
      return rename(s, a.id, a.title);
    case 'setCollapsed':
      return setCollapsed(s, a.id, a.collapsed);
    case 'setColor':
      return setColor(s, a.id, a.color);
    case 'clearToday':
      return clearUnopenedToday(s, a.openUrls || []);
    case 'remove':
      return remove(s, a.id);
    case 'closeToday':
      return remove(s, a.id, { close: true });
    case 'move':
      return move(s, a.id, a.parent, a.index);
    case 'pin':
      return pin(s, a.id, a.index);
    case 'unpin':
      return unpin(s, a.id);
    default:
      throw new Error('未知操作: ' + op);
  }
}

/* ---------- 「今日」与本机标签对账 ---------- */

/**
 * 「今日」是跨设备的待继续列表。本函数把本机打开的标签同步进去，规则：
 * - 同一网址只留一条（id 最小的，各设备结论一致）；已在置顶/收藏里的网址不进今日。
 *   去重删除不会关闭任何设备上的标签。
 * - 已绑定的标签：标题变了 → 更新标题；在本机导航到新网址 → 条目跟着更新
 *   （旧网址在本机别的标签里还开着时，改为给这个标签新建一条）；
 *   导航到已收藏的网址 → 只解绑，条目保留，显示为未打开。
 * - 未绑定的标签：网址已在今日 → 绑定上去；否则新建一条。
 * - 这里不删除任何条目（去重除外）。删除只发生在 tabClosed() 和侧栏 ✕。
 *
 * bindings: { [tabId]: { id, url: 绑定时的 normUrl, title: 上次同步的标题 } }，只在本机本次会话有效。
 * skip:     正在被关闭的 tabId，不参与对账，避免关闭途中又被加回来。
 */
export function reconcileTabs(s, tabs, bindings = {}, skip = new Set()) {
  const b = { ...bindings };
  let v = view(s);
  const saved = savedUrlSet(s, v);

  // 1. 去重：网址重复或已收藏的今日条目
  const keep = new Map(); // normUrl -> 今日条目 id
  for (const id of [...v.order[TODAY]].sort()) {
    const n = s.nodes[id];
    const nu = normUrl(n.url);
    if (!isSyncableTabUrl(n.url) || saved.has(nu) || keep.has(nu)) remove(s, id);
    else keep.set(nu, id);
  }

  // 2. 逐个标签处理
  const open = tabs
    .filter((t) => t.id != null && !t.incognito && !skip.has(t.id))
    .sort((a, c) => a.windowId - c.windowId || a.index - c.index);

  for (const t of open) {
    const tid = String(t.id);
    const url = tabUrl(t);
    const nu = normUrl(url);
    const title = clip(t.title || '');
    if (!isSyncableTabUrl(url) || url.length > MAX_URL) {
      delete b[tid];
      continue;
    }

    let bd = b[tid];
    if (bd) {
      const n = s.nodes[bd.id];
      if (!inToday(n)) {
        bd = null;
      } else if (bd.url === nu) {
        if (normUrl(n.url) !== nu) {
          // 别的设备把这条改成了别的网址：本标签另起一条
          bd = null;
        } else {
          if (title && title !== bd.title) {
            if (n.title !== title) {
              n.title = title;
              touch(s, n);
            }
            b[tid] = { ...bd, title };
          }
          continue;
        }
      } else {
        // 本机标签导航到了新网址
        if (saved.has(nu)) {
          delete b[tid];
          continue;
        }
        const other = keep.get(nu);
        if (other) {
          b[tid] = { id: other, url: nu, title };
          continue;
        }
        const oldStillOpen = open.some(
          (o) => o !== t && b[String(o.id)]?.id === bd.id && normUrl(tabUrl(o)) === bd.url,
        );
        if (!oldStillOpen) {
          if (keep.get(normUrl(n.url)) === n.id) keep.delete(normUrl(n.url));
          n.url = url;
          n.title = title || url;
          touch(s, n);
          keep.set(nu, n.id);
          b[tid] = { id: n.id, url: nu, title };
          continue;
        }
        bd = null;
      }
      delete b[tid];
    }

    if (saved.has(nu)) continue;
    const existing = keep.get(nu);
    if (existing) {
      b[tid] = { id: existing, url: nu, title };
      continue;
    }
    const id = addLink(s, { title: title || url, url }, TODAY);
    keep.set(nu, id);
    b[tid] = { id, url: nu, title };
  }

  // 3. 指向已不在今日的条目的绑定作废
  for (const [tid, bd] of Object.entries(b)) if (!inToday(s.nodes[bd.id])) delete b[tid];
  return { bindings: b };
}

/**
 * 本机关掉了一个标签。只有「单独关掉这个标签」才删除条目并在所有设备上关闭；
 * 关整个窗口、退出浏览器不删。本机还有别的标签开着同一网址时也不删。
 */
export function tabClosed(s, tabId, bindings, openTabs, { windowClosing = false } = {}) {
  const b = { ...bindings };
  const bd = b[String(tabId)];
  delete b[String(tabId)];
  if (!bd || windowClosing) return { bindings: b, removed: null };
  const n = s.nodes[bd.id];
  if (!inToday(n)) return { bindings: b, removed: null };
  const nu = normUrl(n.url);
  if (bd.url !== nu) return { bindings: b, removed: null }; // 条目已被别的设备改成别的网址
  const stillOpen = openTabs.some((t) => t.id !== tabId && !t.incognito && normUrl(tabUrl(t)) === nu);
  if (stillOpen) return { bindings: b, removed: null };
  remove(s, n.id, { close: true });
  for (const [tid, x] of Object.entries(b)) if (x.id === n.id) delete b[tid];
  return { bindings: b, removed: n.id };
}

/**
 * 别的设备「处处关闭」了一些今日条目（closed: [{ id, url }]），算出本机要关的标签：
 * 绑定在这些条目上的标签，以及网址相同、且本机没有收藏这个网址的标签。
 */
export function tabsToClose(s, closed, tabs, bindings) {
  const saved = savedUrlSet(s);
  const ids = new Set(closed.map((c) => c.id));
  const urls = new Set(closed.map((c) => normUrl(c.url)).filter((u) => u && !saved.has(u)));
  return tabs
    .filter((t) => !t.incognito && (ids.has(bindings[String(t.id)]?.id) || urls.has(normUrl(tabUrl(t)))))
    .map((t) => t.id);
}

/* ---------- 旧版数据迁移 ---------- */

/** 0.3.x 的整份 state（{ nodes, order }）转成新格式节点 */
export function fromLegacy(old) {
  const out = {};
  if (!old || typeof old !== 'object' || !old.nodes || !old.order) return out;
  const now = Date.now();
  for (const [key, list] of Object.entries(old.order)) {
    if (!Array.isArray(list)) continue;
    list.forEach((id, i) => {
      const n = old.nodes[id];
      if (!n || out[id] || !isValidId(id) || (n.type !== 'link' && n.type !== 'folder')) return;
      if (n.type === 'link' && !n.url) return;
      out[id] = {
        id,
        type: n.type,
        title: clip(n.title || n.url || '新文件夹'),
        ...(n.type === 'link' ? { url: n.url } : { collapsed: !!n.collapsed }),
        parent: key,
        pos: i,
        t: now,
      };
    });
  }
  return out;
}
