import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as M from '../model.js';

const titles = (s, key) => {
  const v = M.view(s);
  return v.order[key].map((id) => s.nodes[id].title);
};

test('添加、移动、排序、置顶', () => {
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
  M.unpin(s, a);
  assert.deepEqual(titles(s, M.ROOT), ['B', 'C', 'A']);
});

test('反复插到同一位置，顺序不乱', () => {
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

test('文件夹不能放进自己里面、不能放进置顶；循环会被打破', () => {
  const s = M.emptyState();
  const f1 = M.addFolder(s, { title: 'F1' });
  const f2 = M.addFolder(s, { title: 'F2' }, f1);
  assert.equal(M.move(s, f1, f2), false);
  assert.equal(M.move(s, f1, M.PINNED), false);
  assert.throws(() => M.addFolder(s, {}, M.PINNED));
  s.nodes[f1].parent = f2; // 模拟循环
  const v = M.view(s);
  const min = [f1, f2].sort()[0];
  assert.equal(v.parent[min], M.ROOT);
});

test('删除文件夹连同内容', () => {
  const s = M.emptyState();
  const f = M.addFolder(s, {});
  M.addLink(s, { title: 'L', url: 'https://l.com' }, f);
  M.remove(s, f);
  assert.equal(Object.keys(s.nodes).length, 0);
});

test('文件夹颜色：只接受 9 种颜色，只对文件夹生效', () => {
  const s = M.emptyState();
  const f = M.addFolder(s, {});
  const l = M.addLink(s, { title: 'L', url: 'https://l.com' });
  assert.equal(M.setColor(s, f, 'green'), true);
  assert.equal(s.nodes[f].color, 'green');
  assert.equal(M.setColor(s, f, 'green'), false);
  assert.equal(M.setColor(s, f, 'gold'), true); // 非法颜色 = 清除颜色
  assert.equal(s.nodes[f].color, undefined);
  assert.equal(M.setColor(s, l, 'red'), false);
});

test('侧栏本地预演：收藏一个标签；和树无关的操作不报错', () => {
  const s = M.emptyState();
  M.applyOp(s, 'saveTab', { url: 'https://x.com/', title: 'X', parent: M.PINNED });
  assert.deepEqual(titles(s, M.PINNED), ['X']);
  assert.equal(M.applyOp(s, 'setDeviceName', { name: '家里' }), false);
});

test('normUrl：忽略 #hash 和末尾斜杠', () => {
  assert.equal(M.normUrl('https://a.com/x/#top'), 'https://a.com/x');
  assert.equal(M.normUrl('https://a.com'), M.normUrl('https://a.com/'));
});

test('cleanTitle：去掉标题里的未读数，年份和普通标题不动', () => {
  assert.equal(M.cleanTitle('Inbox (479) - me@example.com - Gmail'), 'Inbox - me@example.com - Gmail');
  assert.equal(M.cleanTitle('收件箱 (1,204) - Gmail'), '收件箱 - Gmail');
  assert.equal(M.cleanTitle('(3) 首页 / X'), '首页 / X');
  assert.equal(M.cleanTitle('[12] 消息'), '消息');
  assert.equal(M.cleanTitle('（99+）飞书'), '飞书');
  assert.equal(M.cleanTitle('沙丘 (2024) - 豆瓣电影'), '沙丘 (2024) - 豆瓣电影');
  assert.equal(M.cleanTitle('f(x) 的用法 (2) - 文档'), 'f(x) 的用法 (2) - 文档');
  assert.equal(M.cleanTitle('GitLab'), 'GitLab');
  assert.equal(M.cleanTitle('(5)'), '(5)');
  assert.equal(M.cleanTitle(undefined), '');
});
