import test from 'node:test';
import assert from 'node:assert/strict';
import { visibleWidth } from '@earendil-works/pi-tui';
import { metadataTable } from '#lib/table.ts';
import type { TableTheme } from '#lib/table.ts';

const theme: TableTheme = { fg: (_token, s) => s };
const strip = (s: string) => s.replace(/\x1b\]8;[^\x07\x1b]*(\x07|\x1b\\)/g, '');

test('bordered table fits the width exactly, Korean and wrapping included', () => {
  const lines = metadataTable([['상태', '완료'], ['요약', '아주 긴 설명 '.repeat(8)]], 40, theme);
  assert.match(lines[0], /^┌─+┬─+┐$/);
  assert.match(lines.at(-1)!, /^└─+┴─+┘$/);
  assert.ok(lines.some((l) => /^├─+┼─+┤$/.test(l)), 'row separator');
  assert.ok(lines.length > 5, 'long value wraps');
  for (const l of lines) assert.equal(visibleWidth(l), 40, l);
});

test('only allow-listed https links become hyperlinks; control characters are removed', () => {
  const lines = metadataTable([
    ['pr', { text: 'PR #1', url: 'https://github.com/o/r/pull/1' }],
    ['bad', { text: 'evil', url: 'javascript:alert(1)' }],
    ['host', { text: 'other', url: 'https://example.com/x' }],
    ['ctl', 'a\x1b[31mred\x07b'],
  ], 50, theme);
  const all = lines.join('\n');
  assert.equal((all.match(/\x1b\]8;;https:\/\/github\.com\/o\/r\/pull\/1/g) || []).length, 1);
  assert.ok(!all.includes('javascript:') && !all.includes('example.com'));
  assert.ok(!/\x1b\[31m|\x07b/.test(all), 'no raw escape from values');
  assert.ok(lines.map(strip).some((l) => l.includes('a [31mred b')));
});

test('narrow widths fall back to key: value lines', () => {
  const lines = metadataTable([['k', 'v'], ['empty', []]], 20, theme);
  assert.deepEqual(lines, ['k: v', 'empty: —']);
});
