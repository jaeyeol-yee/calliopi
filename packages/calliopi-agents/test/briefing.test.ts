import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SUMMARY_ENTRY, sectionsFor, sliceSummary, summaryInput } from '#lib/briefing.ts';

const msg = (id: string, text: string) => ({ type: 'message', id, message: { role: 'user', content: text } });

test('summary input: only what came after the last delegation summary or compaction', () => {
  // nothing before: everything
  assert.deepEqual(summaryInput([msg('a', 'one'), msg('b', 'two')]), { previous: undefined, messages: [{ role: 'user', content: 'one' }, { role: 'user', content: 'two' }], upTo: 'b' });
  // a compaction: its summary is the previous one, kept and later messages are new
  const compacted = [{ type: 'compaction', id: 'c', summary: '## Goal\nOld' }, msg('k', 'kept'), msg('d', 'after')];
  assert.deepEqual(summaryInput(compacted), { previous: '## Goal\nOld', messages: [{ role: 'user', content: 'kept' }, { role: 'user', content: 'after' }], upTo: 'd' });
  // a delegation summary after that wins, and only later messages count
  const later = [...compacted, { type: 'custom', id: 's', customType: SUMMARY_ENTRY, data: { summary: '## Goal\nNewer' } }, msg('e', 'new')];
  assert.deepEqual(summaryInput(later), { previous: '## Goal\nNewer', messages: [{ role: 'user', content: 'new' }], upTo: 'e' });
  // nothing new since: the previous summary alone, no request needed
  assert.deepEqual(summaryInput(later.slice(0, -1)).messages, []);
  // other custom entries are not summaries
  assert.equal(summaryInput([{ type: 'custom', id: 'x', customType: 'other', data: {} }, msg('f', 'g')]).previous, undefined);
});

test('summary input: messages that came while a summary was made are in the next one', () => {
  const m = (id: string, text: string) => ({ type: 'message', id, message: { role: 'user', content: text } });
  const entries = [m('a', 'one'), m('b', 'during'), { type: 'custom', id: 's', customType: SUMMARY_ENTRY, data: { summary: 'S', upTo: 'a' } }, m('c', 'after')];
  assert.deepEqual(summaryInput(entries).messages, [{ role: 'user', content: 'during' }, { role: 'user', content: 'after' }]);
});

test('briefing: each role gets the sections it needs; writers also get Progress', () => {
  assert.deepEqual(sectionsFor({ tools: ['read', 'bash'], disallowedTools: [] }), ['Goal', 'Constraints & Preferences', 'Key Decisions', 'Critical Context']);
  assert.deepEqual(sectionsFor({ tools: undefined, disallowedTools: ['edit', 'write'] }), ['Goal', 'Constraints & Preferences', 'Key Decisions', 'Critical Context']);
  assert.ok(sectionsFor({ tools: undefined, disallowedTools: [] }).includes('Progress'));
  const summary = '## Goal\nShip retries\n\n## Constraints & Preferences\n- no 401 retry\n\n## Progress\n### Done\n- [x] read\n\n## Key Decisions\n- **Backoff**: exp\n\n## Next Steps\n1. code\n';
  assert.equal(sliceSummary(summary, ['Goal', 'Key Decisions']), '## Goal\nShip retries\n\n## Key Decisions\n- **Backoff**: exp');
  assert.equal(sliceSummary('free text, no headings', ['Goal']), 'free text, no headings'); // nothing to slice: all of it
});
