import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as M from '../model.js';
import * as B from '../bookmarks.js';

/** 模拟 chrome.bookmarks：0 是根，1 是书签栏，2 是其他书签；move 的 index 按 Chrome 的规则（移动前的插入位置） */
function mockBm() {
  let next = 10;
  const all = new Map();
  const mk = (o) => {
    const n = { id: String(o.id ?? next++), parentId: o.parentId, title: o.title || '', dateAdded: next++ };
    if (o.url) n.url = o.url;
    else n.children = [];
    if (o.folderType) n.folderType = o.folderType;
    all.set(n.id, n);
    if (o.parentId != null) {
      const p = all.get(o.parentId).children;
      p.splice(o.index ?? p.length, 0, n.id);
    }
    return n;
  };
  mk({ id: '0' });
  mk({ id: '1', parentId: '0', title: '书签栏', folderType: 'bookmarks-bar' });
  mk({ id: '2', parentId: '0', title: '其他书签', folderType: 'other' });
  const pub = (n) => {
    const o = { id: n.id, parentId: n.parentId, title: n.title, dateAdded: n.dateAdded };
    if (n.parentId != null) o.index = all.get(n.parentId).children.indexOf(n.id);
    if (n.url) o.url = n.url;
    if (n.folderType) o.folderType = n.folderType;
    return o;
  };
  const tree = (id) => {
    const n = all.get(id);
    const o = pub(n);
    if (!n.url) o.children = n.children.map(tree);
    return o;
  };
  const detach = (n) => {
    const c = all.get(n.parentId).children;
    c.splice(c.indexOf(n.id), 1);
  };
  const drop = (id) => {
    for (const c of all.get(id).children || []) drop(c);
    all.delete(id);
  };
  const bm = {
    getChildren: async (id) => all.get(id).children.map((c) => pub(all.get(c))),
    getSubTree: async (id) => [tree(id)],
    create: async (o) => pub(mk({ parentId: o.parentId, title: o.title, url: o.url, index: o.index })),
    move: async (id, { parentId, index }) => {
      const n = all.get(id);
      const np = parentId ?? n.parentId;
      const oi = all.get(n.parentId).children.indexOf(id);
      let i = index ?? all.get(np).children.length;
      if (np === n.parentId && i > oi) i--;
      detach(n);
      n.parentId = np;
      all.get(np).children.splice(i, 0, id);
      return pub(n);
    },
    update: async (id, { title }) => {
      all.get(id).title = title;
      return pub(all.get(id));
    },
    remove: async (id) => {
      const n = all.get(id);
      if (n.children?.length) throw new Error('文件夹不是空的');
      detach(n);
      all.delete(id);
    },
    removeTree: async (id) => {
      detach(all.get(id));
      drop(id);
    },
    /** 测试用：某个书签文件夹下的标题列表 */
    titles: (id) => all.get(id).children.map((c) => all.get(c).title),
  };
  return bm;
}

const load = async (bm, ids, meta) => {
  const nodes = await B.loadNodes(bm, ids, meta);
  return { nodes, v: M.view({ nodes }) };
};
const titles = (nodes, v, key) => v.order[key].map((id) => nodes[id].title);
const idOf = (nodes, title) => Object.values(nodes).find((n) => n.title === title)?.id;

test('书签：第一次运行建好「其他书签 / Side Pocket / 置顶」，只读时不建', async () => {
  const bm = mockBm();
  assert.equal(await B.resolveRoot(bm), null);
  const ids = await B.resolveRoot(bm, { create: true });
  assert.deepEqual(bm.titles('2'), ['Side Pocket']);
  assert.deepEqual(bm.titles(ids.root), ['置顶']);
  assert.deepEqual(await B.resolveRoot(bm), ids);
  assert.deepEqual(await B.resolveRoot(bm, { create: true }), ids); // 再次运行不重复建
  assert.deepEqual(bm.titles('2'), ['Side Pocket']);
});

