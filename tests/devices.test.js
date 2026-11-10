import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as D from '../devices.js';

const tab = (id, url, title = url, extra = {}) => ({ id, url, title, windowId: 1, index: id, ...extra });

test('清单：只要普通网页，按窗口和标签栏顺序，同网址只留一个', () => {
  const items = D.buildSnapshot([
    tab(3, 'https://c.com/', 'C'),
    tab(1, 'https://a.com/', 'A'),
    tab(2, 'chrome://newtab/', '新标签页'),
    tab(4, 'https://a.com/#x', 'A 再开一个'),
    tab(5, 'https://secret.com/', 'S', { incognito: true }),
    tab(6, 'chrome-extension://abc/sidepanel.html'),
    tab(0, 'https://b.com/', 'B', { windowId: 2 }),
    tab(7, 'https://long.com/' + 'x'.repeat(3000)),
  ]);
  assert.deepEqual(items.map((x) => x[1]), ['A', 'C', 'B']);
});

test('清单分块：每块不超过单项上限，放不下的记为没同步', () => {
  const items = Array.from({ length: 400 }, (_, i) => [`https://example.com/page/${i}?q=${'z'.repeat(60)}`, '标题'.repeat(20)]);
  const { chunks, skipped } = D.packChunks(items, 'devabc1');
  assert.equal(chunks.length, D.MAX_CHUNKS);
  chunks.forEach((c, i) => assert.ok(D.itemBytes(D.chunkKey('devabc1', i), c) <= D.CHUNK_BYTES));
  assert.equal(chunks.flat().length + skipped, 400);
  assert.ok(skipped > 0);
  const small = D.packChunks(items.slice(0, 5), 'devabc1');
  assert.deepEqual([small.chunks.length, small.skipped], [1, 0]);
});

test('上传计划：块数变少时删掉多出来的旧块', () => {
  const p = D.writePlan('devabc1', '公司', 1000, [['https://a.com/', 'A']], 3);
  assert.deepEqual(Object.keys(p.set).sort(), ['dt:devabc1:0', 'dv:devabc1']);
  assert.deepEqual(p.set['dv:devabc1'], { nm: '公司', at: 1000, n: 1, tot: 1, sk: 0 });
  assert.deepEqual(p.remove, ['dt:devabc1:1', 'dt:devabc1:2']);
});

test('上传计划：内容没变的块不再写，只写变了的块和概要', () => {
  const items = Array.from({ length: 120 }, (_, i) => [`https://example.com/page/${i}?q=${'z'.repeat(60)}`, '标题'.repeat(10)]);
  const first = D.writePlan('devabc1', '公司', 1000, items);
  assert.ok(first.chunks >= 2);
  assert.equal(Object.keys(first.set).length, first.chunks + 1); // 第一次：每一块 + 概要
  assert.deepEqual(first.sent, Array.from({ length: first.chunks }, (_, i) => JSON.stringify(first.set[`dt:devabc1:${i}`])));
  // 只在末尾多开一个网页：前面的块不动
  const more = [...items.slice(0, -1), ['https://new.test/', '新开的']];
  const second = D.writePlan('devabc1', '公司', 2000, more, first.chunks, { sent: first.sent });
  assert.deepEqual(Object.keys(second.set).sort(), [`dt:devabc1:${first.chunks - 1}`, 'dv:devabc1']);
  assert.equal(second.set['dv:devabc1'].at, 2000);
  // 什么都没变：只写概要（更新时间）
  const third = D.writePlan('devabc1', '公司', 3000, more, second.chunks, { sent: second.sent });
  assert.deepEqual(Object.keys(third.set), ['dv:devabc1']);
  // 不给上次的内容（心跳、改名）：整份重写
  const full = D.writePlan('devabc1', '公司', 4000, more, second.chunks);
  assert.equal(Object.keys(full.set).length, full.chunks + 1);
  // 和整份重写的结果拼起来一样
  const merged = { ...first.set, ...second.set };
  for (const k of Object.keys(full.set)) if (k.startsWith('dt:')) assert.deepEqual(merged[k], full.set[k]);
});

test('读取其他电脑：不含本机，最近更新的在前，块没到齐先显示已到的', () => {
  const all = {
    ...D.writePlan('devhome', '家里', 2000, [['https://h.com/', 'H']]).set,
    ...D.writePlan('devwork', '公司', 3000, [['https://w1.com/', 'W1'], ['https://w2.com/', 'W2']]).set,
    'dv:devlate': { nm: '笔记本', at: 1000, n: 2, tot: 3, sk: 0 },
    'dt:devlate:0': [['https://l.com/', 'L'], ['javascript:alert(1)', 'bad']],
    'n:oldnode1': { k: 'l', p: 'today' },
  };
  const devs = D.parseDevices(all, 'devhome');
  assert.deepEqual(devs.map((d) => d.name), ['公司', '笔记本']);
  assert.deepEqual(devs[0].tabs, [{ url: 'https://w1.com/', title: 'W1' }, { url: 'https://w2.com/', title: 'W2' }]);
  assert.deepEqual(devs[1].tabs.map((t) => t.title), ['L']); // 第 2 块还没到；非网页网址丢掉
  assert.deepEqual(D.deviceKeys(all, 'devwork').sort(), ['dt:devwork:0', 'dv:devwork']);
});

test('设备名和时间显示', () => {
  assert.equal(D.defaultName('mac', 'abcd1234'), 'Mac · 1234');
  assert.equal(D.cleanName('  公司  '), '公司');
  const now = new Date(2026, 10, 4, 15, 0).getTime();
  assert.equal(D.relTime(now - 20e3, now), '刚刚');
  assert.equal(D.relTime(now - 5 * 60e3, now), '5 分钟前');
  assert.equal(D.relTime(now - 3 * 3600e3, now), '3 小时前');
  assert.equal(D.relTime(new Date(2026, 10, 3, 22, 10).getTime(), now), '昨天 22:10');
  assert.equal(D.relTime(new Date(2026, 9, 31, 9, 0).getTime(), now), '10月31日');
});
