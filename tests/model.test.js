import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as M from '../model.js';

const titles = (s, key) => {
  const v = M.view(s);
  return v.order[key].map((id) => s.nodes[id].title);
};
const tab = (id, url, title = url, extra = {}) => ({ id, url, title, windowId: 1, index: id, ...extra });

test('添加、移动、排序', () => {
  const s = M.emptyState();
  const a = M.addLink(s, { title: 'A', url: 'https://a.com' });
  M.addLink(s, { title: 'B', url: 'https://b.com' });
  M.addLink(s, { title: 'C', url: 'https://c.com' });
  assert.deepEqual(titles(s, M.ROOT), ['A', 'B', 'C']);
  M.move(s, a, M.ROOT, 3);
  assert.deepEqual(titles(s, M.ROOT), ['B', 'C', 'A']);
  M.move(s, a, M.ROOT, 0);
  assert.deepEqual(titles(s, M.ROOT), ['A', 'B', 'C']);
  M.pin(s, a);
  assert.deepEqual(titles(s, M.PINNED), ['A']);
  assert.deepEqual(titles(s, M.ROOT), ['B', 'C']);
});

test('反复插到同一位置会触发重新编号，顺序不乱', () => {
  const s = M.emptyState();
  M.addLink(s, { title: 'first', url: 'https://0.com' });
  M.addLink(s, { title: 'last', url: 'https://z.com' });
  for (let i = 0; i < 80; i++) M.addLink(s, { title: 'x' + i, url: `https://${i}.x` }, M.ROOT, 1);
  const t = titles(s, M.ROOT);
  assert.equal(t[0], 'first');
  assert.equal(t[1], 'x79');
  assert.equal(t.at(-2), 'x0');
  assert.equal(t.at(-1), 'last');
});

test('文件夹不能放进自己里面；并发造成的循环会被打破', () => {
  const s = M.emptyState();
  const f1 = M.addFolder(s, { title: 'F1' });
  const f2 = M.addFolder(s, { title: 'F2' }, f1);
  assert.equal(M.move(s, f1, f2), false);
  // 模拟两台设备各自把对方移进自己：f1 -> f2, f2 -> f1
  s.nodes[f1].parent = f2;
  const v = M.view(s);
  const min = [f1, f2].sort()[0];
  assert.equal(v.parent[min], M.ROOT);
  assert.equal(M.countDescendants(v, M.ROOT) >= 0, true);
  assert.equal(v.order[M.ROOT].includes(min), true);
});

test('删除文件夹连同内容，并记录变更', () => {
  const s = M.emptyState();
  const f = M.addFolder(s, {});
  const l = M.addLink(s, { title: 'L', url: 'https://l.com' }, f);
  M.takeChanges(s);
  M.remove(s, f);
  const c = M.takeChanges(s);
  assert.deepEqual([...c.del.keys()].sort(), [f, l].sort());
  assert.equal(Object.keys(s.nodes).length, 0);
});

test('今日：打开标签加入，标题变化更新，同网址只留一条', () => {
  const s = M.emptyState();
  let { bindings } = M.reconcileTabs(s, [tab(1, 'https://a.com', 'A'), tab(2, 'https://a.com/#x', 'A2'), tab(3, 'chrome://newtab')]);
  assert.deepEqual(titles(s, M.TODAY), ['A']);
  assert.equal(bindings['1'].id, bindings['2'].id);
  assert.equal(bindings['3'], undefined);
  ({ bindings } = M.reconcileTabs(s, [tab(1, 'https://a.com', 'A (3)'), tab(2, 'https://a.com/#x', 'A2')], bindings));
  assert.deepEqual(titles(s, M.TODAY), ['A (3)']);
});

test('今日：已收藏的网址不进今日；收藏后今日里那条被去重', () => {
  const s = M.emptyState();
  M.addLink(s, { title: 'Saved', url: 'https://saved.com' });
  M.reconcileTabs(s, [tab(1, 'https://saved.com')]);
  assert.deepEqual(titles(s, M.TODAY), []);
});

