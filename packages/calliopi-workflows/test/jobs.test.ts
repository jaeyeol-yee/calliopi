import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { detectMultiplexer, type Exec } from '@calliopi/core/multiplexer';
import { createJob, jobMessage, jobName, listJobs, parseRunArgs, plainLog, pruneJobs, readJob, setJobPane, statusText, stopJob, tailLog, writeExit,
  KEEP_MS, LOG_FILE, PID_FILE, type Job, type JobMeta } from '#lib/jobs.ts';

const runner = fileURLToPath(new URL('../bin/job-runner.ts', import.meta.url));

function root(t: TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'calliopi-jobs-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const meta = (name: string, over: Partial<JobMeta> = {}): JobMeta => ({ name, command: 'npm test', cwd: '/repo', startedAt: Date.now(), silent: false, pane: null, ...over });

test('arguments: flags only before the command, which stays verbatim', () => {
  assert.deepEqual(parseRunArgs('npm test'), { command: 'npm test', silent: false, name: undefined });
  assert.deepEqual(parseRunArgs('  -s   npm  run   "a  b" -s '), { command: 'npm  run   "a  b" -s', silent: true, name: undefined });
  assert.deepEqual(parseRunArgs('--name=api --silent docker logs -n 5 web'), { command: 'docker logs -n 5 web', silent: true, name: 'api' });
  assert.deepEqual(parseRunArgs('-n t1 -- -s'), { command: '-s', silent: false, name: 't1' });
  assert.ok('error' in parseRunArgs('  '));
  assert.ok('error' in parseRunArgs('-s'));
  assert.ok('error' in parseRunArgs('--name=a/b ls'));
});

test('names: first two words, paths and assignments dropped, numbered when taken', () => {
  assert.equal(jobName('npm test', new Set()), 'npm-test');
  assert.equal(jobName('NODE_ENV=test ./node_modules/.bin/vitest --run', new Set()), 'vitest---run');
  assert.equal(jobName('make', new Set(['make', 'make-2'])), 'make-3');
  assert.equal(jobName('"$(…)"', new Set()), 'job');
});

test('log text: escapes removed, a redrawn line keeps its last version', () => {
  assert.equal(plainLog('\x1b[32mtick 1\x1b[0m\r\nprogress 1/8\rprogress 2/8\r\x1b[32mtick 2\x1b[0m\r\n\x1b]0;title\x07done\r\n'), 'tick 1\ntick 2\ndone\n');
  assert.equal(plainLog('10%\r50%\r100%'), '100%');
});

test('states: running while the runner lives, exited with its code, lost without one; old ones pruned', t => {
  const dir = root(t), now = Date.now();
  const a = createJob(dir, meta('a', { startedAt: now - 5000 }));
  assert.equal(readJob(a)!.state, 'running'); // the runner has not written its pid yet
  assert.throws(() => createJob(dir, meta('a'))); // a name is one job
  fs.writeFileSync(path.join(a, PID_FILE), String(process.pid));
  assert.match(statusText(readJob(a)!, now), /^실행 중 5초$/);
  setJobPane(a, { multiplexer: 'tmux', session: '/s', pane: '%4' });
  assert.equal(readJob(a)!.pane?.pane, '%4');
  writeExit(a, 3);
  const done = readJob(a)!;
  assert.deepEqual([done.state, done.exitCode], ['exited', 3]);
  assert.match(statusText(done), /^종료 3 · /);

  const dead = spawnSync(process.execPath, ['-e', '']).pid!;
  const b = createJob(dir, meta('b', { startedAt: now - 60_000 }));
  fs.writeFileSync(path.join(b, PID_FILE), String(dead));
  assert.equal(readJob(b)!.state, 'lost');
  assert.equal(stopJob(readJob(b)!), false);
  assert.deepEqual(listJobs(dir).map(j => j.name), ['a', 'b']); // newest first
  pruneJobs(dir, now + KEEP_MS + 120_000);
  assert.deepEqual(listJobs(dir).map(j => j.name), []);
});

test('message for the model: state, command and the end of the output', t => {
  const dir = root(t);
  const a = createJob(dir, meta('a'));
  assert.match(jobMessage(readJob(a)!), /is still running[\s\S]*It printed nothing so far\./);
  fs.writeFileSync(path.join(a, LOG_FILE), Array.from({ length: 100 }, (_, i) => `\x1b[31mline ${i + 1}\x1b[0m\r\n`).join(''));
  writeExit(a, 1);
  const message = jobMessage(readJob(a)!);
  assert.match(message, /job "a", in \/repo\); it exited with code 1 after/);
  assert.match(message, /<command>\nnpm test\n<\/command>/);
  assert.match(message, /<output last-lines="40">\nline 61\n[\s\S]*line 100\n<\/output>\nEarlier output is in /);
  assert.deepEqual(tailLog(a, 2), { text: 'line 99\nline 100', truncated: true });
  assert.equal(tailLog(a, 5, 40).text, 'line 99\nline 100'); // a byte limit drops the line it cut
});

