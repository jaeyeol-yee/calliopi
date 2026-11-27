import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { HARNESS_ENTRY } from '@calliopi/core/smells';
import { installHarnessStamp, readHarnessVersion } from '#lib/harness.ts';
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
  writeSession(sessions, 'app', 'new', '2026-11-20T00:00:00.000Z', ['null', '7', user, aborted, '{"type":"mess']); // lines that are not entries, and a torn last line
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
  assert.ok(report.includes('| aborted | 1 | 0 | 0 | 1 | 0 | 0 | 0 |')); // by outcome: it ended on the abort
  assert.ok(report.includes('| unrecorded | 1 | 0 | 0 | 1 | 0 | 0 | 0 |')); // by harness version: none was recorded
  assert.ok(report.includes('- interrupted · 2026-11-20 · session s-1 · entry a1 · the user aborted the reply'));
  assert.ok(report.indexOf('## Session smells') < report.indexOf('## Notes'));
  assert.doesNotMatch(signalsReport([], [], undefined, []), /## Notes/);
});

/** A Pi stand-in for the version stamp: the agent_start handler, the session's entries, and what was appended. */
function fakePi(entries: unknown[] = []) {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<void>>();
  const appended: { type: string; data: unknown }[] = [];
  const sent: unknown[] = [];
  const pi = {
    on: (name: string, fn: never) => handlers.set(name, fn),
    appendEntry: (type: string, data: unknown) => { appended.push({ type, data }); entries.push({ type: 'custom', customType: type, data }); },
    sendMessage: (m: unknown) => sent.push(m), sendUserMessage: (m: unknown) => sent.push(m),
  };
  const ctx = { sessionManager: { getEntries: () => entries } };
  return { pi, appended, sent, entries, start: () => handlers.get('agent_start')!({}, ctx) };
}

test('harness stamp: written before a run when the session has no version or another one; read once per load', async () => {
  let reads = 0;
  let current: { sha: string; dirty: boolean } | undefined = { sha: 'aaa', dirty: false };
  const f = fakePi([{ type: 'message' }, null]);
  installHarnessStamp(f.pi as never, async () => { reads++; return current; });
  await f.start();
  await f.start();
  await f.start();
  assert.deepEqual(f.appended, [{ type: HARNESS_ENTRY, data: { sha: 'aaa', dirty: false } }]); // once, not per run
  assert.equal(reads, 1);
  assert.deepEqual(f.sent, []);

  // the same session opened by a reloaded harness at another commit, or the same commit now dirty, is stamped again
  for (const [next, expected] of [[{ sha: 'bbb', dirty: false }, 2], [{ sha: 'bbb', dirty: true }, 3], [{ sha: 'bbb', dirty: true }, 3]] as const) {
    const g = fakePi(f.entries);
    installHarnessStamp(g.pi as never, async () => next);
    await g.start();
    assert.equal(f.entries.filter(e => (e as { customType?: string } | null)?.customType === HARNESS_ENTRY).length, expected);
  }

  // not a git checkout, or git failed: nothing is written, and the run goes on
  current = undefined;
  const h = fakePi();
  installHarnessStamp(h.pi as never, async () => current);
  await h.start();
  const broken = fakePi();
  installHarnessStamp(broken.pi as never, async () => { throw new Error('git is gone'); });
  await broken.start();
  assert.deepEqual([h.appended, broken.appended], [[], []]);
});

test('readHarnessVersion: the commit of a checkout and whether tracked files changed; undefined outside a checkout', async t => {
  const dir = tmp(t);
  assert.equal(await readHarnessVersion(dir), undefined);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } }).toString().trim();
  git('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one');
  git('add', 'a.txt');
  git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'one');
  const sha = git('rev-parse', '--short=12', 'HEAD');
  fs.mkdirSync(path.join(dir, 'sub'));
  assert.deepEqual(await readHarnessVersion(path.join(dir, 'sub')), { sha, dirty: false }); // from any directory inside it
  fs.writeFileSync(path.join(dir, 'untracked.txt'), 'x');
  assert.deepEqual(await readHarnessVersion(dir), { sha, dirty: false }); // untracked files do not make it dirty
  fs.writeFileSync(path.join(dir, 'a.txt'), 'two');
  assert.deepEqual(await readHarnessVersion(path.join(dir, 'sub')), { sha, dirty: true });
});
