import fs from 'node:fs';
import pty, { type IDisposable, type IPty } from 'node-pty';
import xterm, { type IBufferCell, type Terminal as XTerminal } from '@xterm/headless';
import type { Component, Focusable, TuiMouseEvent, TuiMouseEventResult } from '@earendil-works/pi-tui';
import { terminalInput, type TerminalInputModes } from './terminal-input.ts';
import type { PtyRunResult } from './types.ts';

type StyleFlag = 'isBold' | 'isDim' | 'isItalic' | 'isUnderline' | 'isBlink' | 'isInverse' | 'isInvisible' | 'isStrikethrough';

const styleFlags = [
  ['isBold', 1], ['isDim', 2], ['isItalic', 3], ['isUnderline', 4], ['isBlink', 5],
  ['isInverse', 7], ['isInvisible', 8], ['isStrikethrough', 9],
] as const satisfies ReadonlyArray<readonly [StyleFlag, number]>;

function color(cell: IBufferCell, foreground: boolean): string {
  const prefix = foreground ? 38 : 48;
  const value = foreground ? cell.getFgColor() : cell.getBgColor();
  if (foreground ? cell.isFgRGB() : cell.isBgRGB()) return `${prefix};2;${value >>> 16};${(value >>> 8) & 255};${value & 255}`;
  if (foreground ? cell.isFgPalette() : cell.isBgPalette()) return `${prefix};5;${value}`;
  return foreground ? '39' : '49';
}

export function cellStyle(cell: IBufferCell | null | undefined): string {
  if (!cell) return '\x1b[0m';
  const attributes = ['0', color(cell, true), color(cell, false)];
  for (const [method, code] of styleFlags) {
    if (cell[method]()) attributes.push(String(code));
  }
  return `\x1b[${attributes.join(';')}m`;
}

export interface ScreenLineOptions {
  focused: boolean;
  cursorVisible: boolean;
  cursorMarker: string;
  fakeCursor: (text: string) => string;
}

