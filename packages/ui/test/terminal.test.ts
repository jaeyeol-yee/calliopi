import test from 'node:test';
import assert from 'node:assert/strict';
import xterm, { type Terminal } from '@xterm/headless';
import { terminalInput } from '#lib/terminal-input.ts';
import { TerminalOverlay, screenLines, type OverlayUi } from '#lib/terminal-overlay.ts';

const ui: OverlayUi = { CURSOR_MARKER: '<cursor>', renderFakeCursor: text => `<fake>${text}</fake>`, truncateToWidth: (s, n, _ellipsis, pad) => s.slice(0, n).padEnd(pad ? n : 0) };
const theme = { fg: (_name: string, text: string) => text };
const write = (terminal: Terminal, data: string) => new Promise<void>(resolve => terminal.write(data, resolve));
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

test('translate Kitty keys into legacy PTY input without swallowing Vim controls', () => {
  for (const [input, expected] of [
    ['\x1b[13u', '\r'], ['\x1b[27u', '\x1b'], ['\x1b[99;5u', '\x03'],
    ['\x1b[100;5u', '\x04'], ['\x1b[97;1:3u', ''], ['\x1b[97;1:2u', 'a'],
    ['\x1b[97:65;2u', 'A'], ['\x1b[9;2u', '\x1b[Z'], ['한글', '한글'],
    ['\x1b[49;2u', '!'], ['\x1b[92;2u', '|'], ['\x1b[128512u', '😀'],
    // Real Rex/Kitty log while typing 무야호 with the macOS Korean IME: jamo key releases
    // (empty shifted field) must be dropped; only IME-committed syllables reach the PTY.
    ['\x1b[12609::97;1:3u', ''], ['\x1b[12636::110;1:3u', ''], ['무', '무'],
    ['\x1b[12609::97;1u', 'ㅁ'], ['\x1b[12609::97;1:2u', 'ㅁ'], ['\x1b[99999:::;;u', ''],
    ['\x1b[57352;5u', '\x1b[1;5A'], ['\x1b[57364u', '\x1bOP'], ['\x1b[54;5u', '\x1e'],
    ['\x1b[1;1:3A', ''], ['\x1b[1;1:2A', '\x1b[A'], ['\x1b[1;1:1B', '\x1b[B'], ['\x1b[3;1~', '\x1b[3~'], ['\x1b[1;5A', '\x1b[1;5A'],
  ]) assert.equal(terminalInput(input), expected, JSON.stringify(input));
  assert.equal(terminalInput('\x1b[A', { applicationCursorKeysMode: true }), '\x1bOA');
  assert.equal(terminalInput('\x1b[200~pasted\x1b[201~'), 'pasted');
  assert.equal(terminalInput('\x1b[200~pasted\x1b[201~', { bracketedPasteMode: true }), '\x1b[200~pasted\x1b[201~');
});

test('screen rendering preserves styles, wide characters and cursor; never forwards child OSC', async () => {
  const terminal = new xterm.Terminal({ cols: 20, rows: 3, allowProposedApi: true, logLevel: 'off' });
  try {
    await write(terminal, '\x1b[31m한글\x1b[0m hi\x1b]52;c;c2VjcmV0\x07\x1b[2;3H');
    const lines = screenLines(terminal, { focused: true, cursorVisible: true, cursorMarker: '<cursor>', fakeCursor: ui.renderFakeCursor });
    assert.match(lines[0], /한글/);
    assert.match(lines[0], /38;5;1/);
    assert.match(lines[1], /<cursor><fake> <\/fake>/);
    assert.doesNotMatch(lines.join('\n'), /52;c|c2VjcmV0/);
  } finally { terminal.dispose(); }
});

test('PTY run, resize, alternate screen, parser replies and disposal', { timeout: 12_000 }, async t => {
  const view = makeView();
  t.after(() => view.dispose());
  view.render(72);
  assert.equal(view.terminal.cols, 70);
  const run = view.run('/bin/sh', ['-c', 'printf "\\033[?1049hhello\\033[6n"; read reply; printf "\\033[?1049l"']);
  await waitFor(() => plain(view.terminal).includes('hello'));
  assert.equal(view.terminal.buffer.active.type, 'alternate');
  view.tui.terminal.rows = 24;
  view.render(60);
  assert.equal(view.terminal.cols, 58);
  assert.equal(view.terminal.rows, 18);
  view.handleInput('\r');
  assert.equal((await run).exitCode, 0);
  assert.equal(view.terminal.buffer.active.type, 'normal');
  const running = view.run('/bin/sh', ['-c', 'sleep 60']);
  view.dispose();
  assert.equal((await running).exitCode, -1);
  assert.equal(view.child, null);
  view.dispose();
});

test('overlay key names: press only, legacy and Kitty forms, Caps/Num Lock ignored', async () => {
  const { keyName } = await import('#lib/terminal-input.ts');
  const cases: Array<[string, string | null]> = [['\r', 'enter'], ['\x1b[13u', 'enter'], ['\x1b[13;65u', 'enter'], ['\x1b', 'escape'], ['\x1b[27u', 'escape'],
    ['\t', 'tab'], ['\x1b[9u', 'tab'], ['\x1b[Z', 'shift+tab'], ['\x1b[9;2u', 'shift+tab'], ['\x03', 'ctrl+c'], ['\x1b[99;5u', 'ctrl+c'],
    ['\x1b[13;1:3u', null], ['\x1b[27;1:3u', null], ['a', null], ['\x1b[13;3u', null]];
  for (const [input, name] of cases) assert.equal(keyName(input), name, JSON.stringify(input));
  // Caps Lock (64) must not make ordinary keys disappear.
  assert.equal(terminalInput('\x1b[97;65u'), 'a');
  assert.equal(terminalInput('\x1b[99;69u'), '\x03');
});
