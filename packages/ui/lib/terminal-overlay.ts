import fs from 'node:fs';
import pty from 'node-pty';
import xterm from '@xterm/headless';
import { terminalInput } from './terminal-input.ts';

function color(cell, foreground) {
  const prefix = foreground ? 38 : 48;
  const value = foreground ? cell.getFgColor() : cell.getBgColor();
  if (foreground ? cell.isFgRGB() : cell.isBgRGB()) return `${prefix};2;${value >>> 16};${(value >>> 8) & 255};${value & 255}`;
  if (foreground ? cell.isFgPalette() : cell.isBgPalette()) return `${prefix};5;${value}`;
  return foreground ? '39' : '49';
}

export function cellStyle(cell) {
  if (!cell) return '\x1b[0m';
  const attributes = ['0', color(cell, true), color(cell, false)];
  for (const [method, code] of [['isBold', 1], ['isDim', 2], ['isItalic', 3], ['isUnderline', 4], ['isBlink', 5], ['isInverse', 7], ['isInvisible', 8], ['isStrikethrough', 9]]) {
    if (cell[method]()) attributes.push(String(code));
  }
  return `\x1b[${attributes.join(';')}m`;
}

// Only reconstructed SGR and cell text reach Pi. Child cursor movement, OSC, clipboard,
// alternate screen, etc. are interpreted by xterm, never written to Pi's terminal.
export function screenLines(terminal, { focused, cursorVisible, cursorMarker, fakeCursor }) {
  const buffer = terminal.buffer.active;
  const lines = [];
  for (let y = 0; y < terminal.rows; y++) {
    const line = buffer.getLine(buffer.viewportY + y);
    let output = '\x1b[0m', previousStyle = '';
    for (let x = 0; x < terminal.cols; x++) {
      const cell = line?.getCell(x);
      if (cell?.getWidth() === 0) continue;
      const style = cellStyle(cell);
      if (style !== previousStyle) { output += style; previousStyle = style; }
      const text = (cell?.getChars() || ' ').replace(/[\x00-\x1f\x7f-\x9f]/g, '');
      const cursor = focused && cursorVisible && y === buffer.cursorY && x === Math.min(buffer.cursorX, terminal.cols - 1);
      output += cursor ? cursorMarker + fakeCursor(text) : text;
    }
    lines.push(`${output}\x1b[0m`);
  }
  return lines;
}

export class TerminalOverlay {
  focused = false;
  capturesViewportInput = true;
  disposed = false;
  cursorVisible = true;
  child = null;
  generation = 0;
  listeners = [];
  pendingResolve = null;

  constructor({ tui, theme, ui, cwd, inputLog }) {
    Object.assign(this, { tui, theme, ui, cwd, inputLog });
    this.terminal = new xterm.Terminal({ cols: 80, rows: 20, scrollback: 0, allowProposedApi: true, logLevel: 'off' });
    this.terminal.onData(data => this.child?.write(data)); // Device-status replies, e.g. fzf cursor queries.
    for (const [final, visible] of [['h', true], ['l', false]]) {
      this.terminal.parser.registerCsiHandler({ prefix: '?', final }, params => {
        if (params.includes(25)) this.cursorVisible = visible;
        return false;
      });
    }
    this.terminal.onWriteParsed(() => { if (!this.disposed) this.tui.requestRender(); });
  }

  run(command, args, env = process.env) {
    if (this.disposed) return Promise.reject(new Error('편집 창이 닫혔습니다.'));
    this.terminal.reset();
    this.cursorVisible = true;
    const generation = ++this.generation;
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = pty.spawn(command, args, {
          name: 'xterm-256color', cols: this.terminal.cols, rows: this.terminal.rows,
          cwd: this.cwd, env: { ...env, TERM: 'xterm-256color' },
        });
      } catch (error) { reject(error); return; }
      this.child = child;
      this.pendingResolve = resolve;
      this.listeners = [
        child.onData(data => {
          if (!this.disposed && generation === this.generation) this.terminal.write(data);
        }),
        child.onExit(event => {
          if (generation !== this.generation) return;
          this.child = null;
          this.pendingResolve = null;
          this.clearListeners();
          // Flush the parser before moving from fzf to Vim or disposing its buffer.
          this.terminal.write('', () => resolve(event));
        }),
      ];
    });
  }

  clearListeners() { for (const listener of this.listeners) listener.dispose(); this.listeners = []; }

  handleInput(data) {
    if (!this.child || this.disposed) return;
    const input = terminalInput(data, this.terminal.modes);
    // Opt-in diagnostics: records keystrokes, so only when explicitly requested.
    if (this.inputLog) {
      const codes = s => [...s].map(c => c.codePointAt(0).toString(16)).join(' ');
      fs.appendFileSync(this.inputLog, `${JSON.stringify({ t: Date.now(), in: data, inCodes: codes(data), out: input, outCodes: codes(input) })}\n`, { mode: 0o600 });
    }
    if (input) this.child.write(input);
  }

  // Mouse stays local; selection/navigation use fzf/Vim's keyboard controls in v1.
  handleMouse() { return { handled: true, focus: true, render: false }; }
  invalidate() {}

  render(width) {
    if (width < 3) return [' '.repeat(Math.max(0, width))];
    const cols = Math.max(1, width - 2);
    const rows = Math.max(1, Math.floor(this.tui.terminal.rows * 0.85) - 2);
    if (cols !== this.terminal.cols || rows !== this.terminal.rows) {
      this.terminal.resize(cols, rows);
      this.child?.resize(cols, rows);
    }
    const border = text => this.theme.fg('border', text);
    const header = this.ui.truncateToWidth(' Calliopi · fzf → Vim ', cols, '', true);
    const footer = this.ui.truncateToWidth(' Esc: fzf 취소 · :q: 편집 종료 ', cols, '', true);
    const body = screenLines(this.terminal, {
      focused: this.focused, cursorVisible: this.cursorVisible,
      cursorMarker: this.ui.CURSOR_MARKER, fakeCursor: this.ui.renderFakeCursor,
    });
    return [border('╭') + this.theme.fg('accent', header) + border('╮'),
      ...body.map(line => border('│') + line + border('│')),
      border('╰') + this.theme.fg('dim', footer) + border('╯')];
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    ++this.generation;
    const child = this.child;
    this.child = null;
    this.clearListeners();
    if (child) { try { child.kill(); } catch {} }
    this.pendingResolve?.({ exitCode: -1, signal: 1 });
    this.pendingResolve = null;
    this.terminal.dispose();
  }
}
