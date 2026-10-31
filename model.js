// 数据模型（纯函数 + 原地修改，不依赖 chrome API，可在 node 里测试）
//
// state = {
//   v: 1,
//   nodes: { [id]: { id, type: 'link', title, url } | { id, type: 'folder', title, collapsed } },
//   order: {
//     pinned: [id...],      // 顶部「置顶」区，只放 link
//     root:   [id...],      // 「收藏」区顶层，可放 link 和 folder
//     today:  [id...],      // 「今日」同步临时标签区，只放 link
//     [folderId]: [id...],  // 每个文件夹的子项顺序（可多层嵌套）
//   }
// }
// 每个节点恰好出现在一个 order 列表里，节点的位置 = 它所在的列表 + 下标。

export const PINNED = 'pinned';
export const ROOT = 'root';
export const TODAY = 'today';

export function emptyState() {
  return { v: 1, nodes: {}, order: { [PINNED]: [], [ROOT]: [], [TODAY]: [] } };
}

export function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

/** 允许 http / https / file 标签页进入「今日」列表；过滤 chrome://、extension、about: 等内部页 */
export function isSyncableTabUrl(u) {
  if (!u || typeof u !== 'string') return false;
  try {
    const x = new URL(u);
    return x.protocol === 'http:' || x.protocol === 'https:' || x.protocol === 'file:';
  } catch {
    return false;
  }
}

/** 清理旧版本遗留的 dismissed:* 等非节点 ID 脏数据 */
export function sanitizeTabMap(rawMap) {
  const out = {};
  if (!rawMap || typeof rawMap !== 'object') return out;
  for (const [k, v] of Object.entries(rawMap)) {
    if (typeof v === 'string' && v && !v.startsWith('dismissed:')) {
      out[k] = v;
    }
  }
  return out;
}

/** 修复不一致：缺失的列表、悬空 id、重复出现、孤儿节点 */
export function normalize(s) {
  if (!s || typeof s !== 'object') return emptyState();
  s.v = 1;
  s.nodes = s.nodes && typeof s.nodes === 'object' ? s.nodes : {};
  s.order = s.order && typeof s.order === 'object' ? s.order : {};
  for (const k of [PINNED, ROOT, TODAY]) if (!Array.isArray(s.order[k])) s.order[k] = [];
  for (const [id, n] of Object.entries(s.nodes)) {
    if (n.type === 'folder' && !Array.isArray(s.order[id])) s.order[id] = [];
  }
  // 删除不对应文件夹的列表
  for (const k of Object.keys(s.order)) {
    if (k !== PINNED && k !== ROOT && k !== TODAY && s.nodes[k]?.type !== 'folder') delete s.order[k];
  }
  const seen = new Set();
  // 先扫描置顶、收藏、文件夹，最后扫描今日
  const keys = [
    PINNED,
    ROOT,
    ...Object.keys(s.order).filter((k) => k !== PINNED && k !== ROOT && k !== TODAY),
    TODAY,
  ];
  for (const k of keys) {
    if (!Array.isArray(s.order[k])) continue;
    s.order[k] = s.order[k].filter((id) => {
      const n = s.nodes[id];
      if (!n || seen.has(id) || id === k) return false;
      if ((k === PINNED || k === TODAY) && n.type !== 'link') return false;
      seen.add(id);
      return true;
    });
  }
  for (const id of Object.keys(s.nodes)) if (!seen.has(id)) s.order[ROOT].push(id); // 孤儿归到顶层
  return s;
}

export function parentOf(s, id) {
  for (const [k, arr] of Object.entries(s.order)) if (arr.includes(id)) return k;
  return null;
}

export function isContainer(s, key) {
  return key === PINNED || key === ROOT || key === TODAY || s.nodes[key]?.type === 'folder';
}

/** container 是否等于 folderId 或在它内部 */
export function isInside(s, container, folderId) {
  let cur = container;
  while (cur && cur !== ROOT && cur !== PINNED && cur !== TODAY) {
    if (cur === folderId) return true;
    cur = parentOf(s, cur);
  }
  return false;
}

function insert(s, parent, id, index) {
  const arr = s.order[parent];
  const i = index == null || index < 0 || index > arr.length ? arr.length : index;
  arr.splice(i, 0, id);
}

export function addLink(s, { title, url }, parent = ROOT, index) {
  if (!url) throw new Error('缺少 url');
  if (!isContainer(s, parent)) throw new Error('目标不存在: ' + parent);
  const id = newId();
  s.nodes[id] = { id, type: 'link', title: title || url, url };
  insert(s, parent, id, index);
  return id;
}