// A real tmux server on a private socket: the tmux strategy and bin/job-runner.ts, end to end.
const hasTmux = spawnSync('tmux', ['-V']).status === 0;
test('tmux: a job beside Pi and one in a background window, peeked while running', { skip: !hasTmux }, async t => {
  const dir = root(t), socket = `calliopi-test-${process.pid}`;
  const tmux = (...args: string[]) => spawnSync('tmux', ['-L', socket, '-f', '/dev/null', ...args], { encoding: 'utf8' });
  t.after(() => tmux('kill-server'));
  assert.equal(tmux('new-session', '-d', '-x', '120', '-y', '30', 'sleep 60').status, 0);
  const [socketPath, self] = tmux('display-message', '-p', '#{socket_path} #{pane_id}').stdout.trim().split(' ');
  const env = { ...process.env, TMUX: `${socketPath},0,0`, TMUX_PANE: self };
  const exec: Exec = (command, args) => new Promise(resolve =>
    execFile(command, args, { env, encoding: 'utf8' }, (error, stdout, stderr) => resolve({ code: error ? 1 : 0, stdout, stderr })));
  const mux = (await detectMultiplexer({ exec, env: { TMUX: env.TMUX, TMUX_PANE: self, CALLIOPI_MULTIPLEXER: 'tmux' } }))!;
  const until = async (what: string, ok: () => boolean) => {
    for (let i = 0; i < 100 && !ok(); i++) await new Promise(r => setTimeout(r, 100));
    assert.ok(ok(), what);
  };
  const windows = () => tmux('list-windows', '-F', '#{window_active} #{window_name}').stdout.trim().split('\n');
  const panes = () => tmux('list-panes', '-a', '-F', '#{pane_id}').stdout.trim().split('\n');
  const start = async (job: JobMeta) => {
    const jobDir = createJob(dir, job);
    const command = [process.execPath, runner, jobDir];
    const { paneId } = job.silent ? await mux.openBackground!(exec, { command, cwd: job.cwd, label: `cl-run ${job.name}` })
      : await mux.openSide(exec, { command, cwd: job.cwd, label: `cl-run ${job.name}`, ratio: 40, focus: false });
    setJobPane(jobDir, { ...mux.self, pane: paneId! });
    return { jobDir, pane: paneId! };
  };
  const loop = (code: number) => `for i in 1 2 3 4 5 6; do printf '\\033[32mtick %s\\033[0m\\n' $i; printf 'progress %s/6\\r' $i; sleep 0.3; done; [ -t 1 ] && echo tty; exit ${code}`;
  const job = (jobDir: string) => readJob(jobDir) as Job;

  // beside Pi: a split of this window, focus stays
  const side = await start(meta('side', { command: loop(3), cwd: dir }));
  assert.equal(tmux('display-message', '-p', '#{pane_id}').stdout.trim(), self);
  await until('output arrives while it runs', () => /tick 2/.test(tailLog(side.jobDir).text));
  assert.equal(job(side.jobDir).state, 'running');
  assert.match(await mux.capture!(exec, side.pane), /tick 2/); // the screen can be read too
  await until('exit code', () => job(side.jobDir).state === 'exited');
  assert.equal(job(side.jobDir).exitCode, 3);
  assert.equal(tailLog(side.jobDir).text, 'tick 1\ntick 2\ntick 3\ntick 4\ntick 5\ntick 6\ntty');
  assert.match(await mux.capture!(exec, side.pane), /\[side 종료 3\] Enter로 닫기/); // stays to be read
  tmux('send-keys', '-t', side.pane, 'Enter');
  await until('Enter closes the pane', () => !panes().includes(side.pane));

  // silent: a window behind this one, gone when the command ends
  const quiet = await start(meta('quiet', { command: loop(0), cwd: dir, silent: true }));
  assert.deepEqual(windows().map(w => w.replace(/ .*/, '')), ['1', '0']); // still on the first window
  await until('output arrives', () => /tick 1/.test(tailLog(quiet.jobDir).text));
  await mux.focus!(exec, quiet.pane);
  assert.equal(tmux('display-message', '-p', '#{pane_id}').stdout.trim(), quiet.pane);
  await until('exit code', () => job(quiet.jobDir).state === 'exited');
  assert.equal(job(quiet.jobDir).exitCode, 0);
  await until('the window closes by itself', () => !panes().includes(quiet.pane));

  // stop: the command ends and the job has an exit code
  const long = await start(meta('long', { command: 'echo started; sleep 60', cwd: dir, silent: true }));
  await until('started', () => /started/.test(tailLog(long.jobDir).text));
  assert.equal(stopJob(job(long.jobDir)), true);
  await until('stopped', () => job(long.jobDir).state === 'exited');
  assert.notEqual(job(long.jobDir).exitCode, 0);

  // a pane closed by hand takes the command with it
  const closed = await start(meta('closed', { command: 'echo started; sleep 60', cwd: dir }));
  await until('started', () => /started/.test(tailLog(closed.jobDir).text));
  tmux('kill-pane', '-t', closed.pane);
  await until('ended', () => job(closed.jobDir).state !== 'running');
});
