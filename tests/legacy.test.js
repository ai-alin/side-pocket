import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as L from '../legacy.js';

test('旧数据：只取置顶 / 收藏，今日和已删除的不要；找出所有旧格式的键', () => {
  const all = {
    'n:pin00001': { k: 'l', ti: 'Mail', p: 'pinned', o: 0, t: 1, u: 'https://mail.test/' },
    'n:fold0001': { k: 'f', ti: 'AI', p: 'root', o: 0, t: 1, c: 1, co: 'green' },
    'n:link0001': { k: 'l', ti: 'Claude', p: 'fold0001', o: 0, t: 1, u: 'https://claude.ai/' },
    'n:tody0001': { k: 'l', ti: 'Today', p: 'today', o: 0, t: 1, u: 'https://today.test/' },
    'n:gone0001': { k: 'l', ti: 'Gone', p: 'root', o: 1, t: 1, u: 'https://gone.test/' },
    'd:devA': { gone0001: [5, 0] },
    meta: { n: 1 },
    c0: '...',
    'dv:newdev1': { nm: '新版本的设备', at: 1, n: 0 },
    'ui.folderColors': {},
  };
  const local = { nodes: { locl0001: { id: 'locl0001', type: 'link', title: 'Local', url: 'https://local.test/', parent: 'root', pos: 9 } } };
  const nodes = L.savedNodes(all, local);
  assert.deepEqual(Object.keys(nodes).sort(), ['fold0001', 'link0001', 'locl0001', 'pin00001']);
  assert.equal(nodes.fold0001.color, 'green');
  assert.deepEqual(L.legacySyncKeys(all).sort(), ['c0', 'd:devA', 'meta', 'n:fold0001', 'n:gone0001', 'n:link0001', 'n:pin00001', 'n:tody0001']);
  assert.deepEqual(L.savedKeys(all).sort(), ['n:fold0001', 'n:gone0001', 'n:link0001', 'n:pin00001']);
});
