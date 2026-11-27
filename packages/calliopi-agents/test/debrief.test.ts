import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { debriefFiles, listDebriefs, readDebrief } from '@calliopi/core/debrief';
import { TerminalPane } from '@calliopi/ui/terminal-overlay';
import { DEBRIEF_ENV, STOP_GRACE_SECONDS, SYSTEM_PROMPT, debriefConfig, debriefRoot, debriefSpawn, installDebrief, setDebriefConfig, startDebrief, type DebriefSpawn } from '#lib/debrief.ts';
import { CONFIG_FILE } from '#lib/gc.ts';
import { AGENT_DIR_ENV } from '#lib/launch.ts';
import { signalsReport } from '#lib/signals.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..');
const tmp = (t: { after: (fn: () => void) => void }) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'calliopi-debrief-run-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const SAME = 'please rename the verbose option to debug everywhere';
const user = (id: string, text: string) => ({ type: 'message', id, message: { role: 'user', content: [{ type: 'text', text }] } });
const reply = (id: string) => ({ type: 'message', id, message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }], stopReason: 'stop' } });
const SMELLY = [user('u1', SAME), reply('a1'), user('u2', SAME), reply('a2')];
const CLEAN = [user('u1', SAME), reply('a1'), user('u2', 'now add a test for the command line flag')];

function fakeCtx(entries: unknown[], over: { file?: string | undefined; model?: { provider: string; id: string } | undefined; mode?: string } = {}) {
  const notices: { text: string; level: string }[] = [];
  return {
    notices,
    ctx: {
      cwd: '/work/app', mode: over.mode ?? 'tui', model: 'model' in over ? over.model : { provider: 'p', id: 'm' },
      sessionManager: { getSessionId: () => 'sess-1', getSessionFile: () => ('file' in over ? over.file : '/sessions/sess-1.jsonl'), getEntries: () => entries },
      ui: { notify: (text: string, level: string) => notices.push({ text, level }) },
    },
  };
}
const LAUNCH = { pi: ['node', '/pi/cli.js'], extensions: ['/x/faux.ts'] };

test('debrief config: off by default, kept beside the other settings, and a bad value falls back', t => {
  const agentDir = tmp(t);
  assert.deepEqual(debriefConfig(agentDir), { enabled: false, model: undefined, timeoutMinutes: 5 });
  fs.writeFileSync(path.join(agentDir, CONFIG_FILE), JSON.stringify({ retention: { requestsDays: 9 }, debrief: { enabled: 'yes', model: 'no slash', timeoutMinutes: -1 } }));
  assert.deepEqual(debriefConfig(agentDir), { enabled: false, model: undefined, timeoutMinutes: 5 });
  setDebriefConfig(agentDir, { enabled: true, model: 'openai/gpt-x' });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(agentDir, CONFIG_FILE), 'utf8')), { retention: { requestsDays: 9 }, debrief: { enabled: true, model: 'openai/gpt-x', timeoutMinutes: -1 } });
  assert.deepEqual(debriefConfig(agentDir), { enabled: true, model: 'openai/gpt-x', timeoutMinutes: 5 });
  setDebriefConfig(agentDir, { enabled: false });
  assert.deepEqual(debriefConfig(agentDir), { enabled: false, model: 'openai/gpt-x', timeoutMinutes: 5 }); // the model is kept for next time
  fs.writeFileSync(path.join(agentDir, CONFIG_FILE), JSON.stringify({ debrief: { enabled: true, timeoutMinutes: 600 } }));
  assert.equal(debriefConfig(agentDir).timeoutMinutes, 60);
});

