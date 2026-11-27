import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AROUND, DEBRIEF_INSTRUCTIONS, LOST_GRACE_MS, MAX_POINTS, TEXT_CHARS, debriefFiles, debriefPrompt, debriefSummary, excerpt, formatDebriefs, listDebriefs, readDebrief, type DebriefRecord } from '#lib/debrief.ts';
import type { SessionEntry, Smell } from '#lib/smells.ts';

const tmp = (t: { after: (fn: () => void) => void }) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'calliopi-debrief-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const msg = (id: string, message: SessionEntry['message']): SessionEntry => ({ type: 'message', id, message });
const smell = (kind: Smell['kind'], entry?: string): Smell => ({ kind, entry, detail: `${kind} detail` });

test('excerpt: a few entries around each flagged one, cut short, the flagged one marked', () => {
  const entries: SessionEntry[] = [
    { type: 'session', id: 's' },
    ...Array.from({ length: 10 }, (_, i) => msg(`u${i}`, { role: 'user', content: [{ type: 'text', text: `message ${i}` }] })),
    msg('a1', { role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(TEXT_CHARS + 50) }, { type: 'toolCall', name: 'bash', arguments: { command: 'ls' } }], stopReason: 'aborted' }),
    { type: 'custom', id: 'c1', customType: 'calliopi-note', data: { text: 'not shown' } },
    msg('r1', { role: 'toolResult', toolName: 'bash', isError: true, content: [{ type: 'text', text: 'line one\n\nline two' }] }),
    msg('b1', { role: 'bashExecution', command: 'git status' }),
  ];
  const { text, points } = excerpt(entries, [smell('interrupted', 'a1'), smell('repeat'), smell('restate', 'gone')]);
  assert.deepEqual(points.map(p => p.kind), ['interrupted']); // no entry, or an entry that is not there: left out
  const lines = text.split('\n');
  assert.deepEqual(lines.slice(0, 3), ['## interrupted at entry a1', 'Detector: interrupted detail', '']);
  assert.deepEqual(lines.slice(3).map(l => l.slice(0, 3)), ['   ', '   ', '   ', '>> ', '>> ', '>> ', '   ', '   ']);
  assert.deepEqual(lines.slice(3, 6), Array.from({ length: AROUND }, (_, i) => `   [u${10 - AROUND + i}] user: message ${10 - AROUND + i}`));
  assert.equal(lines[6], `>> [a1] assistant: ${'x'.repeat(TEXT_CHARS)}… (+50 chars)`);
  assert.equal(lines[7], '>> [a1] assistant calls bash: {"command":"ls"}');
  assert.equal(lines[8], '>> [a1] (the reply ended: aborted)');
  assert.equal(lines[9], '   [r1] result of bash (error): line one line two');
  assert.equal(lines[10], '   [b1] user ran: git status');
  assert.doesNotMatch(text, /not shown/);

  const many = excerpt(entries, Array.from({ length: MAX_POINTS + 3 }, (_, i) => smell('restate', `u${i % 10}`)));
  assert.equal(many.points.length, MAX_POINTS);
  assert.deepEqual(excerpt([], [smell('restate', 'u1')]), { text: '', points: [] });
});

test('debriefPrompt: the instructions, then the points; the instructions ask for a verdict and a summary line', () => {
  const prompt = debriefPrompt('## restate at entry u1');
  assert.ok(prompt.startsWith(DEBRIEF_INSTRUCTIONS));
  assert.ok(prompt.endsWith('# Flagged points\n\n## restate at entry u1\n'));
  for (const part of ['Verdict: problem | not a problem | cannot tell', 'Likely cause: harness', 'Summary: <n> problems of <m> flagged', 'A flag is not proof']) assert.ok(DEBRIEF_INSTRUCTIONS.includes(part), part);
});

