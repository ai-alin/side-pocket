import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tr, setLang, getLang, _dict } from '../i18n.js';
import * as D from '../devices.js';

test('文案：中文和英文的键完全一样，带参数的两边都是函数', () => {
  const shape = (d) => Object.fromEntries(Object.entries(d).map(([k, v]) => [k, typeof v === 'function' ? `fn${v.length}` : typeof v === 'object' ? Object.keys(v).sort().join() : 'str']));
  assert.deepEqual(shape(_dict.en), shape(_dict.zh));
  for (const d of Object.values(_dict)) for (const [k, v] of Object.entries(d)) if (typeof v === 'string') assert.ok(v.trim(), k);
});

test('文案：按语言取，英文里没有夹着中文', () => {
  try {
    assert.equal(setLang('en'), 'en');
    assert.equal(tr('secPinned'), 'Pinned');
    assert.equal(tr('deleteFolder', 1), 'Delete folder (1 item)');
    assert.equal(tr('deleteFolder', 3), 'Delete folder (3 items)');
    assert.equal(tr('deleteFolder', 0), 'Delete folder');
    assert.equal(tr('folderCount', 4, 2), '4 sites, 2 open');
    assert.equal(tr('deleted', true, 'Work', 2), 'Deleted folder “Work” (2 items)');
    assert.equal(tr('colors').blue, 'Blue');
    const sample = (v) => (typeof v === 'function' ? v(2, 'x', 3) : typeof v === 'object' ? Object.values(v).join() : v);
    for (const [k, v] of Object.entries(_dict.en)) assert.ok(!/[\u4e00-\u9fff]/.test(String(sample(v))), k);
    const now = new Date(2026, 10, 4, 15, 0).getTime();
    assert.equal(D.relTime(now - 20e3, now), 'Just now');
    assert.equal(D.relTime(now - 5 * 60e3, now), '5 min ago');
    assert.equal(D.relTime(now - 3 * 3600e3, now), '3 hr ago');
    assert.equal(D.relTime(new Date(2026, 10, 3, 22, 10).getTime(), now), 'Yesterday 22:10');
    assert.equal(D.relTime(new Date(2026, 9, 31, 9, 0).getTime(), now), 'Oct 31');
    assert.equal(D.defaultName('weird', 'abcd1234'), 'Computer · 1234');
  } finally {
    setLang('zh');
  }
  assert.equal(getLang(), 'zh');
  assert.equal(tr('secPinned'), '置顶');
  assert.equal(tr('没有这个键'), '没有这个键');
  assert.equal(setLang('fr'), 'zh'); // 不认识的值 = 跟随浏览器；node 里没有浏览器，默认中文
});