export function addFolder(s, title = '新文件夹', parent = ROOT, index) {
  if (parent === PINNED || parent === TODAY) throw new Error('该区域不能放文件夹');
  if (!isContainer(s, parent)) throw new Error('目标不存在: ' + parent);
  const id = newId();
  s.nodes[id] = { id, type: 'folder', title, collapsed: false };
  s.order[id] = [];
  insert(s, parent, id, index);
  return id;
}

export function rename(s, id, title) {
  const n = s.nodes[id];
  if (!n) return false;
  const t = String(title ?? '').trim();
  if (!t) return false;
  n.title = t;
  return true;
}

/** 删除节点；文件夹连同里面的内容一起删 */
export function remove(s, id) {
  const n = s.nodes[id];
  if (!n) return false;
  if (n.type === 'folder') for (const c of [...s.order[id]]) remove(s, c);
  const p = parentOf(s, id);
  if (p) s.order[p] = s.order[p].filter((x) => x !== id);
  delete s.order[id];
  delete s.nodes[id];
  return true;
}

/** 把 id 移动到 parent 列表的 index 位置（index 是移动前目标列表里的下标） */
export function move(s, id, parent, index) {
  const n = s.nodes[id];
  if (!n || !isContainer(s, parent)) return false;
  if (n.type === 'folder' && (parent === PINNED || parent === TODAY || isInside(s, parent, id))) return false;
  const from = parentOf(s, id);
  const arr = s.order[from];
  const oldIdx = arr.indexOf(id);
  arr.splice(oldIdx, 1);
  let i = index;
  if (from === parent && i != null && i > oldIdx) i -= 1;
  insert(s, parent, id, i);
  return true;
}

export function pin(s, id, index) {
  return s.nodes[id]?.type === 'link' && move(s, id, PINNED, index);
}

export function unpin(s, id) {
  return parentOf(s, id) === PINNED && move(s, id, ROOT);
}

export function countDescendants(s, id) {
  let c = 0;
  for (const x of s.order[id] || []) c += 1 + countDescendants(s, x);
  return c;
}