test('startDebrief: only when on, saved, flagged, with a model, and not reviewed at this length already', t => {
  const agentDir = tmp(t);
  const spawned: DebriefSpawn[] = [];
  const start = (entries: unknown[], over: Parameters<typeof fakeCtx>[1] = {}, now = 1000) =>
    startDebrief(fakeCtx(entries, over).ctx as never, { agentDir, spawn: s => spawned.push(s), now: () => now, launch: LAUNCH });

  assert.deepEqual(start(SMELLY), { skipped: 'off' });
  assert.equal(fs.existsSync(debriefRoot(agentDir)), false); // off: not even a directory
  setDebriefConfig(agentDir, { enabled: true });
  assert.deepEqual(start(SMELLY, { file: undefined }), { skipped: 'no-session-file' });
  assert.deepEqual(start(CLEAN), { skipped: 'no-smell' });
  assert.deepEqual(start(SMELLY, { model: undefined }), { skipped: 'no-model' });
  assert.equal(spawned.length, 0);

  const first = start(SMELLY);
  assert.ok('started' in first);
  const root = debriefRoot(agentDir);
  assert.equal(fs.statSync(root).mode & 0o777, 0o700);
  assert.deepEqual(first.started, { session: 'sess-1', sessionFile: '/sessions/sess-1.jsonl', cwd: '/work/app', model: 'p/m', startedAt: 1000, timeoutMs: 300_000, entries: 4,
    points: [{ kind: 'restate', entry: 'u2', detail: 'user message identical to the previous one' }] });
  assert.equal(readDebrief(root, 'sess-1', 1000)!.status, 'running');
  const files = debriefFiles(root, 'sess-1')!;
  const prompt = fs.readFileSync(files.prompt, 'utf8');
  assert.match(prompt, /# Flagged points\n\n## restate at entry u2\n/);
  assert.equal(fs.statSync(files.prompt).mode & 0o777, 0o600);

  // what runs: sh with a time limit and the prompt, answer and exit files, then pi without tools, a session
  // or discovered extensions. The prompt is a file for its stdin, not an argument anyone can list.
  const s = spawned[0]!;
  assert.equal(s.command, 'sh');
  assert.deepEqual(s.args.slice(2), ['sh', '300', String(STOP_GRACE_SECONDS), files.prompt, files.answer, files.exit, 'node', '/pi/cli.js', '-p', '--no-session', '--no-tools', '--no-mcp', '--no-skills', '--no-context-files', '--no-prompt-templates', '--no-extensions',
    '-e', '/x/faux.ts', '--model', 'p/m', '--system-prompt', SYSTEM_PROMPT]);
  assert.ok(!s.args.some(a => a.includes(SAME)));
  assert.equal(s.env[DEBRIEF_ENV], '1');
  assert.equal(s.cwd, root);

  // the same session again: not while the first run goes on, nor after it while the session has not grown;
  // again once it has, with the old answer cleared
  const longer0 = [...SMELLY, user('u3', 'and one more unrelated request about the tests'), reply('a3')];
  assert.deepEqual(start(longer0, {}, 2000), { skipped: 'running' });
  fs.writeFileSync(files.answer, 'old'); fs.writeFileSync(files.exit, '0\n');
  assert.deepEqual(start(SMELLY, {}, 2000), { skipped: 'already' });
  const longer = [...SMELLY, user('u3', 'and one more unrelated request about the tests'), reply('a3')];
  const second = start(longer, {}, 3000);
  assert.ok('started' in second && second.started.entries === 6);
  assert.equal(fs.existsSync(files.answer) || fs.existsSync(files.exit), false);
  assert.equal(spawned.length, 2);

  // a configured model reviews instead of the session's own
  setDebriefConfig(agentDir, { enabled: true, model: 'other/reviewer' });
  fs.writeFileSync(files.exit, '0\n');
  const third = start([...longer, user('u4', 'x'), reply('a4')], {}, 4000);
  assert.ok('started' in third && third.started.model === 'other/reviewer');

  // a run that cannot be started leaves no record behind, so the session is tried again next time
  fs.writeFileSync(files.exit, '0\n');
  const failed = startDebrief(fakeCtx([...longer, user('u4', 'x'), reply('a4'), user('u5', 'y'), reply('a5')]).ctx as never, { agentDir, spawn: () => { throw new Error('no sh'); }, now: () => 5000, launch: LAUNCH });
  assert.deepEqual(failed, { skipped: 'not-started' });
  assert.deepEqual([fs.existsSync(files.record), fs.existsSync(files.prompt)], [false, false]);
});

test('the runner: the prompt arrives on stdin and the answer and exit status are written, for this user only; a run over its time is stopped, even one that ignores TERM, and nothing is left behind', { timeout: 60_000 }, async t => {
  const root = tmp(t);
  const files = debriefFiles(root, 's')!;
  const record = (timeoutMs: number) => ({ session: 's', sessionFile: '/s', cwd: '/w', model: 'p/m', startedAt: 0, timeoutMs, entries: 1, points: [] });
  // `pi` here is a stand-in script: it reads the prompt from stdin and answers, fails, hangs, or hangs and ignores TERM
  const stand = path.join(root, 'pi.sh');
  fs.writeFileSync(stand, `#!/bin/sh
read -r first
case "$first" in
  hang) echo started; echo $$ > "${root}/pid"; sleep 300 & echo $! > "${root}/grandchild"; wait ;;
  stubborn) trap '' TERM; echo started; echo $$ > "${root}/pid"; while :; do sleep 1; done ;;
  fail) echo warn >&2; exit 3 ;;
  *) echo "got: $first"; echo warn >&2 ;;
esac
`, { mode: 0o755 });
  const spawnOf = (prompt: string, timeoutMs = 60_000) => { fs.writeFileSync(files.prompt, `${prompt}\n`); return debriefSpawn(root, record(timeoutMs), { pi: [stand], extensions: [] }, { PATH: process.env.PATH }); };
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const until = async (what: string, ok: () => boolean, ms = 20_000) => { for (const end = Date.now() + ms; Date.now() < end && !ok();) await new Promise(r => setTimeout(r, 100)); assert.ok(ok(), what); };

  // not detached here: the shell does not lead a process group, so it sweeps nothing (it would stop this test)
  const direct = (prompt: string) => { const s = spawnOf(prompt); return spawnSync(s.command, s.args, { cwd: s.cwd, env: s.env }); };
  direct('hello there');
  assert.deepEqual([fs.readFileSync(files.answer, 'utf8'), fs.readFileSync(files.exit, 'utf8'), fs.readFileSync(files.log, 'utf8')], ['got: hello there\n', '0\n', 'warn\n']);
  assert.deepEqual([files.answer, files.exit, files.log].map(f => fs.statSync(f).mode & 0o777), [0o600, 0o600, 0o600]);
  direct('fail');
  assert.equal(fs.readFileSync(files.exit, 'utf8'), '3\n');
  const gone = spawnSync('sh', [...spawnOf('x').args.slice(0, 8), path.join(root, 'no-such-pi')], { cwd: root });
  assert.equal(gone.status, 0);
  assert.equal(fs.readFileSync(files.exit, 'utf8'), '127\n'); // a pi that is not there is an error, not a hang

  // detached, as the harness starts it: over its time it is asked to stop, and what it started goes with it
  const runDetached = (prompt: string) => { fs.rmSync(files.exit, { force: true }); const s = spawnOf(prompt, 1000); const child = spawn(s.command, s.args, { cwd: s.cwd, env: s.env, detached: true, stdio: 'ignore' }); child.unref(); return child.pid!; };
  let runner = runDetached('hang');
  await until('stopped at its time limit', () => fs.existsSync(files.exit));
  assert.equal(fs.readFileSync(files.exit, 'utf8'), 'timeout\n');
  assert.equal(fs.readFileSync(files.answer, 'utf8'), 'started\n');
  const pids = () => ['pid', 'grandchild'].map(f => Number(fs.readFileSync(path.join(root, f), 'utf8')));
  await until('the stand-in, the sleep it started and the runner are gone', () => ![...pids(), runner].some(alive));

  // one that ignores TERM is killed after the grace
  runner = runDetached('stubborn');
  await until('killed', () => fs.existsSync(files.exit), (1 + STOP_GRACE_SECONDS + 10) * 1000);
  assert.equal(fs.readFileSync(files.exit, 'utf8'), 'timeout\n');
  await until('nothing left', () => !alive(pids()[0]!) && !alive(runner));
});

/** A Pi stand-in: handlers and commands by name. */
function fakePi() {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
  const sent: unknown[] = [];
  const pi = { on: (n: string, fn: never) => handlers.set(n, fn), registerCommand: (n: string, c: never) => commands.set(n, c), sendMessage: (m: unknown) => sent.push(m), sendUserMessage: (m: unknown) => sent.push(m) };
  return { pi, handlers, commands, sent };
}

test('installDebrief: starts on quit, /new and /resume of an interactive session; a reviewing Pi installs nothing', t => {
  const agentDir = tmp(t);
  setDebriefConfig(agentDir, { enabled: true });
  const spawned: DebriefSpawn[] = [];
  const f = fakePi();
  installDebrief(f.pi as never, { agentDir: () => agentDir, spawn: s => spawned.push(s), env: {} });
  const shutdown = (reason: string, entries: unknown[], mode = 'tui') => f.handlers.get('session_shutdown')!({ reason }, fakeCtx(entries, { mode }).ctx);

  shutdown('reload', SMELLY); shutdown('fork', SMELLY); // the session goes on
  shutdown('quit', SMELLY, 'print'); shutdown('quit', SMELLY, 'rpc'); // not a person's session
  shutdown('quit', CLEAN);
  assert.equal(spawned.length, 0);
  shutdown('quit', SMELLY);
  assert.equal(spawned.length, 1);
  shutdown('new', SMELLY); // its review is still going
  fs.writeFileSync(debriefFiles(debriefRoot(agentDir), 'sess-1')!.exit, '0\n');
  shutdown('new', SMELLY); // reviewed already
  assert.equal(spawned.length, 1);
  shutdown('resume', [...SMELLY, user('u3', 'something else entirely, long enough'), reply('a3')]);
  assert.equal(spawned.length, 2);
  assert.deepEqual(f.sent, []);

  const review = fakePi();
  installDebrief(review.pi as never, { agentDir: () => agentDir, env: { [DEBRIEF_ENV]: '1' } });
  assert.deepEqual([review.handlers.size, review.commands.size], [0, 0]);
});

test('/cl-debrief: on, off and status; new results are announced at startup and shown once', async t => {
  const agentDir = tmp(t);
  const f = fakePi();
  installDebrief(f.pi as never, { agentDir: () => agentDir, spawn: () => {}, env: {} });
  const c = fakeCtx([]);
  const run = async (args: string) => { await f.commands.get('cl-debrief')!.handler(args, c.ctx); return c.notices.at(-1)!; };

  assert.equal((await run('')).text, '새 debrief가 없습니다. 꺼져 있습니다: /cl-debrief on');
  assert.match((await run('on')).text, /^debrief를 켰습니다\. .*그 세션의 모델로 .*최대 5분/);
  assert.equal(debriefConfig(agentDir).enabled, true);
  assert.deepEqual(await run('on nonsense'), { text: '모델은 provider/model 꼴로 적습니다: nonsense', level: 'warning' });
  assert.match((await run('on other/reviewer')).text, /other\/reviewer로/);
  assert.equal((await run('status')).text, 'debrief: 켜짐 · 모델 other/reviewer · 0건');
  assert.equal((await run('what')).level, 'warning');

  // two finished reviews and one still running
  const root = debriefRoot(agentDir);
  fs.mkdirSync(root, { recursive: true });
  const put = (session: string, startedAt: number, answer?: string) => {
    const files = debriefFiles(root, session)!;
    fs.writeFileSync(files.record, JSON.stringify({ session, sessionFile: '/s', cwd: '/w', model: 'p/m', startedAt, timeoutMs: 60_000, entries: 4, points: [{ kind: 'restate', detail: 'd' }] }));
    if (answer !== undefined) { fs.writeFileSync(files.answer, answer); fs.writeFileSync(files.exit, '0\n'); }
  };
  put('old', Date.now() - 2000, '### restate at entry u2\n- Verdict: not a problem\nSummary: 0 problems of 1 flagged');
  put('new', Date.now() - 1000, '### restate at entry u9\n- Verdict: problem\nSummary: 1 problems of 1 flagged');
  put('going', Date.now());
  assert.equal((await run('status')).text, 'debrief: 켜짐 · 모델 other/reviewer · 3건 (진행 중 1, 완료 2)');

  f.handlers.get('session_start')!({ reason: 'reload' }, c.ctx);
  assert.equal(c.notices.at(-1)!.text.startsWith('지난 세션'), false); // only when Pi starts
  f.handlers.get('session_start')!({ reason: 'startup' }, c.ctx);
  assert.equal(c.notices.at(-1)!.text, '지난 세션 debrief 2건 · 최근: Summary: 1 problems of 1 flagged · /cl-debrief');

  const shown = (await run('')).text;
  assert.match(shown, /^debrief · 세션 new · p\/m · .* · 남은 1건\n\n### restate at entry u9\n- Verdict: problem/);
  assert.ok(readDebrief(root, 'new')!.record.readAt);
  assert.match((await run('')).text, /^debrief · 세션 old · /);
  assert.equal((await run('')).text, '새 debrief가 없습니다.');
  assert.match((await run('off')).text, /^debrief를 껐습니다/);
  assert.equal(debriefConfig(agentDir).enabled, false);
  assert.deepEqual(f.sent, []);

  const report = signalsReport([], [], [], [], listDebriefs(root));
  assert.ok(report.indexOf('## Session smells') < report.indexOf('## Debriefs') && report.indexOf('## Debriefs') < report.indexOf('## Notes'));
  assert.match(report, /3 debriefs: done 2, running 1\./);
  assert.doesNotMatch(signalsReport([], [], [], []), /## Debriefs/);
});

// Real Pis in a pseudo-terminal, with the demo's faux model: messages are typed, then Pi is quit. The
// review is a second real Pi that the first starts and does not wait for.
test('real sessions: one that ends with a smell is reviewed after Pi has quit, and the review starts none of its own; off, or without a smell, nothing starts', { timeout: 240_000 }, async t => {
  const until = async (what: string, ok: () => boolean, ms = 60_000) => {
    for (const end = Date.now() + ms; Date.now() < end && !ok();) await new Promise(r => setTimeout(r, 200));
    assert.ok(ok(), what);
  };
  /** One interactive session in its own agent directory: types the messages, waits for each answer, quits. */
  const session = async (messages: string[], enabled: boolean) => {
    const agentHome = tmp(t), project = tmp(t);
    const scenario = path.join(agentHome, 'scenario.yaml');
    fs.writeFileSync(scenario, JSON.stringify({
      title: 'debrief', turns: messages.map((_, i) => ({ prompt: 'x', reply: [{ text: `Answer ${i + 1}.` }] })),
      completions: [{ match: 'reviewing parts of a finished coding-agent session', text: '### restate at entry x\n- Verdict: not a problem\nSummary: 0 problems of 1 flagged' }],
    }));
    if (enabled) setDebriefConfig(agentHome, { enabled: true });
    const env: NodeJS.ProcessEnv = { ...process.env, PI_CODING_AGENT_DIR: agentHome, DEMO_SCENARIO: scenario };
    delete env[AGENT_DIR_ENV]; delete env[DEBRIEF_ENV];
    const top = new TerminalPane({ getCwd: () => project, requestRender: () => {} });
    t.after(() => top.dispose());
    top.resize(150, 45);
    const exited = top.run(process.execPath, [process.env.CALLIOPI_TEST_PI || path.join(repo, 'node_modules/@earendil-works/pi-coding-agent/dist/cli.js'),
      '-e', path.join(repo, 'demo/faux-extension.ts'), '-e', path.join(repo, 'packages/calliopi-agents/extensions/agents.ts'), '--model', 'faux/demo'], env);
    const screen = () => { const b = top.terminal.buffer.active; return Array.from({ length: b.length }, (_, i) => b.getLine(i)?.translateToString(true) ?? '').join('\n'); };
    await until('pi up', () => /faux/.test(screen()));
    for (const [i, text] of messages.entries()) {
      top.write(text); await new Promise(r => setTimeout(r, 100)); top.write('\r');
      await until(`answer ${i + 1}`, () => screen().includes(`Answer ${i + 1}.`));
    }
    const root = debriefRoot(agentHome);
    assert.equal(fs.existsSync(root), false); // nothing while the session is open
    top.write('\x04'); // ctrl+d: quit
    await exited;
    return { agentHome, root, quitAt: Date.now() };
  };

  // on, and the same message twice
  const { agentHome, root, quitAt } = await session([SAME, SAME], true);
  await until('a review was recorded', () => listDebriefs(root).length === 1);
  await until('the review finished', () => listDebriefs(root)[0]!.status !== 'running');
  const d = listDebriefs(root)[0]!;
  assert.equal(d.status, 'done', fs.readFileSync(debriefFiles(root, d.record.session)!.log, 'utf8'));
  assert.equal(d.text, '### restate at entry x\n- Verdict: not a problem\nSummary: 0 problems of 1 flagged');
  assert.deepEqual(d.record.points.map(p => [p.kind, p.detail]), [['restate', 'user message identical to the previous one']]);
  assert.equal(d.record.model, 'faux/demo');
  assert.ok(fs.statSync(debriefFiles(root, d.record.session)!.exit).mtimeMs >= quitAt - 1000, 'it ended after Pi had quit');

  // the reviewing Pi left no session, no review of its own, and no record of an agent
  await new Promise(r => setTimeout(r, 1500));
  assert.deepEqual(fs.readdirSync(root).filter(n => n.endsWith('.json')), [`${d.record.session}.json`]);
  const sessions = fs.readdirSync(path.join(agentHome, 'sessions')).flatMap(p => fs.readdirSync(path.join(agentHome, 'sessions', p)));
  assert.equal(sessions.length, 1);
  assert.equal(fs.existsSync(path.join(agentHome, 'calliopi-agents')), false);

  // off with the same smell, and on without one: no review, not even its directory
  const off = await session([SAME, SAME], false);
  const clean = await session([SAME, 'now add a test for the command line flag'], true);
  await new Promise(r => setTimeout(r, 3000));
  assert.deepEqual([fs.existsSync(off.root), fs.existsSync(clean.root)], [false, false]);
});
