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

// One PTY + one headless screen. A pane runs one program at a time; run() replaces a running one.
export class TerminalPane {
  child = null;
  generation = 0;
  listeners = [];
  pendingResolve = null;
  cursorVisible = true;
  disposed = false;

  constructor({ getCwd, requestRender }) {
    Object.assign(this, { getCwd, requestRender });
    this.terminal = new xterm.Terminal({ cols: 80, rows: 20, scrollback: 0, allowProposedApi: true, logLevel: 'off' });
    this.terminal.onData(data => this.child?.write(data)); // Device-status replies, e.g. fzf cursor queries.
    for (const [final, visible] of [['h', true], ['l', false]]) {
      this.terminal.parser.registerCsiHandler({ prefix: '?', final }, params => {
        if (params.includes(25)) this.cursorVisible = visible;
        return false;
      });
    }
    this.terminal.onWriteParsed(() => { if (!this.disposed) this.requestRender(); });
  }

  // Resolves with { exitCode, signal }; { exitCode: -1, stopped: true } when stopped or replaced.
  run(command, args, env = process.env) {
    if (this.disposed) return Promise.reject(new Error('창이 닫혔습니다.'));
    this.stop();
    this.terminal.reset();
    this.cursorVisible = true;
    const generation = ++this.generation;
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = pty.spawn(command, args, {
          name: 'xterm-256color', cols: this.terminal.cols, rows: this.terminal.rows,
          cwd: this.getCwd(), env: { ...env, TERM: 'xterm-256color' },
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
          // Flush the parser before the next program reuses or disposes this screen.
          this.terminal.write('', () => resolve(event));
        }),
      ];
    });
  }

  stop() {
    ++this.generation;
    const child = this.child;
    this.child = null;
    this.clearListeners();
    if (child) { try { child.kill(); } catch {} }
    const resolve = this.pendingResolve;
    this.pendingResolve = null;
    resolve?.({ exitCode: -1, signal: 1, stopped: true });
  }

  clearListeners() { for (const listener of this.listeners) listener.dispose(); this.listeners = []; }

  write(data) {
    if (!this.child || this.disposed) return '';
    const input = terminalInput(data, this.terminal.modes);
    if (input) this.child.write(input);
    return input;
  }

  resize(cols, rows) {
    if (cols === this.terminal.cols && rows === this.terminal.rows) return;
    this.terminal.resize(cols, rows);
    this.child?.resize(cols, rows);
  }

  lines(focused, ui) {
    return screenLines(this.terminal, { focused, cursorVisible: this.cursorVisible, cursorMarker: ui.CURSOR_MARKER, fakeCursor: ui.renderFakeCursor });
  }

  dispose() {
    if (this.disposed) return;
    this.stop();
    this.disposed = true;
    this.terminal.dispose();
  }
}

// Pi component: a bordered box with either one pane ("single") or two side by side ("split").
export class TerminalOverlay {
  focused = false;
  capturesViewportInput = true;
  disposed = false;
  layout = 'single';
  active = 'main';
  keyHandler = null; // (data) => true when the overlay handled the key itself
  paneTitles = { left: '', right: '' };
  title = ' Calliopi · fzf → Vim ';
  footer = ' Esc: fzf 취소 · :q: 편집 종료 ';

  constructor({ tui, theme, ui, cwd, inputLog, title, footer }) {
    Object.assign(this, { tui, theme, ui, cwd, inputLog });
    if (title) this.title = title;
    if (footer) this.footer = footer;
    this.panes = { main: this.createPane() };
  }

  createPane() { return new TerminalPane({ getCwd: () => this.cwd, requestRender: () => this.tui.requestRender() }); }

  // Single-pane API (used by /calliopi-edit and the sequential flows).
  get terminal() { return this.panes.main.terminal; }
  get child() { return this.panes.main.child; }
  run(command, args, env) { return this.panes.main.run(command, args, env); }

  pane(name) {
    if (this.disposed) throw new Error('창이 닫혔습니다.');
    return this.panes[name] ??= this.createPane();
  }

  setLayout(layout, active) {
    this.layout = layout;
    this.active = active ?? (layout === 'split' ? 'left' : 'main');
    this.tui.requestRender();
  }

  focusPane(name) { this.active = name; this.tui.requestRender(); }

  handleInput(data) {
    if (this.disposed) return;
    const handled = this.keyHandler?.(data) === true;
    const input = handled ? '(overlay)' : this.panes[this.active]?.write(data) ?? '';
    // Opt-in diagnostics: records keystrokes, so only when explicitly requested.
    if (this.inputLog) {
      const codes = s => [...s].map(c => c.codePointAt(0).toString(16)).join(' ');
      fs.appendFileSync(this.inputLog, `${JSON.stringify({ t: Date.now(), pane: this.active, in: data, inCodes: codes(data), out: input, outCodes: codes(input) })}\n`, { mode: 0o600 });
    }
  }

  // Mouse stays local; navigation uses the programs' keyboard controls in v1.
  handleMouse() { return { handled: true, focus: true, render: false }; }
  invalidate() {}

  render(width) {
    if (width < 3) return [' '.repeat(Math.max(0, width))];
    const rows = Math.max(1, Math.floor(this.tui.terminal.rows * 0.85) - 2);
    const border = text => this.theme.fg('border', text);
    const fit = (text, cols) => this.ui.truncateToWidth(text, cols, '', true);
    const footer = border('╰') + this.theme.fg('dim', fit(this.footer, width - 2)) + border('╯');
    if (this.layout === 'split' && width >= 23) {
      const leftCols = Math.max(10, Math.floor((width - 3) * 0.4));
      const rightCols = width - 3 - leftCols;
      const { left, right } = this.panes;
      left.resize(leftCols, rows);
      right.resize(rightCols, rows);
      const label = (name, cols) => (this.active === name ? text => this.theme.fg('accent', text) : text => this.theme.fg('dim', text))(fit(this.paneTitles[name], cols));
      const l = left.lines(this.focused && this.active === 'left', this.ui);
      const r = right.lines(this.focused && this.active === 'right', this.ui);
      return [border('╭') + label('left', leftCols) + border('┬') + label('right', rightCols) + border('╮'),
        ...l.map((line, i) => border('│') + line + border('│') + r[i] + border('│')),
        footer];
    }
    const cols = width - 2;
    const main = this.panes.main;
    main.resize(cols, rows);
    return [border('╭') + this.theme.fg('accent', fit(this.title, cols)) + border('╮'),
      ...main.lines(this.focused && this.active === 'main', this.ui).map(line => border('│') + line + border('│')),
      footer];
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.keyHandler = null;
    for (const pane of Object.values(this.panes)) pane.dispose();
  }
}