export function links(s) {
  return Object.values(s.nodes).filter((n) => n.type === 'link');
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

/** 置顶 + 收藏（含所有文件夹内）的 URL 集合，不含今日 */
export function savedUrlSet(s) {
  const todayIds = new Set(s.order?.[TODAY] || []);
  return new Set(
    links(s)
      .filter((n) => !todayIds.has(n.id))
      .map((n) => normUrl(n.url)),
  );
}

export function findTodayByUrl(s, url) {
  const target = normUrl(url);
  if (!target) return null;
  for (const id of s.order[TODAY] || []) {
    const n = s.nodes[id];
    if (n && normUrl(n.url) === target) return id;
  }
  return null;
}

/** 在今日区新增或更新一条链接（若已在置顶/收藏中则不重复加入） */
export function upsertToday(s, { title, url }, index) {
  normalize(s);
  if (!isSyncableTabUrl(url)) return null;
  const nu = normUrl(url);
  if (savedUrlSet(s).has(nu)) {
    const dup = findTodayByUrl(s, url);
    if (dup) {
      remove(s, dup);
      return { id: null, changed: true, created: false };
    }
    return null;
  }
  const existing = findTodayByUrl(s, url);
  if (existing) {
    const node = s.nodes[existing];
    const nextTitle = title || node.title || url;
    const changed = node.title !== nextTitle || node.url !== url;
    node.title = nextTitle;
    node.url = url;
    return { id: existing, changed, created: false };
  }
  const id = addLink(s, { title: title || url, url }, TODAY, index);
  return { id, changed: true, created: true };
}

/**
 * 将本机所有打开的非扩展标签页与同步 state.order.today 对账。
 * - 远端同步过来的今日条目（不在本机 tabMap 中、本机也没打开）：原样保留！
 * - 本机曾绑定在 tabMap 中、但现已关闭的 tab：从今日同步列表中移除。
 * - 本机当前打开的有效标签（且不在置顶/收藏中）：加入今日并记录到 tabMap。
 * - ignoredTabUrls: Map<tabId, normUrl>，仅存在于单次会话内存中，避免刚被远端关闭或正在异步关闭的 tab 在还没关完时被重加。
 */
export function reconcileToday(s, openTabs = [], prevTabMap = {}, ignoredTabUrls = null) {
  normalize(s);
  let changed = false;
  const tabMap = sanitizeTabMap(prevTabMap);
  const saved = savedUrlSet(s);

  // 1. 清理今日中已进入置顶/收藏或重复 URL 的条目
  const seenUrl = new Set();
  for (const id of [...s.order[TODAY]]) {
    const n = s.nodes[id];
    const nu = normUrl(n?.url);
    if (!n || !isSyncableTabUrl(n.url) || saved.has(nu) || seenUrl.has(nu)) {
      remove(s, id);
      changed = true;
    } else {
      seenUrl.add(nu);
    }
  }

  const openList = [...openTabs].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  const openIds = new Set(openList.map((t) => String(t.id)));
  const openUrls = new Set(
    openList
      .map((t) => t.url || t.pendingUrl || '')
      .filter(isSyncableTabUrl)
      .map(normUrl),
  );

  // 清理已关闭 tab 的内存忽略记录
  if (ignoredTabUrls instanceof Map) {
    for (const tid of [...ignoredTabUrls.keys()]) {
      if (!openIds.has(String(tid))) ignoredTabUrls.delete(tid);
    }
  }

  // 2. 检查本机之前绑定过、但现在已经关掉的 tabId -> 从同步今日列表中移除
  for (const [tid, nodeId] of Object.entries(tabMap)) {
    if (!openIds.has(String(tid))) {
      delete tabMap[tid];
      const n = s.nodes[nodeId];
      if (n && parentOf(s, nodeId) === TODAY) {
        if (!openUrls.has(normUrl(n.url))) {
          remove(s, nodeId);
          changed = true;
        }
      }
    }
  }

  // 3. 将本机当前打开的有效标签页同步/绑定到今日
  for (const t of openList) {
    const tid = String(t.id);
    const rawUrl = t.url || t.pendingUrl || '';
    const nu = normUrl(rawUrl);
    if (!isSyncableTabUrl(rawUrl) || saved.has(nu)) {
      if (tabMap[tid]) delete tabMap[tid];
      continue;
    }

    // 如果该 tab 当前 URL 在本次会话内存忽略表中（例如正在被关闭），跳过
    if (ignoredTabUrls instanceof Map && ignoredTabUrls.get(tid) === nu) {
      const byUrlId = findTodayByUrl(s, rawUrl);
      if (byUrlId) {
        ignoredTabUrls.delete(tid);
        tabMap[tid] = byUrlId;
      } else {
        continue;
      }
    }

    const boundId = tabMap[tid];
    const byUrlId = findTodayByUrl(s, rawUrl);

    if (boundId && s.nodes[boundId] && parentOf(s, boundId) === TODAY) {
      if (byUrlId && byUrlId !== boundId) {
        remove(s, boundId);
        tabMap[tid] = byUrlId;
        changed = true;
      } else {
        const node = s.nodes[boundId];
        const nextTitle = t.title || node.title || rawUrl;
        if (node.url !== rawUrl || node.title !== nextTitle) {
          node.url = rawUrl;
          node.title = nextTitle;
          changed = true;
        }
      }
      continue;
    }

    const res = upsertToday(s, { title: t.title || rawUrl, url: rawUrl });
    if (res?.id) {
      tabMap[tid] = res.id;
      if (res.changed) changed = true;
    }
  }

  // 4. 清理失效的 tabMap 绑定
  for (const [tid, nodeId] of Object.entries(tabMap)) {
    if (!s.nodes[nodeId] || parentOf(s, nodeId) !== TODAY) {
      delete tabMap[tid];
    }
  }

  return { changed, tabMap };
}

/**
 * 当收到远端同步过来的新 state 时，更新本机 tabMap（纯对象返回，绝不写入 dismissed:* 脏字符串）。
 */
export function syncRemoteToday(newState, openTabs = [], prevTabMap = {}, ignoredTabUrls = null) {
  normalize(newState);
  const tabMap = sanitizeTabMap(prevTabMap);
  const tabById = new Map(openTabs.map((t) => [String(t.id), t]));
  for (const [tid, val] of Object.entries(tabMap)) {
    const t = tabById.get(String(tid));
    if (!t) {
      delete tabMap[tid];
      continue;
    }
    if (!newState.nodes[val] || parentOf(newState, val) !== TODAY) {
      const rawUrl = t.url || t.pendingUrl || '';
      const existing = findTodayByUrl(newState, rawUrl);
      if (existing) {
        tabMap[tid] = existing;
      } else {
        delete tabMap[tid];
        if (ignoredTabUrls instanceof Map) {
          ignoredTabUrls.set(String(tid), normUrl(rawUrl));
        }
      }
    }
  }
  return tabMap;
}
