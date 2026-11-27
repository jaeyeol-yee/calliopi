import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readNotes } from '@calliopi/core/notes';
import { NOTE_ENTRY, RECENT, installNotes } from '#lib/notes.ts';
import { signalsReport } from '#lib/signals.ts';

const tmp = (t: { after: (fn: () => void) => void }) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'calliopi-note-cmd-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

/** A Pi stand-in for a command: what it registered, wrote to the session, showed, and sent to a model. */
function fakePi(session = 'sess-1') {
  const commands = new Map<string, { description?: string; handler: (args: string, ctx: unknown) => Promise<void> }>();
  const entries: { type: string; data: unknown }[] = [];
  const notices: { text: string; level: string }[] = [];
  const sent: unknown[] = [];
  const ctx = {
    cwd: '/work/app', model: { provider: 'anthropic', id: 'claude-x' } as { provider: string; id: string } | undefined,
    sessionManager: { getSessionId: () => session, getSessionFile: () => `/sessions/${session}.jsonl` as string | undefined },
    ui: { notify: (text: string, level: string) => notices.push({ text, level }) },
  };
  const pi = {
    registerCommand: (n: string, c: never) => commands.set(n, c),
    appendEntry: (type: string, data: unknown) => entries.push({ type, data }),
    sendMessage: (m: unknown) => sent.push(m), sendUserMessage: (m: unknown) => sent.push(m),
  };
  return { pi, ctx, commands, entries, notices, sent, note: (args: string) => commands.get('cl-note')!.handler(args, ctx) };
}

test('/cl-note: writes the note with where it was written, marks the session, and sends nothing to a model', async t => {
  const file = path.join(tmp(t), 'calliopi-notes.jsonl');
  let now = 1000;
  const f = fakePi();
  installNotes(f.pi as never, { file: () => file, now: () => now });
  assert.ok(f.commands.get('cl-note')!.description);

  await f.note('  reran the full suite\n after every edit ');
  assert.deepEqual(readNotes(file), [{ at: 1000, text: 'reran the full suite after every edit', session: 'sess-1', sessionFile: '/sessions/sess-1.jsonl', cwd: '/work/app', model: 'anthropic/claude-x' }]);
  assert.deepEqual(f.entries, [{ type: NOTE_ENTRY, data: { text: 'reran the full suite after every edit', at: 1000 } }]);
  assert.deepEqual(f.notices.at(-1), { text: '메모했습니다 (이 세션 1개, 전체 1개).', level: 'info' });

  // another session writes to the same file; a session without a file or a model still notes
  const g = fakePi('sess-2');
  g.ctx.model = undefined;
  g.ctx.sessionManager.getSessionFile = () => undefined;
  installNotes(g.pi as never, { file: () => file, now: () => 2000 });
  await g.note('asked twice for the same file');
  assert.deepEqual(readNotes(file)[1], { at: 2000, text: 'asked twice for the same file', session: 'sess-2', cwd: '/work/app' });
  assert.equal(g.notices.at(-1)!.text, '메모했습니다 (이 세션 1개, 전체 2개).');

  now = 3000;
  await f.note('second');
  assert.equal(f.notices.at(-1)!.text, '메모했습니다 (이 세션 2개, 전체 3개).');
  assert.deepEqual([f.sent, g.sent], [[], []]);
});

test('/cl-note without text: the most recent notes, newest first; nothing is written', async t => {
  const file = path.join(tmp(t), 'calliopi-notes.jsonl');
  let now = 0;
  const f = fakePi();
  installNotes(f.pi as never, { file: () => file, now: () => now });

  await f.note('   ');
  assert.deepEqual(f.notices.at(-1), { text: '메모가 없습니다. 사용법: /cl-note <한 줄 메모>', level: 'info' });
  assert.equal(fs.existsSync(file), false);

  for (now = 1; now <= RECENT + 2; now++) await f.note(`note ${now}`);
  const written = f.entries.length;
  await f.note('');
  const shown = f.notices.at(-1)!.text.split('\n');
  assert.equal(shown[0], `메모 ${RECENT + 2}개 중 최근 ${RECENT}개:`);
  assert.deepEqual(shown.slice(1).map(l => l.split(' · ').at(-1)), Array.from({ length: RECENT }, (_, i) => `note ${RECENT + 2 - i}`));
  assert.equal(f.entries.length, written);
  assert.equal(readNotes(file).length, RECENT + 2);
});

test('/cl-note: a file that cannot be written is reported, and the session is not marked', async t => {
  const dir = tmp(t);
  const f = fakePi();
  installNotes(f.pi as never, { file: () => path.join(dir, 'is-a-dir') });
  fs.mkdirSync(path.join(dir, 'is-a-dir'));
  await f.note('lost');
  assert.equal(f.notices.at(-1)!.level, 'error');
  assert.match(f.notices.at(-1)!.text, /^메모를 쓰지 못했습니다: /);
  assert.deepEqual(f.entries, []);
});

test('signalsReport: the notes section follows the run counts, and is left out when no notes are passed', () => {
  const without = signalsReport([], []);
  assert.doesNotMatch(without, /## Notes/);
  const report = signalsReport([], [], [{ at: 0, text: 'looped', session: 's-1', cwd: '/work/app' }]);
  assert.ok(report.startsWith(`${without}\n\n## Notes\n`));
  assert.match(report, /1 notes from 1 sessions, newest first\.\n\n- 1970-01-01 00:00Z · app · unknown model · looped \(session s-1\)$/);
  assert.match(signalsReport([], [], []), /## Notes\n\nNo notes\./);
});
