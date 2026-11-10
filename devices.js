// 「其他电脑」：每台电脑把自己开着的网页整理成一份清单，写进 chrome.storage.sync，各写各的；
// 别的电脑只读、只显示，不改。纯函数，不依赖 chrome API，可在 node 里测。
//
// sync 里的键（deviceId 是每台电脑第一次运行时随机生成的，存在 storage.local）：
//   dv:<deviceId>      { nm: 名字, at: 最后更新时间, n: 清单分成几块, tot: 一共几个网页, sk: 放不下没同步的个数 }
//   dt:<deviceId>:<i>  第 i 块清单：[[网址, 标题], ...]
// Chrome 同步存储单项最多 8KB、总共约 100KB，所以清单分块存，每台电脑最多 MAX_CHUNKS 块，放不下的不同步。

import { normUrl } from './model.js';

export const META = 'dv:';
export const CHUNK = 'dt:';
export const VIEW_KEY = 'viewRev'; // storage.session：后台每次上传完更新它（带同步状态），侧栏监听
export const MAX_CHUNKS = 3;
export const CHUNK_BYTES = 7600; // 单项 8192 字节，留点余量
export const MAX_URL = 2048;
export const MAX_TITLE = 120;

const enc = new TextEncoder();
export const utf8Len = (str) => enc.encode(str).length;
/** chrome 计算单项大小的方式：key 的字节数 + JSON.stringify(value) 的字节数 */
export const itemBytes = (key, value) => utf8Len(key) + utf8Len(JSON.stringify(value));

export const isDeviceId = (id) => typeof id === 'string' && /^[a-z0-9]{4,32}$/.test(id);
export const metaKey = (id) => META + id;
export const chunkKey = (id, i) => `${CHUNK}${id}:${i}`;

const isWeb = (u) => /^https?:\/\//i.test(u || '');

/**
 * 本机要上传的网页：所有窗口里的 http / https 标签，按窗口、标签栏顺序；
 * 同一网址只留一个；新标签页、chrome:// 页面、扩展自己的页面、无痕窗口、网址特别长的不上传。
 */
export function buildSnapshot(tabs) {
  const seen = new Set();
  const out = [];
  const list = [...tabs].sort((a, b) => (a.windowId ?? 0) - (b.windowId ?? 0) || (a.index ?? 0) - (b.index ?? 0));
  for (const t of list) {
    const url = t.url || t.pendingUrl || '';
    if (t.incognito || !isWeb(url) || url.length > MAX_URL) continue;
    const k = normUrl(url);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push([url, String(t.title || '').slice(0, MAX_TITLE)]);
  }
  return out;
}

/** 把清单按大小切块；放不下 maxChunks 块的部分丢掉，返回 { chunks, skipped } */
export function packChunks(items, deviceId, { maxChunks = MAX_CHUNKS, limit = CHUNK_BYTES } = {}) {
  const chunks = [];
  let cur = [];
  let skipped = 0;
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const key = chunkKey(deviceId, chunks.length);
    if (cur.length && itemBytes(key, [...cur, it]) > limit) {
      chunks.push(cur);
      cur = [];
      if (chunks.length >= maxChunks) {
        skipped = items.length - i;
        break;
      }
    }
    if (itemBytes(chunkKey(deviceId, chunks.length), [it]) > limit) {
      skipped++; // 单条就超过一块（标题和网址都已截短，基本不会发生）
      continue;
    }
    cur.push(it);
  }
  if (cur.length && chunks.length < maxChunks) chunks.push(cur);
  return { chunks, skipped };
}

/**
 * 一次上传要写什么、删什么。prevChunks 是上次写过几块：这次块数变少时，把多出来的旧块删掉。
 * opts.sent 是上次写进去的每一块（JSON 字符串）：内容没变的块这次不再写。
 * 返回的 sent 是这次之后同步存储里每一块应有的内容，留着下次比较。
 */
export function writePlan(deviceId, name, at, items, prevChunks = 0, opts = {}) {
  const { chunks, skipped } = packChunks(items, deviceId, opts);
  const prev = Array.isArray(opts.sent) ? opts.sent : [];
  const set = { [metaKey(deviceId)]: { nm: name, at, n: chunks.length, tot: items.length, sk: skipped } };
  const sent = chunks.map((c) => JSON.stringify(c));
  chunks.forEach((c, i) => {
    if (sent[i] !== prev[i]) set[chunkKey(deviceId, i)] = c;
  });
  const remove = [];
  for (let i = chunks.length; i < prevChunks; i++) remove.push(chunkKey(deviceId, i));
  return { set, remove, chunks: chunks.length, sent };
}

/**
 * 解析 sync 里所有设备的清单（不含本机）。按最后更新时间从新到旧。
 * 某一块还没同步过来时，先显示已到的部分。
 */
export function parseDevices(all = {}, selfId = '') {
  const out = [];
  for (const [k, m] of Object.entries(all)) {
    if (!k.startsWith(META) || !m || typeof m !== 'object') continue;
    const id = k.slice(META.length);
    if (!isDeviceId(id) || id === selfId) continue;
    const tabs = [];
    for (let i = 0; i < (Number(m.n) || 0); i++) {
      const c = all[chunkKey(id, i)];
      if (!Array.isArray(c)) continue;
      for (const e of c) {
        if (Array.isArray(e) && typeof e[0] === 'string' && isWeb(e[0])) tabs.push({ url: e[0], title: String(e[1] || '') });
      }
    }
    out.push({ id, name: String(m.nm || '另一台电脑'), at: Number(m.at) || 0, tabs, skipped: Number(m.sk) || 0 });
  }
  return out.sort((a, b) => b.at - a.at || (a.id < b.id ? -1 : 1));
}

/** 某台设备在 sync 里的所有键（移除设备时用） */
export function deviceKeys(all, deviceId) {
  return Object.keys(all).filter((k) => k === metaKey(deviceId) || k.startsWith(`${CHUNK}${deviceId}:`));
}

const OS_NAMES = { mac: 'Mac', win: 'Windows', linux: 'Linux', cros: 'ChromeOS' };

/** 扩展读不到电脑名，默认用系统名加设备 id 后 4 位，用户可以在设置里改 */
export function defaultName(os, deviceId) {
  return `${OS_NAMES[os] || '电脑'} · ${String(deviceId).slice(-4)}`;
}

export function cleanName(name) {
  return String(name ?? '').trim().slice(0, 40);
}

/** 「刚刚」「3 分钟前」「2 小时前」「昨天 22:10」「10月31日」 */
export function relTime(at, now = Date.now()) {
  if (!at) return '';
  const d = Math.max(0, now - at);
  if (d < 60e3) return '刚刚';
  if (d < 3600e3) return `${Math.floor(d / 60e3)} 分钟前`;
  const a = new Date(at);
  const n = new Date(now);
  const hm = `${String(a.getHours()).padStart(2, '0')}:${String(a.getMinutes()).padStart(2, '0')}`;
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((day(n) - day(a)) / 86400e3);
  if (days === 0) return `${Math.floor(d / 3600e3)} 小时前`;
  if (days === 1) return `昨天 ${hm}`;
  return `${a.getMonth() + 1}月${a.getDate()}日`;
}
