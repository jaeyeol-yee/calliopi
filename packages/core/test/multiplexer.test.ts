import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { ancestorMultiplexers, detectMultiplexer, multiplexerOf, openSidePane, NoMultiplexerError, type Exec } from '#lib/multiplexer/index.ts';
import { quote, writeLauncher } from '#lib/multiplexer/herdr.ts';
import { holdOpen } from '#lib/multiplexer/tmux.ts';

type Call = [string, string[]];
/** Fake exec: `ps` answers with `ps`, others by the first matching prefix of "command arg0 arg1". */
function fake(ps: string | null, answers: Record<string, string> = {}) {
  const calls: Call[] = [];
  const exec: Exec = async (command, args) => {
    if (command === 'ps') return ps === null ? { code: 1, stdout: '', stderr: 'no ps' } : { code: 0, stdout: ps, stderr: '' };
    calls.push([command, args]);
    const key = Object.keys(answers).find((k) => [command, ...args].join(' ').startsWith(k));
    return { code: 0, stdout: key ? answers[key]! : '', stderr: '' };
  };
  return { exec, calls };
}

const REX = { REX_SESSION: 'sess', REX_BLOCK: 'blk' };
const TMUX = { TMUX: '/tmp/tmux-501/default,123,0', TMUX_PANE: '%3' };
const HERDR = { HERDR_PANE_ID: 'w1:p1', HERDR_SOCKET_PATH: '/h/herdr.sock' };
// pi (100) ← zsh (90) ← herdr (80) ← herdr client (70) ← tmux server (60); Rex is further out but tmux daemonizes.
const NESTED = ['100 90 node', '90 80 -zsh', '80 70 herdr', '70 60 herdr', '60 1 tmux: server', '1 0 launchd'].join('\n');

test('process names: Rex server binary, tmux retitled, others not', () => {
  assert.equal(multiplexerOf('/Users/me/Library/Application Support/com.superlogical.rex/RexServer/Versions/Current/Rex Server.app/Contents/MacOS/rex'), 'rex');
  assert.equal(multiplexerOf('tmux: server'), 'tmux');
  assert.equal(multiplexerOf('/opt/homebrew/bin/herdr'), 'herdr');
  assert.equal(multiplexerOf('-zsh'), null);
  assert.equal(multiplexerOf('rexx'), null);
  assert.deepEqual(ancestorMultiplexers(NESTED, 100), ['herdr', 'tmux']);
  assert.deepEqual(ancestorMultiplexers('5 6 tmux\n6 5 herdr', 5), ['herdr', 'tmux']); // a cycle ends; the process itself is not its own multiplexer
});

test('the nearest multiplexer wins, even with outer ones in the environment', async () => {
  const env = { ...REX, ...TMUX, ...HERDR };
  assert.equal((await detectMultiplexer({ exec: fake(NESTED).exec, env, pid: 100 }))?.id, 'herdr');
  const inTmux = ['100 60 node', '60 1 tmux'].join('\n');
  assert.deepEqual((await detectMultiplexer({ exec: fake(inTmux).exec, env, pid: 100 }))?.self, { multiplexer: 'tmux', session: '/tmp/tmux-501/default', pane: '%3' });
  // the nearest one lost its variables: the next one out
  assert.equal((await detectMultiplexer({ exec: fake(NESTED).exec, env: { ...REX, ...TMUX }, pid: 100 }))?.id, 'tmux');
  // ps fails or finds none: environment order Rex → herdr → tmux
  assert.equal((await detectMultiplexer({ exec: fake(null).exec, env, pid: 100 }))?.id, 'rex');
  assert.equal((await detectMultiplexer({ exec: fake('100 1 node').exec, env: { ...TMUX, ...HERDR }, pid: 100 }))?.id, 'herdr');
  // forced
  assert.equal((await detectMultiplexer({ exec: fake(NESTED).exec, env: { ...env, CALLIOPI_MULTIPLEXER: 'rex' }, pid: 100 }))?.id, 'rex');
  assert.equal(await detectMultiplexer({ exec: fake(NESTED).exec, env: { ...TMUX, CALLIOPI_MULTIPLEXER: 'rex' }, pid: 100 }), null);
  // none
  assert.equal(await detectMultiplexer({ exec: fake('').exec, env: { REX_SESSION: 's' }, pid: 100 }), null);
  await assert.rejects(openSidePane(fake('').exec, { command: ['x'], cwd: '/', label: 'l' }, { env: {}, pid: 100 }), NoMultiplexerError);
});

