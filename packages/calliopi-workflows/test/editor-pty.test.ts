import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { Terminal } from '@xterm/headless';
import { TerminalOverlay, type OverlayUi } from '@calliopi/ui/terminal-overlay';
import { editOneFile } from '#lib/editor-flow.ts';

const ui: OverlayUi = { CURSOR_MARKER: '<cursor>', renderFakeCursor: text => `<fake>${text}</fake>`, truncateToWidth: (s, n, _ellipsis, pad) => s.slice(0, n).padEnd(pad ? n : 0) };
const theme = { fg: (_name: string, text: string) => text };
const plain = (terminal: Terminal) => Array.from({ length: terminal.rows }, (_, y) => terminal.buffer.active.getLine(terminal.buffer.active.viewportY + y)?.translateToString(true) || '').join('\n');

function waitFor(predicate: () => boolean, ms = 8000) {
  return new Promise<void>((resolve, reject) => {
    const start = Date.now();
    const timer = setInterval(() => {
      if (predicate()) { clearInterval(timer); resolve(); }
      else if (Date.now() - start > ms) { clearInterval(timer); reject(new Error('screen wait timed out')); }
    }, 20);
  });
}

function makeView() {
  const tui = { terminal: { columns: 100, rows: 32 }, requestRender() {} };
  return new TerminalOverlay({ tui, theme, ui, cwd: process.cwd() });
}

test('real fzf → real Vim → diff, entirely through the overlay PTY', { timeout: 20_000 }, async t => {
  if (['rg', 'fzf', 'vim'].some(command => spawnSync('/bin/sh', ['-c', 'command -v "$1"', 'sh', command]).status !== 0)) return t.skip('rg/fzf/vim required');
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'calliopi-pty-test-'));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'calliopi-picker-test-'));
  const file = "한글 ' spaces.txt";
  fs.writeFileSync(path.join(cwd, file), 'before\n');
  const view = makeView();
  view.cwd = cwd;
  view.focused = true;
  view.render(90);
  t.after(() => { view.dispose(); fs.rmSync(cwd, { recursive: true, force: true }); fs.rmSync(directory, { recursive: true, force: true }); });
  const result = await editOneFile({ cwd, candidates: [file], directory, run: async (command, args, env) => {
    const running = view.run(command, args, env);
    if (command === '/bin/sh') {
      await waitFor(() => plain(view.terminal).includes('File >') && plain(view.terminal).includes('spaces.txt'));
      view.handleInput('\x1b[13u'); // outer terminal's Kitty Enter
    } else {
      await waitFor(() => plain(view.terminal).includes('before'));
      view.handleInput('gg0Cafter\x1b:wq\r');
    }
    return running;
  } });
  if (result === null || result.content === null) throw new Error('expected an edit');
  assert.equal(result.exitCode, 0);
  assert.equal(fs.readFileSync(path.join(cwd, file), 'utf8'), 'after\n');
  assert.match(result.content, /-before/);
  assert.match(result.content, /\+after/);
});
