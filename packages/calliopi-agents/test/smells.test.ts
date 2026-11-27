import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectSessions, signalsReport } from '#lib/signals.ts';

const tmp = (t: { after: (fn: () => void) => void }) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'calliopi-smells-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};
/** A session file as Pi names it (<time>_<id>.jsonl) under a project directory; returns its path. */
function writeSession(sessions: string, project: string, sid: string, at: string, lines: unknown[]) {
  fs.mkdirSync(path.join(sessions, project), { recursive: true });
  const file = path.join(sessions, project, `${at.replace(/[:.]/g, '-')}_${sid}.jsonl`);
  fs.writeFileSync(file, [{ type: 'session', id: sid, cwd: `/${project}`, timestamp: at }, ...lines].map(l => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n'));
  return file;
}
const aborted = { type: 'message', id: 'a1', message: { role: 'assistant', provider: 'p', model: 'm', stopReason: 'aborted', content: [] } };
const user = { type: 'message', id: 'u1', message: { role: 'user', content: 'go' } };

test('collectSessions: every project, oldest first; filtered by start time or by session id; unreadable files are skipped', t => {
  const sessions = path.join(tmp(t), 'sessions');
  assert.deepEqual(collectSessions(sessions), []); // no directory
  writeSession(sessions, 'app', 'new', '2026-11-20T00:00:00.000Z', [user, aborted, '{"type":"mess']); // a torn last line
  writeSession(sessions, 'lib', 'old', '2026-11-10T00:00:00.000Z', [user]);
  fs.writeFileSync(path.join(sessions, 'app', 'no-header.jsonl'), JSON.stringify(user));
  fs.writeFileSync(path.join(sessions, 'app', 'notes.txt'), 'not a session');
  fs.writeFileSync(path.join(sessions, 'stray.jsonl'), '{}'); // not inside a project directory

  const all = collectSessions(sessions);
  assert.deepEqual(all.map(s => [s.info.id, s.info.cwd, s.info.model, s.smells.map(x => x.kind)]), [['old', '/lib', 'unknown', []], ['new', '/app', 'p/m', ['interrupted']]]);
  assert.deepEqual(collectSessions(sessions, { sinceMs: Date.parse('2026-11-15T00:00:00Z') }).map(s => s.info.id), ['new']);
  assert.deepEqual(collectSessions(sessions, { session: 'old' }).map(s => s.info.id), ['old']);
  assert.deepEqual(collectSessions(sessions, { session: 'ld' }), []); // the whole id, not its tail
});

test('signalsReport: smells come after the run counts and before the notes; each is left out when not passed', t => {
  const sessions = path.join(tmp(t), 'sessions');
  writeSession(sessions, 'app', 's-1', '2026-11-20T00:00:00.000Z', [user, aborted]);
  const base = signalsReport([], []);
  assert.doesNotMatch(base, /## Session smells/);
  const report = signalsReport([], [], [], collectSessions(sessions));
  assert.ok(report.startsWith(`${base}\n\n## Session smells\n\n1 top-level session. `));
  assert.ok(report.includes('| interrupted | 1 | 100% | 1 |  |'));
  assert.ok(report.includes('- interrupted · 2026-11-20 · session s-1 · entry a1 · the user aborted the reply'));
  assert.ok(report.indexOf('## Session smells') < report.indexOf('## Notes'));
  assert.doesNotMatch(signalsReport([], [], undefined, []), /## Notes/);
});
