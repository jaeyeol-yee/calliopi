import test from 'node:test';
import assert from 'node:assert/strict';
import { visibleWidth } from '@earendil-works/pi-tui';
import { panelLines, parseArgs } from '#lib/usage-panel.ts';

test('panel frame and /cl-usage arguments', () => {
  const panel = panelLines(['a', '한글'], 20, 'r 새로고침');
  assert.equal(panel.length, 4);
  for (const line of panel) assert.equal(visibleWidth(line), 20, line);
  assert.match(panel[0]!, /^╭─ 사용량 ─+╮$/);
  assert.deepEqual(parseArgs('cursor claude'), { ids: ['claude', 'cursor'], unknown: [] });
  assert.deepEqual(parseArgs('gemini'), { ids: [], unknown: ['gemini'] });
});
