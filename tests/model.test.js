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

test('今日：已收藏的网址不进今日；收藏后今日里那条被去重', () => {
  const s = M.emptyState();
  M.addLink(s, { title: 'Saved', url: 'https://saved.com' });
  M.reconcileTabs(s, [tab(1, 'https://saved.com')]);
  assert.deepEqual(titles(s, M.TODAY), []);
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

test('文件夹颜色：只接受 9 种颜色，只对文件夹生效', () => {
  const s = M.emptyState();
  const f = M.addFolder(s, {});
  const l = M.addLink(s, { title: 'L', url: 'https://l.com' });
  M.takeChanges(s);
  assert.equal(M.setColor(s, f, 'green'), true);
  assert.equal(s.nodes[f].color, 'green');
  assert.ok(M.takeChanges(s).put.has(f));
  assert.equal(M.setColor(s, f, 'green'), false);
  assert.equal(M.setColor(s, f, 'gold'), true); // 非法颜色 = 清除颜色
  assert.equal(s.nodes[f].color, undefined);
  assert.equal(M.setColor(s, l, 'red'), false);
});

test('清除未打开：只删本机没开着的今日条目，且不触发处处关闭', () => {
  const s = M.emptyState();
  M.reconcileTabs(s, [tab(1, 'https://a.com'), tab(2, 'https://b.com'), tab(3, 'https://c.com')]);
  M.addLink(s, { title: 'Saved', url: 'https://saved.com' });
  M.takeChanges(s);
  const n = M.applyOp(s, 'clearToday', { openUrls: ['https://b.com/#top'] });
  assert.equal(n, 2);
  assert.deepEqual(titles(s, M.TODAY), ['https://b.com']);
  assert.deepEqual(titles(s, M.ROOT), ['Saved']);
  const c = M.takeChanges(s);
  assert.equal([...c.del.values()].some(Boolean), false);
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

test('今日：新打开的网页放在最上面', () => {
  const s = M.emptyState();
  let { bindings } = M.reconcileTabs(s, [tab(1, 'https://a.com', 'A'), tab(2, 'https://b.com', 'B')]);
  assert.deepEqual(titles(s, M.TODAY), ['A', 'B']); // 同一批：按标签栏顺序
  ({ bindings } = M.reconcileTabs(s, [tab(1, 'https://a.com', 'A'), tab(2, 'https://b.com', 'B'), tab(3, 'https://c.com', 'C')], bindings));
  assert.deepEqual(titles(s, M.TODAY), ['C', 'A', 'B']); // 新来的在最上面，已有的不动
  // 新标签在标签栏里的位置不影响：开在最左边也一样放最上面
  ({ bindings } = M.reconcileTabs(s, [tab(4, 'https://d.com', 'D', { index: 0 }), tab(1, 'https://a.com', 'A'), tab(2, 'https://b.com', 'B'), tab(3, 'https://c.com', 'C')], bindings));
  assert.deepEqual(titles(s, M.TODAY), ['D', 'C', 'A', 'B']);
});

test('今日：一批新网页作为一组放在最上面，组内保持标签栏顺序', () => {
  const s = M.emptyState();
  let { bindings } = M.reconcileTabs(s, [tab(1, 'https://old.com', 'Old')]);
  const batch = [tab(1, 'https://old.com', 'Old'), tab(2, 'https://x.com', 'X'), tab(3, 'https://y.com', 'Y'), tab(4, 'https://z.com', 'Z')];
  ({ bindings } = M.reconcileTabs(s, batch, bindings));
  assert.deepEqual(titles(s, M.TODAY), ['X', 'Y', 'Z', 'Old']);
});

test('今日：标签里跳到别的网址，条目位置不变', () => {
  const s = M.emptyState();
  let { bindings } = M.reconcileTabs(s, [tab(1, 'https://a.com', 'A'), tab(2, 'https://b.com', 'B')]);
  ({ bindings } = M.reconcileTabs(s, [tab(1, 'https://a.com', 'A'), tab(2, 'https://b.com', 'B'), tab(3, 'https://c.com', 'C')], bindings));
  assert.deepEqual(titles(s, M.TODAY), ['C', 'A', 'B']);
  ({ bindings } = M.reconcileTabs(s, [tab(1, 'https://a2.com', 'A2'), tab(2, 'https://b.com', 'B'), tab(3, 'https://c.com', 'C')], bindings));
  assert.deepEqual(titles(s, M.TODAY), ['C', 'A2', 'B']);
});

test('今日：一个标签一条；同网址开两个标签就是两条；标题跟着变', () => {
  const s = M.emptyState();
  let { bindings } = M.reconcileTabs(s, [tab(1, 'https://a.com', 'A'), tab(2, 'https://a.com/#x', 'A2'), tab(3, 'chrome://newtab')]);
  assert.deepEqual(titles(s, M.TODAY), ['A', 'A2']);
  assert.notEqual(bindings['1'].id, bindings['2'].id);
  assert.equal(bindings['3'], undefined); // 新标签页不进今日
  ({ bindings } = M.reconcileTabs(s, [tab(1, 'https://a.com', 'A (3)'), tab(2, 'https://a.com/#x', 'A2')], bindings));
  assert.deepEqual(titles(s, M.TODAY), ['A (3)', 'A2']);
});

test('今日：标签里点来点去只更新这一条', () => {
  const s = M.emptyState();
  let { bindings } = M.reconcileTabs(s, [tab(1, 'https://a.com/', 'A')]);
  const id = bindings['1'].id;
  for (const u of ['https://a.com/post/1', 'https://a.com/post/2', 'https://b.com/']) {
    ({ bindings } = M.reconcileTabs(s, [tab(1, u, u)], bindings));
  }
  assert.equal(bindings['1'].id, id);
  assert.deepEqual(titles(s, M.TODAY), ['https://b.com/']);
});

test('今日：中途经过 chrome:// 页面，回来后还是同一条', () => {
  const s = M.emptyState();
  let { bindings } = M.reconcileTabs(s, [tab(1, 'https://a.com/', 'A')]);
  const id = bindings['1'].id;
  ({ bindings } = M.reconcileTabs(s, [tab(1, 'chrome://settings/')], bindings));
  assert.deepEqual(titles(s, M.TODAY), ['A']);
  ({ bindings } = M.reconcileTabs(s, [tab(1, 'https://c.com/', 'C')], bindings));
  assert.equal(bindings['1'].id, id);
  assert.deepEqual(titles(s, M.TODAY), ['C']);
});

test('今日：跳到另一个标签开着的网址，不留下旧条目', () => {
  const s = M.emptyState();
  let { bindings } = M.reconcileTabs(s, [tab(1, 'https://a.com/', 'A'), tab(2, 'https://b.com/', 'B')]);
  ({ bindings } = M.reconcileTabs(s, [tab(1, 'https://b.com/', 'B'), tab(2, 'https://b.com/', 'B')], bindings));
  assert.deepEqual(titles(s, M.TODAY), ['B', 'B']); // 和 Chrome 一样：两个标签都在 b.com
  assert.notEqual(bindings['1'].id, bindings['2'].id);
});

test('今日：从置顶 / 收藏打开的标签归收藏管，在同一网站里怎么点都不进今日，换网站才进', () => {
  const s = M.emptyState();
  const saved = new Set([M.normUrl('https://mail.test/')]);
  let { bindings } = M.reconcileTabs(s, [tab(1, 'https://mail.test/')], {}, new Set(), saved);
  assert.equal(bindings['1'].own, 'saved');
  ({ bindings } = M.reconcileTabs(s, [tab(1, 'https://mail.test/inbox/123')], bindings, new Set(), saved));
  ({ bindings } = M.reconcileTabs(s, [tab(1, 'https://mail.test/inbox/456')], bindings, new Set(), saved));
  assert.deepEqual(titles(s, M.TODAY), []);
  ({ bindings } = M.reconcileTabs(s, [tab(1, 'https://other.com/', 'O')], bindings, new Set(), saved));
  assert.deepEqual(titles(s, M.TODAY), ['O']);
});

test('今日：标签跳到收藏过的网址，今日里这条去掉，不关标签', () => {
  const s = M.emptyState();
  const saved = new Set([M.normUrl('https://saved.com')]);
  let { bindings } = M.reconcileTabs(s, [tab(1, 'https://a.com', 'A')], {}, new Set(), saved);
  M.takeChanges(s);
  ({ bindings } = M.reconcileTabs(s, [tab(1, 'https://saved.com', 'Saved')], bindings, new Set(), saved));
  assert.equal(bindings['1'].own, 'saved');
  assert.deepEqual(titles(s, M.TODAY), []);
  assert.equal([...M.takeChanges(s).del.values()].some(Boolean), false);
});

test('今日：重启浏览器后标签编号变了，按网址认领原来的条目，不重复', () => {
  const s = M.emptyState();
  M.reconcileTabs(s, [tab(1, 'https://a.com', 'A'), tab(2, 'https://a.com', 'A'), tab(3, 'https://b.com', 'B')]);
  const before = titles(s, M.TODAY);
  const { bindings } = M.reconcileTabs(s, [tab(11, 'https://a.com', 'A'), tab(12, 'https://a.com', 'A'), tab(13, 'https://b.com', 'B')], {});
  assert.deepEqual(titles(s, M.TODAY), before);
  assert.equal(new Set(Object.values(bindings).map((b) => b.id)).size, 3);
});

test('今日：单独关标签才删除并处处关闭；关窗口保留；同网址另一个标签的条目保留', () => {
  const s = M.emptyState();
  const tabs = [tab(1, 'https://a.com'), tab(2, 'https://b.com'), tab(3, 'https://b.com')];
  let { bindings } = M.reconcileTabs(s, tabs);
  let r = M.tabClosed(s, 1, bindings, tabs.slice(1), { windowClosing: true });
  assert.equal(r.removed, null);
  assert.equal(titles(s, M.TODAY).length, 3);
  M.takeChanges(s);
  const keepId = r.bindings['3'].id;
  r = M.tabClosed(s, 2, r.bindings, [tabs[2]]);
  assert.ok(r.removed);
  assert.equal(M.takeChanges(s).del.get(r.removed), true);
  assert.ok(s.nodes[keepId], '本机还开着的另一个 b.com 的条目不删');
  assert.equal(titles(s, M.TODAY).length, 2);
});

test('处处关闭：同一网址别的电脑建的条目一起删，本机别的标签占着的不删', () => {
  const s = M.emptyState();
  const a = M.addLink(s, { id: 'mine1', title: 'X', url: 'https://x.com/' }, M.TODAY);
  M.addLink(s, { id: 'othr1', title: 'X', url: 'https://x.com/' }, M.TODAY); // 另一台电脑建的
  M.addLink(s, { id: 'mine2', title: 'X', url: 'https://x.com/' }, M.TODAY); // 本机另一个标签
  M.takeChanges(s);
  const closed = M.closeEverywhere(s, a, new Set(['mine2']));
  assert.deepEqual(closed.map((c) => c.id).sort(), ['mine1', 'othr1']);
  assert.deepEqual(Object.keys(s.nodes), ['mine2']);
});

test('侧栏分组：本机占着的在「这台电脑」，本机已开着的网址不在另一组重复', () => {
  const s = M.emptyState();
  M.addLink(s, { id: 'mine1', title: 'A', url: 'https://a.com/' }, M.TODAY);
  M.addLink(s, { id: 'othr1', title: 'A', url: 'https://a.com/' }, M.TODAY);
  M.addLink(s, { id: 'othr2', title: 'B', url: 'https://b.com/' }, M.TODAY);
  const g = M.todayGroups(s, new Set(['mine1']), new Set([M.normUrl('https://a.com/')]));
  assert.deepEqual(g.mine, ['mine1']);
  assert.deepEqual(g.others, ['othr2']);
});
