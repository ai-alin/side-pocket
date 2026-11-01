// 存储层：每个节点一个 chrome.storage.sync 键，按条目同步与合并。
//
// sync 的键：
//   n:<id>      一个节点（紧凑格式，见 packNode）
//   d:<设备id>  该设备删除过的节点 { id: [删除时间, 是否处处关闭] }
//               用来区分「被删了」和「还没同步到」，也用来让别的设备关掉对应标签
// storage.local：
//   state2 = { nodes, pending: { put: [id], del: [[id, close]] } }   本机完整副本 + 尚未上传的改动
//
// 只上传改动过的条目，一次 set 算 Chrome 的一次写入。
// 两台设备改不同条目互不影响；同一条目两边都改了，修改时间晚的赢；删除优先于修改。

import * as M from './model.js';

export const QUOTA = { BYTES: 102400, BYTES_PER_ITEM: 8192, MAX_ITEMS: 512 };
export const ITEM_LIMIT = 8000;
export const LOCAL_KEY = 'state2';
/** storage.session 里的小键：后台每次改完数据就更新它，侧栏只监听这一个键 */
export const VIEW_KEY = 'viewRev';
export const LOG_KEEP_MS = 30 * 24 * 3600 * 1000;
const LOG_BYTES = 7000;
const NODE = 'n:';
const LOG = 'd:';

const enc = new TextEncoder();
export const utf8Len = (str) => enc.encode(str).length;
/** chrome 计算单项大小的方式：key 的字节数 + JSON.stringify(value) 的字节数 */
export const itemBytes = (key, value) => utf8Len(key) + utf8Len(JSON.stringify(value));

export function classifyError(e) {
  const m = String(e?.message || e);
  // 不同 Chrome 版本措辞不同：旧版 "QUOTA_BYTES_PER_ITEM quota exceeded"，新版 "Resource::kQuotaBytesPerItem quota exceeded"
  if (/MAX_WRITE_OPERATIONS|MaxWriteOperations|MAX_SUSTAINED|MaxSustained/i.test(m)) return 'rate';
  if (/quota|MAX_ITEMS|MaxItems/i.test(m)) return 'quota';
  return 'other';
}

/* ---------- 编码 ---------- */

export function packNode(n) {
  const o = { k: n.type === 'folder' ? 'f' : 'l', ti: n.title, p: n.parent, o: n.pos, t: n.t };
  if (n.type === 'folder') {
    if (n.collapsed) o.c = 1;
  } else {
    o.u = n.url;
  }
  return o;
}

export function unpackNode(id, o) {
  if (!o || typeof o !== 'object' || !M.isValidId(id)) return null;
  const type = o.k === 'f' ? 'folder' : o.k === 'l' ? 'link' : null;
  if (!type || typeof o.p !== 'string') return null;
  if (type === 'link' && typeof o.u !== 'string') return null;
  const n = { id, type, title: String(o.ti ?? ''), parent: o.p, pos: Number(o.o) || 0, t: Number(o.t) || 0 };
  if (type === 'link') n.url = o.u;
  else n.collapsed = !!o.c;
  return n;
}

function sameNode(a, b) {
  return JSON.stringify(packNode(a)) === JSON.stringify(packNode(b));
}

/** 解析整份 sync 数据 */
export function parseSync(data = {}) {
  const nodes = {};
  const logs = new Map();
  const deleted = new Map(); // id -> { ts, close }
  for (const [k, val] of Object.entries(data)) {
    if (k.startsWith(NODE)) {
      const n = unpackNode(k.slice(NODE.length), val);
      if (n) nodes[n.id] = n;
    } else if (k.startsWith(LOG) && val && typeof val === 'object') {
      logs.set(k.slice(LOG.length), val);
      for (const [id, e] of Object.entries(val)) {
        const [ts, close] = Array.isArray(e) ? e : [0, 0];
        const prev = deleted.get(id);
        deleted.set(id, { ts: Math.max(ts, prev?.ts || 0), close: !!close || !!prev?.close });
      }
    }
  }
  const legacyKeys = Object.keys(data).filter((k) => k === 'meta' || /^c\d+$/.test(k));
  return { nodes, logs, deleted, legacyKeys };
}