// Only reconstructed SGR and cell text reach Pi. Child cursor movement, OSC, clipboard,
// alternate screen, etc. are interpreted by xterm, never written to Pi's terminal.
export function screenLines(terminal: XTerminal, { focused, cursorVisible, cursorMarker, fakeCursor }: ScreenLineOptions): string[] {
  const buffer = terminal.buffer.active;
  const lines: string[] = [];
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

export interface OverlayUi {
  CURSOR_MARKER: string;
  renderFakeCursor(text: string): string;
  truncateToWidth(text: string, maxWidth: number, ellipsis?: string, pad?: boolean): string;
}

// Structural stand-in for Pi's TUI: real TUI instances satisfy it, and tests pass a small mock.
export interface OverlayTui {
  terminal: { columns: number; rows: number };
  requestRender(): void;
}

export interface OverlayTheme {
  fg(color: string, text: string): string;
}

interface PaneOptions {
  getCwd: () => string;
  requestRender: () => void;
}

// One PTY + one headless screen. A pane runs one program at a time; run() replaces a running one.
export class TerminalPane {
  child: IPty | null = null;
  generation = 0;
  listeners: IDisposable[] = [];
  pendingResolve: ((result: PtyRunResult) => void) | null = null;
  cursorVisible = true;
  disposed = false;
  getCwd: () => string;
  requestRender: () => void;
  terminal: XTerminal;

  constructor({ getCwd, requestRender }: PaneOptions) {
    this.getCwd = getCwd;
    this.requestRender = requestRender;
    this.terminal = new xterm.Terminal({ cols: 80, rows: 20, scrollback: 0, allowProposedApi: true, logLevel: 'off' });
    this.terminal.onData(data => this.child?.write(data)); // Device-status replies, e.g. fzf cursor queries.
    for (const [final, visible] of [['h', true], ['l', false]] as const) {
      this.terminal.parser.registerCsiHandler({ prefix: '?', final }, params => {
        if (params.includes(25)) this.cursorVisible = visible;
        return false;
      });
    }
    this.terminal.onWriteParsed(() => { if (!this.disposed) this.requestRender(); });
  }

  // Resolves with { exitCode, signal }; { exitCode: -1, stopped: true } when stopped or replaced.
  run(command: string, args: string[], env: NodeJS.ProcessEnv = process.env): Promise<PtyRunResult> {
    if (this.disposed) return Promise.reject(new Error('창이 닫혔습니다.'));
    this.stop();
    this.terminal.reset();
    this.cursorVisible = true;
    const generation = ++this.generation;
    return new Promise((resolve, reject) => {
      let child: IPty;
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

  stop(): void {
    ++this.generation;
    const child = this.child;
    this.child = null;
    this.clearListeners();
    if (child) { try { child.kill(); } catch { /* already gone */ } }
    const resolve = this.pendingResolve;
    this.pendingResolve = null;
    resolve?.({ exitCode: -1, signal: 1, stopped: true });
  }

  clearListeners(): void { for (const listener of this.listeners) listener.dispose(); this.listeners = []; }

  write(data: string): string {
    if (!this.child || this.disposed) return '';
    const input = terminalInput(data, this.terminal.modes satisfies TerminalInputModes);
    if (input) this.child.write(input);
    return input;
  }

  resize(cols: number, rows: number): void {
    if (cols === this.terminal.cols && rows === this.terminal.rows) return;
    this.terminal.resize(cols, rows);
    this.child?.resize(cols, rows);
  }

  lines(focused: boolean, ui: OverlayUi): string[] {
    return screenLines(this.terminal, { focused, cursorVisible: this.cursorVisible, cursorMarker: ui.CURSOR_MARKER, fakeCursor: ui.renderFakeCursor });
  }

  dispose(): void {
    if (this.disposed) return;
    this.stop();
    this.disposed = true;
    this.terminal.dispose();
  }
}

export type OverlayLayout = 'single' | 'split';
export type PaneName = 'main' | 'left' | 'right';

export interface OverlayOptions {
  tui: OverlayTui;
  theme: OverlayTheme;
  ui: OverlayUi;
  cwd: string;
  inputLog?: string;
  title?: string;
  footer?: string;
}

// Pi component: a bordered box with either one pane ("single") or two side by side ("split").
export class TerminalOverlay implements Component, Focusable {
  focused = false;
  capturesViewportInput = true;
  disposed = false;
  layout: OverlayLayout = 'single';
  active: PaneName = 'main';
  keyHandler: ((data: string) => boolean) | null = null; // (data) => true when the overlay handled the key itself
  paneTitles: { left: string; right: string } = { left: '', right: '' };
  title = ' Calliopi · fzf → Vim ';
  footer = ' Esc: fzf 취소 · :q: 편집 종료 ';
  tui: OverlayTui;
  theme: OverlayTheme;
  ui: OverlayUi;
  cwd: string;
  inputLog?: string;
  panes: Record<string, TerminalPane>;

  constructor({ tui, theme, ui, cwd, inputLog, title, footer }: OverlayOptions) {
    this.tui = tui;
    this.theme = theme;
    this.ui = ui;
    this.cwd = cwd;
    this.inputLog = inputLog;
    if (title) this.title = title;
    if (footer) this.footer = footer;
    this.panes = { main: this.createPane() };
  }

  createPane(): TerminalPane { return new TerminalPane({ getCwd: () => this.cwd, requestRender: () => this.tui.requestRender() }); }

  // Single-pane API (used by /calliopi-edit and the sequential flows).
  get terminal(): XTerminal { return this.panes.main!.terminal; }
  get child(): IPty | null { return this.panes.main!.child; }
  run(command: string, args: string[], env?: NodeJS.ProcessEnv): Promise<PtyRunResult> { return this.panes.main!.run(command, args, env); }

  pane(name: string): TerminalPane {
    if (this.disposed) throw new Error('창이 닫혔습니다.');
    return this.panes[name] ??= this.createPane();
  }

  setLayout(layout: OverlayLayout, active?: PaneName): void {
    this.layout = layout;
    this.active = active ?? (layout === 'split' ? 'left' : 'main');
    this.tui.requestRender();
  }

  focusPane(name: PaneName): void { this.active = name; this.tui.requestRender(); }

  handleInput(data: string): void {
    if (this.disposed) return;
    const handled = this.keyHandler?.(data) === true;
    const input = handled ? '(overlay)' : this.panes[this.active]?.write(data) ?? '';
    // Opt-in diagnostics: records keystrokes, so only when explicitly requested.
    if (this.inputLog) {
      const codes = (s: string) => [...s].map(c => (c.codePointAt(0) ?? 0).toString(16)).join(' ');
      fs.appendFileSync(this.inputLog, `${JSON.stringify({ t: Date.now(), pane: this.active, in: data, inCodes: codes(data), out: input, outCodes: codes(input) })}\n`, { mode: 0o600 });
    }
  }

  // Mouse stays local; navigation uses the programs' keyboard controls in v1.
  handleMouse(_event?: TuiMouseEvent): TuiMouseEventResult { return { handled: true, focus: true, render: false }; }
  invalidate(): void {}

  render(width: number): string[] {
    if (width < 3) return [' '.repeat(Math.max(0, width))];
    const rows = Math.max(1, Math.floor(this.tui.terminal.rows * 0.85) - 2);
    const border = (text: string) => this.theme.fg('border', text);
    const fit = (text: string, cols: number) => this.ui.truncateToWidth(text, cols, '', true);
    const footer = border('╰') + this.theme.fg('dim', fit(this.footer, width - 2)) + border('╯');
    if (this.layout === 'split' && width >= 23) {
      const leftCols = Math.max(10, Math.floor((width - 3) * 0.4));
      const rightCols = width - 3 - leftCols;
      const left = this.panes.left!;
      const right = this.panes.right!;
      left.resize(leftCols, rows);
      right.resize(rightCols, rows);
      const label = (name: 'left' | 'right', cols: number) => (this.active === name ? (text: string) => this.theme.fg('accent', text) : (text: string) => this.theme.fg('dim', text))(fit(this.paneTitles[name], cols));
      const l = left.lines(this.focused && this.active === 'left', this.ui);
      const r = right.lines(this.focused && this.active === 'right', this.ui);
      return [border('╭') + label('left', leftCols) + border('┬') + label('right', rightCols) + border('╮'),
        ...l.map((line, i) => border('│') + line + border('│') + r[i] + border('│')),
        footer];
    }
    const cols = width - 2;
    const main = this.panes.main!;
    main.resize(cols, rows);
    return [border('╭') + this.theme.fg('accent', fit(this.title, cols)) + border('╮'),
      ...main.lines(this.focused && this.active === 'main', this.ui).map(line => border('│') + line + border('│')),
      footer];
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.keyHandler = null;
    for (const pane of Object.values(this.panes)) pane.dispose();
  }
}