test('书签：有两个 Side Pocket 时用有内容的那个，空的删掉', async () => {
  const bm = mockBm();
  const empty = await bm.create({ parentId: '2', title: 'Side Pocket' }); // 新电脑上先建的空文件夹
  const real = await bm.create({ parentId: '2', title: 'Side Pocket' }); // 后来同步下来的
  await bm.create({ parentId: real.id, title: 'GitHub', url: 'https://github.com/' });
  const ids = await B.resolveRoot(bm, { create: true });
  assert.equal(ids.root, real.id);
  assert.deepEqual(bm.titles('2'), ['Side Pocket']);
  assert.notEqual(ids.root, empty.id);
});

test('书签：读成侧栏节点，置顶单独一组，颜色按路径、折叠按节点', async () => {
  const bm = mockBm();
  const ids = await B.resolveRoot(bm, { create: true });
  await bm.create({ parentId: ids.pinned, title: 'Mail', url: 'https://mail.test/' });
  const ai = await bm.create({ parentId: ids.root, title: 'AI' });
  await bm.create({ parentId: ai.id, title: 'Claude', url: 'https://claude.ai/' });
  await bm.create({ parentId: ids.root, title: 'Docs', url: 'https://docs.test/' });
  const { nodes, v } = await load(bm, ids, { colors: { AI: 'green' }, collapsed: { [B.toId(ai.id)]: true } });
  assert.deepEqual(titles(nodes, v, M.PINNED), ['Mail']);
  assert.deepEqual(titles(nodes, v, M.ROOT), ['AI', 'Docs']);
  assert.deepEqual(titles(nodes, v, B.toId(ai.id)), ['Claude']);
  assert.equal(nodes[B.toId(ai.id)].color, 'green');
  assert.equal(nodes[B.toId(ai.id)].collapsed, true);
  assert.deepEqual([...B.urlSet(nodes)].sort(), ['https://claude.ai', 'https://docs.test', 'https://mail.test']);
});

test('书签：新建、移动、置顶、重命名、删除，顺序和侧栏一致', async () => {
  const bm = mockBm();
  const ids = await B.resolveRoot(bm, { create: true });
  let { nodes, v } = await load(bm, ids);
  for (const t of ['A', 'B', 'C']) {
    await B.createLink(bm, ids, nodes, v, { title: t, url: `https://${t.toLowerCase()}.com/` }, M.ROOT);
    ({ nodes, v } = await load(bm, ids));
  }
  assert.deepEqual(titles(nodes, v, M.ROOT), ['A', 'B', 'C']);

  await B.moveSaved(bm, ids, nodes, v, idOf(nodes, 'A'), M.ROOT, 3); // 拖到最后
  ({ nodes, v } = await load(bm, ids));
  assert.deepEqual(titles(nodes, v, M.ROOT), ['B', 'C', 'A']);
  await B.moveSaved(bm, ids, nodes, v, idOf(nodes, 'A'), M.ROOT, 0); // 拖回最前（排在置顶文件夹后面也没关系）
  ({ nodes, v } = await load(bm, ids));
  assert.deepEqual(titles(nodes, v, M.ROOT), ['A', 'B', 'C']);
  await B.moveSaved(bm, ids, nodes, v, idOf(nodes, 'A'), M.ROOT, 2); // 放到 C 前面
  ({ nodes, v } = await load(bm, ids));
  assert.deepEqual(titles(nodes, v, M.ROOT), ['B', 'A', 'C']);

  const f = await B.addFolder(bm, ids, nodes, v, { title: '工作', parent: M.ROOT, index: 0 });
  ({ nodes, v } = await load(bm, ids));
  assert.deepEqual(titles(nodes, v, M.ROOT), ['工作', 'B', 'A', 'C']);
  await B.moveSaved(bm, ids, nodes, v, idOf(nodes, 'C'), f, null);
  await B.moveSaved(bm, ids, nodes, v, idOf(nodes, 'B'), M.PINNED, null);
  ({ nodes, v } = await load(bm, ids));
  assert.deepEqual(titles(nodes, v, f), ['C']);
  assert.deepEqual(titles(nodes, v, M.PINNED), ['B']);
  assert.equal(await B.moveSaved(bm, ids, nodes, v, f, M.PINNED, null), false); // 文件夹不能放进置顶
  assert.equal(await B.moveSaved(bm, ids, nodes, v, f, f, null), false); // 也不能放进自己

  assert.equal(await B.rename(bm, nodes, f, '项目'), true);
  ({ nodes, v } = await load(bm, ids));
  assert.equal(nodes[f].title, '项目');
  assert.equal(nodes[f].path, '项目');

  await B.removeSaved(bm, nodes, f); // 文件夹连同里面的一起删
  ({ nodes, v } = await load(bm, ids));
  assert.deepEqual(titles(nodes, v, M.ROOT), ['A']);
  assert.equal(idOf(nodes, 'C'), undefined);
  await assert.rejects(B.addFolder(bm, ids, nodes, v, { parent: M.PINNED }));
});