test('Rex: split right of this block, command after --, block id from JSON; move beside', async () => {
  const { exec, calls } = fake(null, { 'rex split': '{"block_ids":["blk-new"]}' });
  assert.deepEqual(await openSidePane(exec, { command: ['node', 'a b.ts', '--x'], cwd: '/repo', label: 'preview', ratio: 45 }, { env: REX }), { multiplexer: 'Rex', paneId: 'blk-new' });
  assert.deepEqual(calls[0], ['rex', ['split', '-s', 'sess', '-b', 'blk', '--split=right', '--ratio', '45', '--label', 'preview', '-c', '/repo', '--json', '--', 'node', 'a b.ts', '--x']]);
  await openSidePane(exec, { command: ['x'], cwd: '/', label: 'l', keepOpen: true, focus: false }, { env: REX });
  const args = calls[1]![1];
  assert.deepEqual(args.slice(args.indexOf('-c') + 2, args.indexOf('--')), ['--keep-open', '--focus=false', '--json']);
  await (await detectMultiplexer({ exec, env: REX }))!.moveBeside(exec, 'blk-2', 45);
  assert.deepEqual(calls.at(-1), ['rex', ['move', '-s', 'sess', 'blk-2', 'right', 'blk', '--ratio', '45']]);
  const failing: Exec = async (command) => command === 'ps' ? { code: 1, stdout: '', stderr: '' } : { code: 1, stdout: '', stderr: 'no such block\n' };
  await assert.rejects(openSidePane(failing, { command: ['x'], cwd: '/', label: 'l' }, { env: REX }), /no such block/);
});

test('tmux: split-window runs the argv itself; -d keeps focus; keepOpen waits for Enter; join-pane moves', async () => {
  const { exec, calls } = fake(null, { 'tmux split-window': '%9\n' });
  assert.deepEqual(await openSidePane(exec, { command: ['node', 'a b.ts'], cwd: '/repo', label: 'l', ratio: 45, focus: false }, { env: TMUX }), { multiplexer: 'tmux', paneId: '%9' });
  assert.deepEqual(calls[0], ['tmux', ['split-window', '-h', '-t', '%3', '-l', '45%', '-c', '/repo', '-P', '-F', '#{pane_id}', '-d', '--', 'node', 'a b.ts']]);
  await openSidePane(exec, { command: ['delta', 'x y'], cwd: '/', label: 'l', keepOpen: true }, { env: TMUX });
  assert.deepEqual(calls[1]![1].slice(calls[1]![1].indexOf('--') + 1), holdOpen(['delta', 'x y']));
  // the wrapper passes arguments through untouched and keeps the pane until Enter
  assert.equal(execFileSync(holdOpen(['printf', '[%s]', 'a b', '$HOME'])[0]!, holdOpen(['printf', '[%s]', 'a b', '$HOME']).slice(1), { input: '\n', encoding: 'utf8' }).split('\n')[0], '[a b][$HOME]');
  await (await detectMultiplexer({ exec, env: TMUX }))!.moveBeside(exec, '%7', 45);
  assert.deepEqual(calls.at(-1), ['tmux', ['join-pane', '-h', '-d', '-l', '45%', '-s', '%7', '-t', '%3']]);
});

test('herdr: split, then type one line that runs a self-deleting launcher; ratio is the share kept', async () => {
  const pane = (id: string, tab = 'w1:t1') => JSON.stringify({ result: { pane: { pane_id: id, tab_id: tab } } });
  const { exec, calls } = fake(null, { 'herdr pane split': pane('w1:p2'), 'herdr pane get': pane('w1:p1', 'w1:t3') });
  assert.deepEqual(await openSidePane(exec, { command: ['node', "it's a b.ts"], cwd: '/repo', label: 'cl-preview', ratio: 45 }, { env: HERDR }), { multiplexer: 'herdr', paneId: 'w1:p2' });
  assert.deepEqual(calls[0], ['herdr', ['pane', 'split', 'w1:p1', '--direction', 'right', '--ratio', '0.55', '--cwd', '/repo', '--focus']]);
  const line = calls[1]![1].at(-1)!;
  assert.match(line, /^ exec sh '[^']+\/run\.sh'$/);
  const launcher = /'(.+)'/.exec(line)![1]!;
  assert.equal(fs.readFileSync(launcher, 'utf8').split('\n')[1], `exec 'node' 'it'\\''s a b.ts'`);
  fs.rmSync(launcher.replace(/\/run\.sh$/, ''), { recursive: true });
  assert.deepEqual(calls[2], ['herdr', ['pane', 'rename', 'w1:p2', 'cl-preview']]);
  await openSidePane(exec, { command: ['x'], cwd: '/', label: 'l', keepOpen: true }, { env: HERDR });
  assert.match(calls[4]![1].at(-1)!, /^ sh '/); // keepOpen: the shell stays after the program
  fs.rmSync(/'(.+)'/.exec(calls[4]![1].at(-1)!)![1]!.replace(/\/run\.sh$/, ''), { recursive: true });
  await (await detectMultiplexer({ exec, env: HERDR }))!.moveBeside(exec, 'w2:p4', 45);
  assert.deepEqual(calls.at(-1), ['herdr', ['pane', 'move', 'w2:p4', '--tab', 'w1:t3', '--split', 'right', '--target-pane', 'w1:p1', '--ratio', '0.55', '--no-focus']]);
});

test('herdr launcher: runs the argv exactly, then removes itself', () => {
  const file = writeLauncher(['printf', '[%s]', "it's", 'a b', '$HOME']);
  assert.equal(execFileSync('sh', [file], { encoding: 'utf8' }), "[it's][a b][$HOME]");
  assert.equal(fs.existsSync(file), false);
  assert.equal(quote(''), "''");
});