test('今日：本机导航，条目跟着变；导航到收藏网址只解绑不删', () => {
  const s = M.emptyState();
  M.addLink(s, { title: 'Saved', url: 'https://saved.com' });
  let { bindings } = M.reconcileTabs(s, [tab(1, 'https://a.com', 'A')]);
  const id = bindings['1'].id;
  ({ bindings } = M.reconcileTabs(s, [tab(1, 'https://b.com', 'B')], bindings));
  assert.equal(bindings['1'].id, id);
  assert.equal(s.nodes[id].url, 'https://b.com');
  ({ bindings } = M.reconcileTabs(s, [tab(1, 'https://saved.com', 'Saved')], bindings));
  assert.equal(bindings['1'], undefined);
  assert.deepEqual(titles(s, M.TODAY), ['B']);
});

test('今日：单独关标签才删除并处处关闭；关窗口保留；同网址还开着不删', () => {
  const s = M.emptyState();
  const tabs = [tab(1, 'https://a.com'), tab(2, 'https://b.com'), tab(3, 'https://b.com')];
  let { bindings } = M.reconcileTabs(s, tabs);
  // 关窗口
  let r = M.tabClosed(s, 1, bindings, tabs.slice(1), { windowClosing: true });
  assert.equal(r.removed, null);
  assert.equal(titles(s, M.TODAY).length, 2);
  // 同网址还有别的标签
  r = M.tabClosed(s, 2, r.bindings, [tabs[2]]);
  assert.equal(r.removed, null);
  // 最后一个 b.com 单独关掉
  M.takeChanges(s);
  r = M.tabClosed(s, 3, r.bindings, []);
  assert.ok(r.removed);
  assert.equal(M.takeChanges(s).del.get(r.removed), true);
  assert.deepEqual(titles(s, M.TODAY), ['https://a.com']);
});

test('今日：别的设备把条目改成别的网址，本机旧标签另起一条，不来回覆盖', () => {
  const s = M.emptyState();
  let { bindings } = M.reconcileTabs(s, [tab(1, 'https://a.com', 'A')]);
  const id = bindings['1'].id;
  s.nodes[id].url = 'https://moved.com'; // 远端改动
  s.nodes[id].title = 'Moved';
  M.takeChanges(s);
  ({ bindings } = M.reconcileTabs(s, [tab(1, 'https://a.com', 'A')], bindings));
  assert.equal(s.nodes[id].url, 'https://moved.com');
  assert.notEqual(bindings['1'].id, id);
  assert.deepEqual(titles(s, M.TODAY).sort(), ['A', 'Moved']);
});

test('tabsToClose：按绑定和网址找，跳过本机已收藏的网址', () => {
  const s = M.emptyState();
  M.addLink(s, { title: 'S', url: 'https://saved.com' });
  const tabs = [tab(1, 'https://a.com'), tab(2, 'https://saved.com'), tab(3, 'https://x.com'), tab(4, 'https://a.com', 'a', { incognito: true })];
  const ids = M.tabsToClose(s, [{ id: 'zzzz1', url: 'https://a.com/' }, { id: 'zzzz2', url: 'https://saved.com' }], tabs, { 3: { id: 'zzzz2' } });
  assert.deepEqual(ids.sort(), [1, 3]);
});

test('旧格式迁移', () => {
  const old = {
    v: 1,
    nodes: {
      aaaa1: { id: 'aaaa1', type: 'link', title: 'A', url: 'https://a.com' },
      ffff1: { id: 'ffff1', type: 'folder', title: 'F', collapsed: true },
      bbbb1: { id: 'bbbb1', type: 'link', title: 'B', url: 'https://b.com' },
      tttt1: { id: 'tttt1', type: 'link', title: 'T', url: 'https://t.com' },
    },
    order: { pinned: ['aaaa1'], root: ['ffff1'], today: ['tttt1'], ffff1: ['bbbb1'] },
  };
  const s = { nodes: M.fromLegacy(old) };
  assert.deepEqual(titles(s, M.PINNED), ['A']);
  assert.deepEqual(titles(s, 'ffff1'), ['B']);
  assert.deepEqual(titles(s, M.TODAY), ['T']);
  assert.equal(s.nodes.ffff1.collapsed, true);
});
