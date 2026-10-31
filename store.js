// 存储层：把整个 state 序列化成 JSON 后切片写入 chrome.storage.sync。
//
// sync 的键：
//   meta = { v, n, len, sum, rev, dev }   n=分片数, sum=校验和, rev=写入时间戳, dev=写入设备
//   c0, c1, ... c{n-1}                    每片是 JSON 字符串的一段
// 远端设备的变更可能分几次到达，读取时用 len + sum 校验，不完整就先忽略，等下一次 onChanged。
// 同时在 storage.local 里留一份镜像：sync 写失败（配额满）时数据不丢。

export const QUOTA = {
  BYTES: 102400, // 总量 100KB
  BYTES_PER_ITEM: 8192, // 单项 8KB（键名 + JSON 序列化后的值）
  MAX_ITEMS: 512,
};
export const CHUNK_BYTES = 7000; // 每片留足余量
export const MAX_CHUNKS = 13; // 13*7000 + meta < 100KB

const enc = new TextEncoder();
export const utf8Len = (str) => enc.encode(str).length;

/** chrome 计算单项大小的方式：key.length + JSON.stringify(value) 的字节数 */
export const itemBytes = (key, value) => utf8Len(key) + utf8Len(JSON.stringify(value));

export function checksum(str) {
  let h = 0x811c9dc5; // FNV-1a
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

/** 按「JSON 序列化后的字节数」切片，不会把一个字符（含代理对）切开 */
export function splitChunks(str, maxBytes = CHUNK_BYTES) {
  const out = [];
  let cur = '';
  let bytes = 2; // 引号
  for (const ch of str) {
    const b = utf8Len(JSON.stringify(ch)) - 2;
    if (bytes + b > maxBytes && cur) {
      out.push(cur);
      cur = '';
      bytes = 2;
    }
    cur += ch;
    bytes += b;
  }
  if (cur || !out.length) out.push(cur);
  return out;
}

export class QuotaError extends Error {
  constructor(msg) {
    super(msg);
    this.name = 'QuotaError';
  }
}

export function encode(state, { rev, dev }) {
  const json = JSON.stringify(state);
  const chunks = splitChunks(json);
  if (chunks.length > MAX_CHUNKS) throw new QuotaError(`数据 ${utf8Len(json)} 字节，超出同步配额`);
  const items = { meta: { v: 1, n: chunks.length, len: json.length, sum: checksum(json), rev, dev } };
  chunks.forEach((c, i) => (items['c' + i] = c));
  let total = 0;
  for (const [k, v] of Object.entries(items)) {
    const b = itemBytes(k, v);
    if (b > QUOTA.BYTES_PER_ITEM) throw new QuotaError(`单项 ${k} 超过 8KB`);
    total += b;
  }
  if (total > QUOTA.BYTES) throw new QuotaError(`总量 ${total} 字节超过 100KB`);
  return items;
}

/** 返回 { state, meta } | null（没有数据）| { error } （不完整/损坏） */
export function decode(data) {
  const meta = data?.meta;
  if (!meta || !meta.n) return null;
  let json = '';
  for (let i = 0; i < meta.n; i++) {
    if (typeof data['c' + i] !== 'string') return { error: 'incomplete', meta };
    json += data['c' + i];
  }
  if (json.length !== meta.len || checksum(json) !== meta.sum) return { error: 'checksum', meta };
  try {
    return { state: JSON.parse(json), meta };
  } catch {
    return { error: 'parse', meta };
  }
}

export function classifyError(e) {
  const m = String(e?.message || e);
  // 不同 Chrome 版本措辞不同：旧版 "QUOTA_BYTES_PER_ITEM quota exceeded"，新版 "Resource::kQuotaBytesPerItem quota exceeded"
  if (/MAX_WRITE_OPERATIONS|MaxWriteOperations|MAX_SUSTAINED|MaxSustained/i.test(m)) return 'rate';
  if (e instanceof QuotaError || /quota|MAX_ITEMS|MaxItems/i.test(m)) return 'quota';
  return 'other';
}

/**
 * sync / local: 提供 Promise 风格 get(keys|null) / set(obj) / remove(keys) 的存储区
 * onStatus(status): 'saved' | 'saving' | 'quota' | 'rate' | 'error'
 */
export function createStore({ sync, local, deviceId, onStatus = () => {}, debounceMs = 400, retryMs = 60_000 }) {
  let lastRev = 0;
  let timer = null;
  let pending = null;
  let retryTimer = null;

  async function load() {
    const [syncData, localData] = await Promise.all([sync.get(null), local.get('mirror')]);
    const mirror = localData.mirror;
    const res = decode(syncData);
    // 本机有尚未同步上去、且比云端新的数据 -> 用本机的并重新上传
    if (mirror?.unsynced && (!res?.meta || mirror.rev > res.meta.rev)) {
      lastRev = mirror.rev;
      queueMicrotask(() => save(mirror.state));
      return { state: mirror.state, rev: mirror.rev, source: 'local' };
    }
    if (res?.state) {
      lastRev = res.meta.rev;
      return { state: res.state, rev: res.meta.rev, source: 'sync' };
    }
    if (res?.error) return { error: res.error, fallback: mirror?.state ?? null };
    if (mirror?.state) return { state: mirror.state, rev: mirror.rev, source: 'local' };
    return { state: null, rev: 0, source: 'empty' };
  }

  async function save(state) {
    clearTimeout(timer);
    pending = null;
    clearTimeout(retryTimer);
    const rev = Math.max(Date.now(), lastRev + 1);
    lastRev = rev;
    onStatus('saving');
    let items;
    try {
      items = encode(state, { rev, dev: deviceId });
      const old = (await sync.get('meta')).meta;
      await sync.set(items);
      await local.set({ mirror: { state, rev, unsynced: false } });
      // 清理多余的旧分片
      const stale = [];
      for (let i = items.meta.n; i < (old?.n || 0); i++) stale.push('c' + i);
      if (stale.length) await sync.remove(stale);
      onStatus('saved');
      return { ok: true, rev };
    } catch (e) {
      const kind = classifyError(e);
      await local.set({ mirror: { state, rev, unsynced: true } });
      onStatus(kind === 'other' ? 'error' : kind, e);
      if (kind === 'rate') retryTimer = setTimeout(() => save(state), retryMs); // 写入频率超限，稍后重试
      return { ok: false, kind, error: e };
    }
  }

  function saveSoon(state) {
    pending = state;
    clearTimeout(timer);
    timer = setTimeout(() => {
      const s = pending;
      pending = null;
      save(s);
    }, debounceMs);
  }

  async function flush() {
    if (!pending) return;
    clearTimeout(timer);
    const s = pending;
    pending = null;
    return save(s);
  }

  /** 来自 storage.onChanged 的变更是不是本机刚写的 */
  function isOwnChange(meta) {
    return meta && meta.dev === deviceId && meta.rev <= lastRev;
  }

  function dispose() {
    clearTimeout(timer);
    clearTimeout(retryTimer);
  }

  return { load, save, saveSoon, flush, isOwnChange, dispose, get lastRev() { return lastRev; } };
}
