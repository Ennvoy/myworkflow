// ui-compare-capture.test.mjs — 視覺比對截圖腳本的純 helper 測試（node --test）。
// 不起瀏覽器：只測 CLI 主流程之外可安全 import 的純函式（parseViewports 格式驗證、safeJoin path traversal 防護）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { parseViewports, safeJoin, contentTypeFor } from './ui-compare-capture.mjs';

test('parseViewports：合法格式逐一解析；非法格式丟例外', () => {
  assert.deepEqual(parseViewports('1440x900,390x844'), [{ width: 1440, height: 900 }, { width: 390, height: 844 }]);
  assert.deepEqual(parseViewports(' 1024x768 '), [{ width: 1024, height: 768 }], '前後空白容忍');
  assert.throws(() => parseViewports(''), /不得為空/);
  assert.throws(() => parseViewports('1440x900,abc'), /不合法的 viewport 格式/);
  assert.throws(() => parseViewports('1440'), /不合法的 viewport 格式/);
  assert.throws(() => parseViewports('1440x900x100'), /不合法的 viewport 格式/);
});

test('safeJoin：正常相對路徑放行；.. traversal 一律擋（回 null）', () => {
  const base = path.join(path.sep === '\\' ? 'C:\\tmp' : '/tmp', 'ui-mockups');
  const ok = safeJoin(base, 'pages/login.html');
  assert.equal(ok, path.join(base, 'pages', 'login.html'));
  assert.equal(safeJoin(base, '../../etc/passwd'), null, '上層目錄跳脫擋');
  assert.equal(safeJoin(base, '..%2f..%2fetc'), path.join(base, '..%2f..%2fetc'), '未 decode 的字面字串本身不含 .. 片段，交由呼叫端先 decodeURIComponent 再傳入');
  assert.equal(safeJoin(base, ''), base, '空字串＝base 本身');
});

test('contentTypeFor：常見副檔名對應正確 MIME；未知副檔名回預設值', () => {
  assert.equal(contentTypeFor('.html'), 'text/html; charset=utf-8');
  assert.equal(contentTypeFor('.CSS'), 'text/css; charset=utf-8', '大小寫不敏感');
  assert.equal(contentTypeFor('.png'), 'image/png');
  assert.equal(contentTypeFor('.xyz'), 'application/octet-stream');
});