test('书签：文件夹改名、移动、删除后，颜色跟着走', () => {
  const colors = { AI: 'green', 'AI/工具': 'red', 旧: 'blue' };
  const before = { bkm1: 'AI', bkm2: 'AI/工具', bkm3: '旧' };
  const after = { bkm1: '人工智能', bkm2: '人工智能/工具' }; // AI 改名，旧 被删
  assert.deepEqual(B.carryColors(colors, before, after), { 人工智能: 'green', '人工智能/工具': 'red' });
  assert.equal(B.carryColors(colors, before, before), null);
});

test('迁移：旧的收藏和置顶写进书签，重复执行不会重复', async () => {
  const bm = mockBm();
  const ids = await B.resolveRoot(bm, { create: true });
  const s = M.emptyState();
  M.addLink(s, { id: 'pin1', title: 'Mail', url: 'https://mail.test/' }, M.PINNED);
  const ai = M.addFolder(s, { id: 'fold1', title: 'AI' });
  const sub = M.addFolder(s, { id: 'fold2', title: '工具' }, ai);
  M.addLink(s, { id: 'lnk1', title: 'Claude', url: 'https://claude.ai/' }, ai);
  M.addLink(s, { id: 'lnk2', title: 'Ollama', url: 'https://ollama.com/' }, sub);
  M.addLink(s, { id: 'lnk3', title: 'Docs', url: 'https://docs.test/' });
  s.nodes.tod1 = { id: 'tod1', type: 'link', title: 'Today', url: 'https://today.test/', parent: 'today', pos: 0 }; // 旧格式里的今日条目
  M.setColor(s, ai, 'green');
  M.setCollapsed(s, sub, true);

  const r = await B.importNodes(bm, ids, s.nodes);
  assert.equal(r.added, 6); // 2 个文件夹 + 4 个网址，今日的不算
  assert.deepEqual(r.colors, { AI: 'green' });
  assert.deepEqual(r.drop.sort(), ['fold1', 'lnk3', 'pin1']);
  const { nodes, v } = await load(bm, ids, { colors: r.colors, collapsed: r.collapsed });
  assert.deepEqual(titles(nodes, v, M.PINNED), ['Mail']);
  assert.deepEqual(titles(nodes, v, M.ROOT), ['AI', 'Docs']);
  const aiId = idOf(nodes, 'AI');
  assert.deepEqual(titles(nodes, v, aiId), ['工具', 'Claude']);
  assert.equal(nodes[aiId].color, 'green');
  assert.equal(nodes[idOf(nodes, '工具')].collapsed, true);
  assert.equal(idOf(nodes, 'Today'), undefined);

  const again = await B.importNodes(bm, ids, s.nodes); // 中途失败重试 / 另一台电脑也迁移了一次
  assert.equal(again.added, 0);
  assert.equal(Object.keys((await load(bm, ids)).nodes).length, 6);
});
