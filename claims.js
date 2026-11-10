// 置顶 / 收藏和标签的对应关系（「认领」）。纯函数，不依赖 chrome API，可在 node 里测。
//
// 规则（每个窗口各算各的；置顶和收藏本身是跨窗口共用的书签）：
// - 每个置顶 / 收藏在一个窗口里最多认领一个标签，一个标签也只属于一个置顶 / 收藏。
// - 认领以后，这个标签怎么跳转都还是它的（像 Arc），直到标签关掉。
// - 点置顶 / 收藏：有自己的标签 → 切过去；没有 → 认领这个窗口里一个还没被认领、和它匹配的标签；
//   都没有 → 在这个窗口新开一个并认领。
// - 匹配（只用于认领还没认领的标签）：网址完全一样 > 以它的网址开头（比如收藏 mail.google.com，
//   标签在 mail.google.com/mail/u/0/）。不按「同一个网站」认领：置顶了 GitHub 某个项目时，
//   窗口里另一个 GitHub 页面不该被认成它的。
//   同一个标签和好几个置顶 / 收藏都匹配时，只算匹配得最好的那几个。
// - Cmd+点击新开的、手动输入网址打开的标签都是普通标签，只有被上面的规则认领了才算。
//
// 认领记录存在 storage.session 的 claims:<窗口 id> = { 节点 id: 标签 id }，浏览器重启后清空。

import { normUrl } from './model.js';

export const keyOf = (winId) => 'claims:' + winId;

const tabUrl = (t) => t.url || t.pendingUrl || '';

/** 两边都已经用 normUrl 处理过。0 不匹配，2 以它的网址开头，3 网址一样 */
function scoreNorm(s, t) {
  if (!s || !t || !/^(https?|file):/i.test(t)) return 0;
  if (s === t) return 3;
  return t.startsWith(s) && '/?&#'.includes(t[s.length]) ? 2 : 0;
}

/** 0 不匹配，2 以它的网址开头，3 网址一样 */
export function matchScore(savedUrl, url) {
  return scoreNorm(normUrl(savedUrl), normUrl(url));
}

/**
 * links: 所有置顶 / 收藏里的网址节点 [{ id, url }]
 * winTabs: 这个窗口的标签
 * raw: 存着的认领记录 { 节点 id: 标签 id }
 * 返回 { tabFor(nodeId) → { tab, own } | null, ownerOf(tabId) → 节点 id | undefined, live }
 *   own=true：这个标签已经是它的；own=false：还没认领，点了会认领这个
 */
export function buildIndex(links, winTabs, raw = {}) {
  const byId = new Map(winTabs.map((t) => [t.id, t]));
  // 网址只整理一次：收藏和标签多的时候，两两比较时反复解析网址很慢
  const linkUrl = new Map(links.map((n) => [n.id, normUrl(n.url)]));
  const tabNorm = new Map(winTabs.map((t) => [t.id, normUrl(tabUrl(t))]));
  const nodeIds = linkUrl;
  const live = {}; // 节点 id -> 标签 id，只留标签还在这个窗口里的
  const owner = new Map(); // 标签 id -> 节点 id
  for (const [nid, tid] of Object.entries(raw)) {
    if (!nodeIds.has(nid) || !byId.has(tid) || owner.has(tid)) continue;
    live[nid] = tid;
    owner.set(tid, nid);
  }
  // 每个没被认领的标签，和所有置顶 / 收藏比，最高能匹配到几分
  const best = new Map();
  for (const t of winTabs) {
    if (owner.has(t.id)) continue;
    let b = 0;
    const tu = tabNorm.get(t.id);
    for (const su of linkUrl.values()) {
      const sc = scoreNorm(su, tu);
      if (sc > b) b = sc;
      if (b === 3) break;
    }
    if (b) best.set(t.id, b);
  }
  const cache = new Map();
  const tabFor = (nid) => {
    if (cache.has(nid)) return cache.get(nid);
    let r = null;
    if (live[nid] != null) r = { tab: byId.get(live[nid]), own: true };
    else {
      const su = linkUrl.get(nid);
      let pick = null;
      let ps = 0;
      for (const t of su ? winTabs : []) {
        const b = best.get(t.id);
        if (!b) continue;
        const sc = scoreNorm(su, tabNorm.get(t.id));
        if (sc !== b) continue; // 有别的置顶 / 收藏和它更匹配
        if (sc > ps || (sc === ps && (t.active && !pick.active))) {
          pick = t;
          ps = sc;
        }
      }
      if (pick) r = { tab: pick, own: false };
    }
    cache.set(nid, r);
    return r;
  };
  return { tabFor, ownerOf: (tid) => owner.get(tid), live };
}

/** 认领：记下 nid → tid；这个标签之前属于别的节点的话，从那个节点那里拿走 */
export function claim(raw = {}, nid, tid) {
  const out = {};
  for (const [k, v] of Object.entries(raw)) if (v !== tid && k !== nid) out[k] = v;
  out[nid] = tid;
  return out;
}

/** 去掉某个标签的认领，返回 { next, nodes: 被去掉的节点 id } */
export function release(raw = {}, tid) {
  const next = {};
  const nodes = [];
  for (const [k, v] of Object.entries(raw)) {
    if (v === tid) nodes.push(k);
    else next[k] = v;
  }
  return { next, nodes };
}
