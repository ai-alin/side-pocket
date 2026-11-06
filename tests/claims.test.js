import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../claims.js';

const tab = (id, url, extra = {}) => ({ id, url, title: url, windowId: 1, index: id, active: false, ...extra });
const A = { id: 'bkmA', url: 'https://mail.test/' };
const DOC1 = { id: 'bkmD1', url: 'https://docs.test/document/d/111/edit' };
const DOC2 = { id: 'bkmD2', url: 'https://docs.test/document/d/222/edit' };

test('匹配程度：网址一样 > 以它开头；同网站的其他页面不算', () => {
  assert.equal(C.matchScore('https://mail.test/', 'https://mail.test/#inbox'), 3);
  assert.equal(C.matchScore('https://mail.test/', 'https://mail.test/mail/u/0/'), 2);
  assert.equal(C.matchScore('https://a.test/x', 'https://a.test/xy'), 0);
  assert.equal(C.matchScore('https://github.test/me/repo', 'https://github.test/other/page'), 0);
  assert.equal(C.matchScore('https://mail.test/', 'https://other.test/'), 0);
  assert.equal(C.matchScore('https://mail.test/', 'chrome://newtab/'), 0);
});

test('A1 跳到别的网站，还是 A 的（像 Arc）', () => {
  const raw = C.claim({}, A.id, 1);
  const idx = C.buildIndex([A], [tab(1, 'https://youtube.test/watch')], raw);
  assert.deepEqual([idx.tabFor(A.id).tab.id, idx.tabFor(A.id).own], [1, true]);
  assert.equal(idx.ownerOf(1), A.id);
});

test('A1 开着时手动开了 A2：点 A 还是去 A1；A1 关掉后认领 A2，不重复开', () => {
  let raw = C.claim({}, A.id, 1);
  const tabs = [tab(1, 'https://mail.test/mail/u/0/'), tab(2, 'https://mail.test/', { active: true })];
  assert.equal(C.buildIndex([A], tabs, raw).tabFor(A.id).tab.id, 1);
  const idx = C.buildIndex([A], [tabs[1]], raw); // A1 关掉了
  const r = idx.tabFor(A.id);
  assert.deepEqual([r.tab.id, r.own], [2, false]); // 还没认领，点了才认领
  raw = C.claim(raw, A.id, 2);
  assert.equal(C.buildIndex([A], [tabs[1]], raw).tabFor(A.id).own, true);
});

test('没从侧栏打开过：网址以它开头的已开标签也算开着；无关页面不算', () => {
  assert.equal(C.buildIndex([A], [tab(5, 'https://mail.test/mail/u/0/')]).tabFor(A.id).tab.id, 5);
  const G = { id: 'bkmG', url: 'https://github.test/me/repo' };
  assert.equal(C.buildIndex([G], [tab(6, 'https://github.test/other/page')]).tabFor(G.id), null);
  assert.equal(C.buildIndex([A], [tab(5, 'https://other.test/')]).tabFor(A.id), null);
});

test('Cmd+点击从 A1 新开的标签是普通标签；它已有标签时不会被认领', () => {
  const raw = C.claim({}, A.id, 1);
  const idx = C.buildIndex([A], [tab(1, 'https://mail.test/'), tab(9, 'https://mail.test/mail/u/0/x', { openerTabId: 1 })], raw);
  assert.equal(idx.tabFor(A.id).tab.id, 1);
  assert.equal(idx.ownerOf(9), undefined);
});

test('同网站的两个收藏不互相抢标签', () => {
  const tabs = [tab(1, 'https://docs.test/document/d/222/edit#heading')];
  const idx = C.buildIndex([DOC1, DOC2], tabs);
  assert.equal(idx.tabFor(DOC1.id), null);
  assert.equal(idx.tabFor(DOC2.id).tab.id, 1);
});

test('一个标签只属于一个：认领时从别的节点那里拿走；标签已关的记录不算', () => {
  let raw = C.claim({}, DOC1.id, 1);
  raw = C.claim(raw, DOC2.id, 1);
  assert.deepEqual(raw, { [DOC2.id]: 1 });
  const idx = C.buildIndex([DOC2], [tab(3, 'https://x.test/')], raw); // 标签 1 不在这个窗口了
  assert.equal(idx.tabFor(DOC2.id), null);
  assert.deepEqual(C.release({ a: 1, b: 2 }, 1), { next: { b: 2 }, nodes: ['a'] });
});

test('每个窗口各算各的：别的窗口的标签不算', () => {
  const winTabs = [tab(1, 'https://other.test/')]; // 这个窗口里没有 Gmail
  assert.equal(C.buildIndex([A], winTabs).tabFor(A.id), null);
});
