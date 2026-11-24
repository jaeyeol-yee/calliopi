// End to end: the pane program on a real terminal (node-pty + headless xterm), with real git and fzf.
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import pty from 'node-pty';
import xterm from '@xterm/headless';
import { writeRequest } from '#lib/preview-share.ts';

const paneScript = fileURLToPath(new URL('../bin/preview-pane.ts', import.meta.url));
const has = (command: string) => spawnSync('/bin/sh', ['-c', 'command -v "$1"', 'sh', command]).status === 0;

function setup(t: TestContext, file: string) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'calliopi-pane-repo-')));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'calliopi-pane-state-'));
  t.after(() => { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(dir, { recursive: true, force: true }); });
  let tick = 0;
  const g = (...args: string[]) => {
    const date = `2026-01-0${1 + tick++}T00:00:00Z`;
    assert.equal(spawnSync('git', args, { cwd: root, env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } }).status, 0);
  };
  const write = (f: string, s: string) => fs.writeFileSync(path.join(root, f), s);
  g('init', '-q', '-b', 'main'); g('config', 'user.name', 't'); g('config', 'user.email', 't@e'); g('config', 'commit.gpgsign', 'false');
  fs.mkdirSync(path.join(dir, 'outbox'));
  const config = path.join(dir, 'config.json');
  fs.writeFileSync(config, JSON.stringify({ cwd: root, root, file, dir, piPid: process.pid }));
  return { root, dir, g, write, config };
}

function start(t: TestContext, cwd: string, config: string) {
  const term = new xterm.Terminal({ cols: 90, rows: 24, allowProposedApi: true, logLevel: 'off' });
  const child = pty.spawn(process.execPath, [paneScript, config], { cwd, cols: 90, rows: 24, env: { ...process.env, TERM: 'xterm-256color', CALLIOPI_PREVIEW_PLAIN: '1' } });
  let exited: number | null = null;
  child.onData(d => term.write(d));
  child.onExit(e => { exited = e.exitCode; });
  t.after(() => { if (exited === null) child.kill(); term.dispose(); });
  const screen = () => Array.from({ length: term.rows }, (_, y) => term.buffer.active.getLine(term.buffer.active.viewportY + y)?.translateToString(true) ?? '').join('\n');
  const wait = async (ok: () => boolean, label: string) => {
    const t0 = Date.now();
    while (!ok()) {
      if (Date.now() - t0 > 8000) throw new Error(`${label}\n${screen().split('\n').map((l, i) => `${String(i).padStart(2)}|${l}`).join('\n')}`);
      await new Promise(r => setTimeout(r, 30));
    }
  };
  return { send: (s: string) => child.write(s), screen, wait, exited: () => exited };
}

test('pane: shows the file → b: branch diff since divergence → live update → tip → share → v → switch file → q', { timeout: 40_000 }, async t => {
  if (!has('fzf') || !has('git')) return t.skip('fzf/git required');
  const { root, dir, g, write, config } = setup(t, 'a.txt');
  write('a.txt', '1\n2\n3\n'); write('other.txt', 'other-content\n'); g('add', '.'); g('commit', '-qm', 'base');
  g('branch', 'feature');
  write('a.txt', '1\n2\n3main\n'); g('commit', '-qam', 'main moves on');
  g('checkout', '-q', 'feature');
  write('a.txt', '1mine\n2\n3\n');
  const p = start(t, root, config);

  // Pi already picked the file: the pane starts on it, with the key map at the bottom.
  await p.wait(() => p.screen().includes('a.txt · 파일') && p.screen().includes('1mine') && p.screen().includes('b  브랜치와 비교'), 'file view first');
  assert.ok(fs.existsSync(path.join(dir, 'pane.pid')));

  p.send('b'); // branch list on demand, without the sidebar until Ctrl+/
  await p.wait(() => p.screen().includes('비교할 브랜치 >') && p.screen().includes('Ctrl+/: 미리보기 사이드바'), 'branch list');
  assert.doesNotMatch(p.screen(), /1mine/);
  p.send('main\r');
  await p.wait(() => p.screen().includes('+1mine') && p.screen().includes('main에서 갈라진 뒤'), 'diff since divergence');
  assert.doesNotMatch(p.screen(), /3main/);

  write('a.txt', '1mine\n2\n3\n4live\n'); // the model (or anyone) edits the file
  await p.wait(() => p.screen().includes('+4live') && p.screen().includes('↻'), 'live update');

  p.send('m');
  await p.wait(() => p.screen().includes('-3main') && p.screen().includes('main 끝과 비교'), 'tip mode');

  p.send('s');
  await p.wait(() => fs.readdirSync(path.join(dir, 'outbox')).some(n => n.endsWith('.json')), 'share written');
  const [shared] = fs.readdirSync(path.join(dir, 'outbox')).filter(n => n.endsWith('.json'));
  const share = JSON.parse(fs.readFileSync(path.join(dir, 'outbox', shared!), 'utf8'));
  assert.deepEqual([share.file, share.mode, share.ref], ['a.txt', 'tip', 'main']);
  assert.match(share.text, /\+4live/);

  p.send('v');
  await p.wait(() => p.screen().includes('a.txt · 파일') && p.screen().includes('4live'), 'back to the file');

  writeRequest(dir, 'other.txt'); // /cl-preview again in Pi: same pane, new file
  await p.wait(() => p.screen().includes('other.txt · 파일') && p.screen().includes('other-content'), 'switched file');
  write('a.txt', 'ignored now\n');
  write('other.txt', 'other-content\nedited\n');
  await p.wait(() => p.screen().includes('edited'), 'follows the new file');

  p.send('q');
  await p.wait(() => p.exited() !== null, 'q closes the pane');
  assert.equal(p.exited(), 0);
  assert.ok(fs.existsSync(path.join(dir, 'closed')));
});

test('pane: file view scrolls by keys and mouse wheel, searches, and Ctrl+C closes', { timeout: 30_000 }, async t => {
  if (!has('git')) return t.skip('git required');
  const { root, g, write, config } = setup(t, 'long.txt');
  write('long.txt', Array.from({ length: 200 }, (_, i) => `row ${i + 1}${i === 149 ? ' target' : ''}`).join('\n') + '\n');
  g('add', '.'); g('commit', '-qm', 'long');
  const p = start(t, root, config);
  await p.wait(() => p.screen().includes('long.txt · 파일 · 1-22/200'), 'file view');
  p.send('\x1b[<65;10;10M'); // wheel down: 3 lines
  await p.wait(() => p.screen().includes('4-25/200'), 'wheel scroll');
  p.send('\x1b[6~'); // page down: body rows - 1
  await p.wait(() => p.screen().includes('25-46/200'), 'page down');
  p.send('/target\r');
  await p.wait(() => p.screen().includes('150-171/200') && p.screen().includes('row 150 target'), 'search');
  p.send('G');
  await p.wait(() => p.screen().includes('179-200/200'), 'end');
  p.send('\x03');
  await p.wait(() => p.exited() !== null, 'Ctrl+C closes the pane');
});