/** 删除日志：丢掉 30 天前的记录，并控制在单项 8KB 以内（保留最新的） */
export function pruneLog(log, now = Date.now()) {
  const entries = Object.entries(log)
    .filter(([, e]) => Array.isArray(e) && now - e[0] < LOG_KEEP_MS)
    .sort((a, b) => b[1][0] - a[1][0]);
  const out = {};
  let bytes = 20;
  for (const [id, e] of entries) {
    bytes += utf8Len(JSON.stringify(id)) + utf8Len(JSON.stringify(e)) + 2;
    if (bytes > LOG_BYTES) break;
    out[id] = e;
  }
  return out;
}

/* ---------- 旧版（0.3.x）整份切片格式，只用于迁移 ---------- */

function legacyChecksum(str) {
  let h = 0x811c9dc5; // FNV-1a
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

export function legacyDecode(data) {
  const meta = data?.meta;
  if (!meta || !meta.n) return null;
  let json = '';
  for (let i = 0; i < meta.n; i++) {
    if (typeof data['c' + i] !== 'string') return null;
    json += data['c' + i];
  }
  if (json.length !== meta.len || legacyChecksum(json) !== meta.sum) return null;
  try {
    return { state: JSON.parse(json), rev: meta.rev || 0 };
  } catch {
    return null;
  }
}

/* ---------- 引擎 ---------- */

/**
 * sync / local：Promise 风格的 get(keys|null) / set(obj) / remove(keys)
 * onStatus(kind, err)：'saved' | 'quota' | 'rate' | 'toolarge' | 'error'
 */
export function createEngine({ sync, local, deviceId, onStatus = () => {}, now = Date.now }) {
  const s = M.emptyState();
  let put = new Set();
  let del = new Map(); // id -> close
  let myLog = {};
  let removeLater = new Set(); // 要从 sync 里清掉的键：已删节点残留、旧版格式
  let tooBig = new Set();
  let version = 0;
  const logKey = LOG + deviceId;

  function absorb() {
    const c = M.takeChanges(s);
    for (const id of c.put) {
      put.add(id);
      del.delete(id);
    }
    for (const [id, close] of c.del) {
      put.delete(id);
      del.set(id, close || !!del.get(id));
    }
    return c.put.size + c.del.size > 0;
  }

  async function persist() {
    version++;
    await local.set({ [LOCAL_KEY]: { nodes: s.nodes, pending: { put: [...put], del: [...del] } } });
  }

  /** 把 sync 数据合并进本机副本，返回 { changed, closed: 被别的设备处处关闭的今日条目 } */
  function mergeData(data) {
    const r = parseSync(data);
    myLog = r.logs.get(deviceId) || myLog;
    const next = {};
    const closed = [];
    let changed = false;

    for (const [id, rn] of Object.entries(r.nodes)) {
      if (r.deleted.has(id)) {
        removeLater.add(NODE + id); // 删除日志说它已被删，键却还在（旧设备写回来的）
        continue;
      }
      if (del.has(id)) continue;
      const ln = s.nodes[id];
      if (put.has(id) && ln && (ln.t || 0) >= (rn.t || 0)) {
        next[id] = ln; // 本机改动更新，等上传
        continue;
      }
      put.delete(id);
      next[id] = rn;
      if (!ln || !sameNode(ln, rn)) changed = true;
    }

    for (const [id, ln] of Object.entries(s.nodes)) {
      if (id in next) continue;
      const d = r.deleted.get(id);
      if (put.has(id) && !d) {
        next[id] = ln; // 本机新建 / 修改、还没上传
        continue;
      }
      // 云端没有了：被别的设备删掉（删除优先于本机修改）
      put.delete(id);
      changed = true;
      if (d?.close && ln.type === 'link' && ln.parent === M.TODAY) closed.push({ id, url: ln.url });
    }

    s.nodes = next;
    return { changed, closed };
  }

  /** 首次运行新版本：把旧格式数据导入 */
  function migrate(data, mirror) {
    const r = parseSync(data);
    for (const k of r.legacyKeys) removeLater.add(k);
    if (Object.keys(r.nodes).length) return; // 别的设备已经迁移过，直接用云端的
    const fromSync = legacyDecode(data);
    let old = fromSync?.state;
    if (mirror?.state && (!fromSync || (mirror.unsynced && mirror.rev > fromSync.rev))) old = mirror.state;
    const nodes = M.fromLegacy(old);
    for (const [id, n] of Object.entries(nodes)) {
      if (r.deleted.has(id)) continue;
      s.nodes[id] = n;
      put.add(id);
    }
  }

  async function init() {
    const got = await local.get([LOCAL_KEY, 'mirror', 'todayTabMap']);
    const cache = got[LOCAL_KEY];
    const data = await sync.get(null);
    if (cache) {
      s.nodes = cache.nodes || {};
      put = new Set(cache.pending?.put || []);
      del = new Map(cache.pending?.del || []);
    } else {
      migrate(data, got.mirror);
    }
    const res = mergeData(data);
    if (got.mirror || got.todayTabMap) await local.remove(['mirror', 'todayTabMap']);
    await persist();
    return res;
  }

  async function mergeRemote() {
    const res = mergeData(await sync.get(null));
    if (res.changed) await persist();
    return res;
  }

  /** 在 state 上执行修改（会被 model.js 记录为变更），返回 fn 的结果 */
  async function apply(fn) {
    const out = fn(s);
    if (absorb()) await persist();
    return out;
  }

  function pendingCount() {
    let c = del.size + removeLater.size;
    for (const id of put) if (!tooBig.has(id)) c++;
    return c;
  }

  async function flush() {
    if (!pendingCount()) return { ok: true, idle: true };
    const t0 = now();
    const snapPut = new Map([...put].map((id) => [id, s.nodes[id]?.t]));
    const snapDel = new Map(del);
    const saved = {};
    const today = {};
    tooBig = new Set();
    for (const id of snapPut.keys()) {
      const n = s.nodes[id];
      if (!n) {
        put.delete(id);
        continue;
      }
      const key = NODE + id;
      const val = packNode(n);
      if (itemBytes(key, val) > ITEM_LIMIT) {
        tooBig.add(id);
        continue;
      }
      (n.parent === M.TODAY ? today : saved)[key] = val;
    }
    const logItem = {};
    if (snapDel.size) {
      const log = { ...myLog };
      for (const [id, close] of snapDel) log[id] = [t0, close ? 1 : 0];
      logItem[logKey] = pruneLog(log, t0);
    }
    const removeKeys = [...[...snapDel.keys()].map((id) => NODE + id), ...removeLater];

    const setIf = async (obj) => {
      if (Object.keys(obj).length) await sync.set(obj);
    };
    let todayError = null;
    try {
      try {
        await setIf({ ...saved, ...logItem, ...today });
      } catch (e) {
        // 配额不够时先保住收藏和删除记录，今日条目单独再试
        if (classifyError(e) !== 'quota' || !Object.keys(today).length) throw e;
        await setIf({ ...saved, ...logItem });
        try {
          await setIf(today);
        } catch (e2) {
          todayError = e2;
        }
      }
      if (logItem[logKey]) myLog = logItem[logKey];
      // 先写删除日志、再删键，别的设备收到时一定能查到删除原因
      if (removeKeys.length) await sync.remove(removeKeys);

      const written = Object.keys(saved).concat(todayError ? [] : Object.keys(today));
      for (const key of written) {
        const id = key.slice(NODE.length);
        if (s.nodes[id]?.t === snapPut.get(id)) put.delete(id);
      }
      for (const id of snapDel.keys()) del.delete(id);
      for (const k of removeKeys) removeLater.delete(k);
      await persist();

      if (todayError) {
        onStatus('quota', todayError);
        return { ok: false, kind: 'quota' };
      }
      if (tooBig.size) {
        onStatus('toolarge');
        return { ok: false, kind: 'toolarge' };
      }
      onStatus('saved');
      return { ok: true };
    } catch (e) {
      const kind = classifyError(e);
      onStatus(kind === 'other' ? 'error' : kind, e);
      return { ok: false, kind, error: e };
    }
  }

  return {
    init,
    mergeRemote,
    apply,
    flush,
    pendingCount,
    get state() {
      return s;
    },
    get version() {
      return version;
    },
  };
}
