// /cl-preview's file search inside Pi's PTY overlay, with real fzf and Kitty-encoded keys.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { Terminal } from '@xterm/headless';
import { TerminalOverlay, type OverlayUi } from '@calliopi/ui/terminal-overlay';
import { pickFile } from '#lib/preview-pick.ts';

const ui: OverlayUi = { CURSOR_MARKER: '<cursor>', renderFakeCursor: text => `<fake>${text}</fake>`, truncateToWidth: (s, n, _e, pad) => s.slice(0, n).padEnd(pad ? n : 0) };
const plain = (terminal: Terminal) => Array.from({ length: terminal.rows }, (_, y) => terminal.buffer.active.getLine(terminal.buffer.active.viewportY + y)?.translateToString(true) || '').join('\n');
const waitFor = async (ok: () => boolean, label: string, terminal: Terminal) => {
  const t0 = Date.now();
  while (!ok()) { if (Date.now() - t0 > 8000) throw new Error(`${label}\n${plain(terminal)}`); await new Promise(r => setTimeout(r, 20)); }
};

test('overlay file search: query pre-filled, guide at the bottom, sidebar open, Ctrl+T file/diff, Alt+↓ scrolls under a fixed title, Ctrl+/ hides, Enter returns', { timeout: 20_000 }, async t => {
  if (spawnSync('/bin/sh', ['-c', 'command -v fzf && command -v git']).status !== 0) return t.skip('fzf/git required');
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'calliopi-pick-')));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'calliopi-pick-state-'));
  const g = (...args: string[]) => assert.equal(spawnSync('git', args, { cwd }).status, 0, args.join(' '));
  g('init', '-q', '-b', 'main'); g('config', 'user.name', 't'); g('config', 'user.email', 't@e'); g('config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(cwd, 'alpha.ts'), 'alpha-body\n');
  fs.writeFileSync(path.join(cwd, 'beta.ts'), 'beta-body\n');
  g('add', '.'); g('commit', '-qm', 'base'); g('checkout', '-qb', 'feature');
  const long = Array.from({ length: 120 }, (_, i) => `beta-line-${i + 1}`).join('\n');
  fs.writeFileSync(path.join(cwd, 'beta.ts'), `beta-body\nbeta-new\n${long}\n`);
  const plainBefore = process.env.CALLIOPI_PREVIEW_PLAIN;
  process.env.CALLIOPI_PREVIEW_PLAIN = '1'; // the preview inherits it through fzf: no bat/delta
  const view = new TerminalOverlay({ tui: { terminal: { columns: 110, rows: 30 }, requestRender() {} }, theme: { fg: (_n: string, s: string) => s }, ui, cwd });
  view.focused = true; view.render(100);
  t.after(() => {
    view.dispose(); fs.rmSync(cwd, { recursive: true, force: true }); fs.rmSync(directory, { recursive: true, force: true });
    if (plainBefore === undefined) delete process.env.CALLIOPI_PREVIEW_PLAIN; else process.env.CALLIOPI_PREVIEW_PLAIN = plainBefore;
  });
  const picked = await pickFile({ candidates: ['alpha.ts', 'beta.ts'], directory, query: 'bet', cwd, root: cwd, run: async (command, args, env) => {
    const running = view.run(command, args, env);
    const screen = () => plain(view.terminal);
    await waitFor(() => screen().includes('File > bet') && screen().includes('Ctrl+/: 미리보기 사이드바'), 'search with query', view.terminal);
    const lines = screen().split('\n');
    assert.ok(lines.findIndex(l => l.includes('File >')) > lines.findIndex(l => l.includes('beta.ts')), 'prompt below the list');
    await waitFor(() => screen().includes('beta-body') && screen().includes('파일 · Ctrl+T: diff · Alt+↑↓: 스크롤'), 'sidebar open on the file', view.terminal);
    view.handleInput('\x1b[1;3B'); view.handleInput('\x1b[1;3B'); // Alt+↓ twice: half a page each
    await waitFor(() => !screen().includes('beta-body') && /beta-line-\d\d/.test(screen()) && screen().includes('파일 · Ctrl+T: diff'), 'scrolled, title kept', view.terminal);
    view.handleInput('\x1b[116;5u'); // Kitty Ctrl+T: diff since the parent branch (found on first use), from the top
    await waitFor(() => screen().includes('+beta-new') && screen().includes('main에서 갈라진 뒤 diff'), 'diff mode', view.terminal);
    view.handleInput('\x1b[116;5u');
    await waitFor(() => screen().includes('파일 · Ctrl+T: diff') && screen().includes('beta-body') && !screen().includes('+beta-new'), 'back to the file', view.terminal);
    view.handleInput('\x1b[47;5u'); // Kitty Ctrl+/
    await waitFor(() => !screen().includes('beta-body'), 'sidebar hidden', view.terminal);
    view.handleInput('\x1b[13u'); // Kitty Enter
    return running;
  } });
  assert.equal(picked, 'beta.ts');
});

test('overlay file search outside git: the sidebar shows the file, Ctrl+T explains there is no diff', { timeout: 20_000 }, async t => {
  if (spawnSync('/bin/sh', ['-c', 'command -v fzf']).status !== 0) return t.skip('fzf required');
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'calliopi-pick-')));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'calliopi-pick-state-'));
  fs.writeFileSync(path.join(cwd, 'gamma.ts'), 'gamma-body\n');
  const view = new TerminalOverlay({ tui: { terminal: { columns: 110, rows: 30 }, requestRender() {} }, theme: { fg: (_n: string, s: string) => s }, ui, cwd });
  view.focused = true; view.render(100);
  t.after(() => { view.dispose(); fs.rmSync(cwd, { recursive: true, force: true }); fs.rmSync(directory, { recursive: true, force: true }); });
  const picked = await pickFile({ candidates: ['gamma.ts'], directory, cwd, root: null, run: async (command, args, env) => {
    const running = view.run(command, args, env);
    const screen = () => plain(view.terminal);
    await waitFor(() => screen().includes('File >') && screen().includes('gamma-body'), 'file first', view.terminal);
    view.handleInput('\x1b[116;5u');
    await waitFor(() => screen().includes('git 저장소가 아니라'), 'no diff outside git', view.terminal);
    view.handleInput('\x1b[13u');
    return running;
  } });
  assert.equal(picked, 'gamma.ts');
});
