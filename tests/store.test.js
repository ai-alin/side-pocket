import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as M from '../model.js';
import { createEngine, LOCAL_KEY, ITEM_LIMIT } from '../store.js';

/** 模拟 chrome.storage 的一个区域；quotaBytes 用来模拟配额 */
function area(obj = {}, { quotaBytes = Infinity } = {}) {
  const size = () => Object.entries(obj).reduce((n, [k, v]) => n + k.length + JSON.stringify(v).length, 0);
  return {
    obj,
    writes: 0,
    async get(k) {
      if (k == null) return structuredClone(obj);
      const o = {};
      for (const x of [].concat(k)) if (x in obj) o[x] = structuredClone(obj[x]);
      return o;
    },
    async set(o) {
      const backup = structuredClone(obj);
      Object.assign(obj, structuredClone(o));
      if (size() > quotaBytes) {
        for (const key of Object.keys(obj)) delete obj[key];
        Object.assign(obj, backup);
        throw new Error('Resource::kQuotaBytes quota exceeded');
      }
      this.writes++;
    },
    async remove(ks) {
      for (const k of [].concat(ks)) delete obj[k];
    },
  };
}

async function device(cloud, deviceId) {
  const local = area();
  const e = createEngine({ sync: cloud, local, deviceId });
  await e.init();
  return { e, local };
}
const titles = (e, key) => {
  const v = M.view(e.state);
  return v.order[key].map((id) => e.state.nodes[id].title);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const T = (id, url, title = url) => ({ id, index: id, windowId: 1, url, title });

test('两台设备同时改不同条目，互不覆盖（旧版会丢数据的场景）', async () => {
  const cloud = area();
  const A = await device(cloud, 'devA');
  await A.e.apply((s) => M.addLink(s, { title: 'Gmail', url: 'https://mail.google.com' }));
  await A.e.flush();
  const B = await device(cloud, 'devB');
  assert.deepEqual(titles(B.e, M.ROOT), ['Gmail']);

  await B.e.apply((s) => M.addLink(s, { title: '重要资料', url: 'https://example.com/important' }));
  await B.e.flush();
  // A 还没收到 B 的更新，本机今日有变化，照样上传
  await A.e.apply((s) => M.reconcileTabs(s, [T(1, 'https://news.ycombinator.com', 'HN')]));
  await A.e.flush();

  await A.e.mergeRemote();
  await B.e.mergeRemote();
  for (const d of [A, B]) {
    assert.deepEqual(titles(d.e, M.ROOT).sort(), ['Gmail', '重要资料']);
    assert.deepEqual(titles(d.e, M.TODAY), ['HN']);
  }
});

test('同一条目两边都改，修改时间晚的赢', async () => {
  const cloud = area();
  const A = await device(cloud, 'devA');
  const id = await A.e.apply((s) => M.addLink(s, { title: 'X', url: 'https://x.com' }));
  await A.e.flush();
  const B = await device(cloud, 'devB');
  await A.e.apply((s) => M.rename(s, id, 'A 改的'));
  await sleep(5);
  await B.e.apply((s) => M.rename(s, id, 'B 改的（更晚）'));
  await B.e.flush();
  await A.e.mergeRemote();
  await A.e.flush();
  await B.e.mergeRemote();
  assert.equal(A.e.state.nodes[id].title, 'B 改的（更晚）');
  assert.equal(B.e.state.nodes[id].title, 'B 改的（更晚）');
});

test('删除优先：一边删、一边改，最终删掉，不会复活', async () => {
  const cloud = area();
  const A = await device(cloud, 'devA');
  const id = await A.e.apply((s) => M.addLink(s, { title: 'X', url: 'https://x.com' }));
  await A.e.flush();
  const B = await device(cloud, 'devB');
  await A.e.apply((s) => M.remove(s, id));
  await A.e.flush();
  await sleep(5);
  await B.e.apply((s) => M.rename(s, id, '改名'));
  await B.e.mergeRemote();
  await B.e.flush();
  await A.e.mergeRemote();
  assert.equal(B.e.state.nodes[id], undefined);
  assert.equal(A.e.state.nodes[id], undefined);
  assert.equal(cloud.obj['n:' + id], undefined);
});

test('处处关闭：家里关掉条目，公司合并时得到要关的标签；关窗口不删', async () => {
  const cloud = area();
  const work = await device(cloud, 'work');
  let wb = (await work.e.apply((s) => M.reconcileTabs(s, [T(1, 'https://a.com', 'A'), T(2, 'https://b.com', 'B')]))).bindings;
  await work.e.flush();

  const home = await device(cloud, 'home');
  await home.e.apply((s) => M.reconcileTabs(s, [T(7, 'https://a.com', 'A')]));
  assert.deepEqual(titles(home.e, M.TODAY), ['A', 'B']);

  // 家里点 ✕ 关掉 B（家里没开着 B）
  const idB = Object.values(wb).find((x) => x.url === 'https://b.com').id;
  await home.e.apply((s) => M.applyOp(s, 'closeToday', { id: idB }));
  await home.e.flush();

  const res = await work.e.mergeRemote();
  assert.deepEqual(res.closed.map((c) => c.url), ['https://b.com']);
  const toClose = M.tabsToClose(work.e.state, res.closed, [T(1, 'https://a.com'), T(2, 'https://b.com')], wb);
  assert.deepEqual(toClose, [2]);

  // 公司关窗口：A 保留，家里依然能看到
  wb = (await work.e.apply((s) => M.tabClosed(s, 1, wb, [], { windowClosing: true }))).bindings;
  await work.e.flush();
  await home.e.mergeRemote();
  assert.deepEqual(titles(home.e, M.TODAY), ['A']);
});

test('公司关机期间家里关了条目：公司重启后合并，会话恢复的同网址标签被关掉', async () => {
  const cloud = area();
  const work = await device(cloud, 'work');
  await work.e.apply((s) => M.reconcileTabs(s, [T(1, 'https://a.com', 'A')]));
  await work.e.flush();
  const home = await device(cloud, 'home');
  const id = M.view(home.e.state).order[M.TODAY][0];
  await home.e.apply((s) => M.applyOp(s, 'closeToday', { id }));
  await home.e.flush();
  // 公司重启：同一份本地副本，新的引擎实例
  const work2 = createEngine({ sync: cloud, local: work.local, deviceId: 'work' });
  const res = await work2.init();
  assert.deepEqual(res.closed.map((c) => c.url), ['https://a.com']);
  assert.deepEqual(M.tabsToClose(work2.state, res.closed, [T(50, 'https://a.com')], {}), [50]);
});

test('重启后 tab id 全变：会话恢复的标签按网址重新绑定，不重复', async () => {
  const cloud = area();
  const d = await device(cloud, 'pc');
  await d.e.apply((s) => M.reconcileTabs(s, [T(1, 'https://a.com', 'A')]));
  await d.e.flush();
  const d2 = createEngine({ sync: cloud, local: d.local, deviceId: 'pc' });
  await d2.init();
  const r = await d2.apply((s) => M.reconcileTabs(s, [T(99, 'https://a.com', 'A')], {}));
  assert.equal(Object.keys(d2.state.nodes).length, 1);
  assert.ok(r.bindings['99']);
});

test('两台设备各自给同一网址建了今日条目：合并后只剩一条，且不关闭标签', async () => {
  const cloud = area();
  const A = await device(cloud, 'devA');
  const B = await device(cloud, 'devB');
  await A.e.apply((s) => M.reconcileTabs(s, [T(1, 'https://same.com', 'S')]));
  await sleep(3);
  await B.e.apply((s) => M.reconcileTabs(s, [T(1, 'https://same.com', 'S')]));
  await A.e.flush();
  await B.e.flush();
  await A.e.mergeRemote();
  await A.e.apply((s) => M.reconcileTabs(s, [T(1, 'https://same.com', 'S')]));
  await A.e.flush();
  const res = await B.e.mergeRemote();
  await B.e.apply((s) => M.reconcileTabs(s, [T(1, 'https://same.com', 'S')]));
  assert.deepEqual(res.closed, []);
  assert.equal(titles(A.e, M.TODAY).length, 1);
  assert.equal(titles(B.e, M.TODAY).length, 1);
});

test('文件夹颜色跨设备同步', async () => {
  const cloud = area();
  const A = await device(cloud, 'devA');
  const f = await A.e.apply((s) => M.addFolder(s, { title: '工作' }));
  await A.e.apply((s) => M.setColor(s, f, 'orange'));
  await A.e.flush();
  const B = await device(cloud, 'devB');
  assert.equal(B.e.state.nodes[f].color, 'orange');
  await B.e.apply((s) => M.setColor(s, f, null));
  await B.e.flush();
  await A.e.mergeRemote();
  assert.equal(A.e.state.nodes[f].color, undefined);
});

test('迁移 0.3.x 的切片数据，并清掉旧键', async () => {
  const old = {
    v: 1,
    nodes: { aaaa1: { id: 'aaaa1', type: 'link', title: 'A', url: 'https://a.com' } },
    order: { pinned: ['aaaa1'], root: [], today: [] },
  };
  const json = JSON.stringify(old);
  let h = 0x811c9dc5;
  for (let i = 0; i < json.length; i++) {
    h ^= json.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  const cloud = area({ meta: { v: 1, n: 1, len: json.length, sum: (h >>> 0).toString(16), rev: 1, dev: 'x' }, c0: json });
  const d = await device(cloud, 'pc');
  assert.deepEqual(titles(d.e, M.PINNED), ['A']);
  await d.e.flush();
  assert.equal(cloud.obj.meta, undefined);
  assert.equal(cloud.obj.c0, undefined);
  assert.ok(cloud.obj['n:aaaa1']);
  assert.ok(d.local.obj[LOCAL_KEY]);
});

test('配额不够时先保住收藏，今日单独报错并保留待重试', async () => {
  const cloud = area({}, { quotaBytes: 900 });
  const statuses = [];
  const e = createEngine({ sync: cloud, local: area(), deviceId: 'pc', onStatus: (k) => statuses.push(k) });
  await e.init();
  await e.apply((s) => M.addLink(s, { title: '收藏', url: 'https://keep.com' }));
  const tabs = Array.from({ length: 12 }, (_, i) => T(i, `https://site${i}.com/${'p'.repeat(40)}`, 'T' + i));
  await e.apply((s) => M.reconcileTabs(s, tabs));
  const r = await e.flush();
  assert.equal(r.kind, 'quota');
  assert.ok(Object.values(cloud.obj).some((v) => v.ti === '收藏'));
  assert.ok(e.pendingCount() > 0);
  assert.equal(statuses.at(-1), 'quota');
});

test('一次 flush 只算一次写入；没有改动时不写', async () => {
  const cloud = area();
  const d = await device(cloud, 'pc');
  await d.e.apply((s) => {
    for (let i = 0; i < 20; i++) M.addLink(s, { title: 'L' + i, url: `https://${i}.com` });
  });
  await d.e.flush();
  assert.equal(cloud.writes, 1);
  await d.e.flush();
  await d.e.mergeRemote();
  await d.e.flush();
  assert.equal(cloud.writes, 1);
});

test('超大条目不上传、不反复重试', async () => {
  const cloud = area();
  const d = await device(cloud, 'pc');
  await d.e.apply((s) => M.addLink(s, { title: 'big', url: 'https://x.com/?q=' + 'a'.repeat(ITEM_LIMIT) }));
  const r = await d.e.flush();
  assert.equal(r.kind, 'toolarge');
  assert.equal(d.e.pendingCount(), 0);
});