const record = (over: Partial<DebriefRecord> = {}): DebriefRecord => ({
  session: 's-1', sessionFile: '/s/1.jsonl', cwd: '/work', model: 'p/m', startedAt: 1000, timeoutMs: 60_000, entries: 12, points: [{ kind: 'restate', entry: 'u1', detail: 'd' }], ...over,
});
function write(root: string, r: DebriefRecord, files: { answer?: string; exit?: string } = {}) {
  const f = debriefFiles(root, r.session)!;
  fs.writeFileSync(f.record, JSON.stringify(r));
  if (files.answer !== undefined) fs.writeFileSync(f.answer, files.answer);
  if (files.exit !== undefined) fs.writeFileSync(f.exit, `${files.exit}\n`);
}

test('readDebrief: the status comes from the exit file, the answer and the time', t => {
  const root = tmp(t);
  assert.equal(debriefFiles(root, '../x'), undefined);
  assert.equal(readDebrief(root, '../x'), undefined);
  assert.equal(readDebrief(root, 's-1'), undefined); // nothing there
  write(root, record());
  assert.equal(readDebrief(root, 's-1', 1000 + 60_000)!.status, 'running');
  assert.equal(readDebrief(root, 's-1', 1000 + 60_000 + LOST_GRACE_MS + 1)!.status, 'lost'); // never wrote an exit status
  write(root, record(), { answer: ' ### restate\nSummary: 1 problems of 1 flagged\n', exit: '0' });
  const done = readDebrief(root, 's-1')!;
  assert.deepEqual([done.status, done.text, done.record.model], ['done', '### restate\nSummary: 1 problems of 1 flagged', 'p/m']);
  for (const [answer, exit, status] of [['', '0', 'error'], ['partial', '143', 'timeout'], ['partial', '137', 'timeout'], ['', '1', 'error'], ['text', '2', 'error']] as const) {
    write(root, record(), { answer, exit });
    assert.equal(readDebrief(root, 's-1')!.status, status, `${exit} with ${answer ? 'an' : 'no'} answer`);
  }
  // a record that is not one, or belongs to another session, is not read
  fs.writeFileSync(debriefFiles(root, 's-2')!.record, JSON.stringify(record()));
  fs.writeFileSync(debriefFiles(root, 's-3')!.record, 'null');
  fs.writeFileSync(debriefFiles(root, 's-4')!.record, '{"session":"s-4"}');
  assert.deepEqual(['s-2', 's-3', 's-4'].map(s => readDebrief(root, s)), [undefined, undefined, undefined]);
  assert.deepEqual(listDebriefs(root).map(d => d.record.session), ['s-1']);
  assert.deepEqual(listDebriefs(path.join(root, 'none')), []);
});

test('formatDebriefs: counts by status, and the finished ones newest first with their closing line', t => {
  assert.match(formatDebriefs([]), /^## Debriefs\n\nNo debriefs\. Turn them on with \/cl-debrief on/);
  const root = tmp(t);
  write(root, record({ session: 'a', startedAt: Date.UTC(2026, 10, 1) }), { answer: 'x\nSummary: 0 problems of 1 flagged', exit: '0' });
  write(root, record({ session: 'b', startedAt: Date.UTC(2026, 10, 2) }), { answer: 'no closing line', exit: '0' });
  write(root, record({ session: 'c', startedAt: Date.UTC(2026, 10, 3) }), { answer: '', exit: '1' });
  const text = formatDebriefs(listDebriefs(root, Date.UTC(2026, 10, 3)));
  assert.deepEqual(text.split('\n').slice(2), [
    "3 debriefs: done 2, error 1. A debrief is a model's reading of short excerpts, not a measurement.", '',
    '- 2026-11-02 · session b · p/m · 1 flagged · no summary line',
    '- 2026-11-01 · session a · p/m · 1 flagged · Summary: 0 problems of 1 flagged',
  ]);
  assert.ok(formatDebriefs(listDebriefs(root, Date.UTC(2026, 10, 3)), 1).endsWith('- … and 1 older'));
  assert.equal(debriefSummary('a\n Summary: no\nSummary: 2 problems of 3 flagged \nb'), 'Summary: 2 problems of 3 flagged');
  assert.equal(debriefSummary('nothing'), undefined);
});
