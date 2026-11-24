// Pure part of the pane's scrolling viewer: state, scrolling, search, framing and input parsing.
// The terminal loop in preview-pane.ts feeds it bytes and writes the frames it returns.
import { fitAnsi, stripAnsi, visibleWidth } from '#lib/preview-render.ts';

export interface ViewerState {
  lines: string[];
  offset: number;
  /** Last search; n/N repeat it. */
  query: string;
  /** Text being typed after '/', or null when not searching. */
  prompt: string | null;
}

/** One entry of the key map row: the key in a block, then what it does. */
export interface KeyHint { key: string; label: string }

export const bodyRows = (rows: number) => Math.max(1, rows - 2); // last two rows: status bar, key map
export const maxOffset = (s: ViewerState, rows: number) => Math.max(0, s.lines.length - bodyRows(rows));
export const clamp = (s: ViewerState, rows: number) => { s.offset = Math.max(0, Math.min(s.offset, maxOffset(s, rows))); };

export function scroll(s: ViewerState, delta: number, rows: number) { s.offset += delta; clamp(s, rows); }

/** Next line containing query (smart case) after `from` going `dir`, wrapping around; -1 if none. */
export function find(s: ViewerState, query: string, from: number, dir: 1 | -1): number {
  if (!query) return -1;
  const sensitive = /[A-Z]/.test(query);
  const needle = sensitive ? query : query.toLowerCase();
  const n = s.lines.length;
  for (let step = 1; step <= n; step++) {
    const i = ((from + dir * step) % n + n) % n;
    const hay = stripAnsi(s.lines[i]!);
    if ((sensitive ? hay : hay.toLowerCase()).includes(needle)) return i;
  }
  return -1;
}

/**
 * Key map row, zellij style: ` key ` blocks followed by labels. Hints that do not fit are dropped
 * whole rather than cut mid-word; the row is padded to exactly `cols` cells.
 */
export function keyMap(keys: KeyHint[], cols: number): string {
  let out = '', used = 0;
  for (const { key, label } of keys) {
    const k = ` ${stripAnsi(key)} `, l = ` ${stripAnsi(label)} `;
    const w = visibleWidth(k) + visibleWidth(l);
    if (used + w > cols) break;
    out += `\x1b[1;7m${k}\x1b[0m\x1b[2m${l}\x1b[0m`; used += w;
  }
  return `${out}${' '.repeat(cols - used)}\x1b[K`;
}

/** Whole screen: body rows (each cleared to end of line), a reverse-video status bar and the key map row. */
export function frame(s: ViewerState, cols: number, rows: number, left: string, right: string, keys: KeyHint[] = []): string {
  clamp(s, rows);
  const body = Array.from({ length: bodyRows(rows) }, (_, i) => `${fitAnsi(s.lines[s.offset + i] ?? '', cols)}\x1b[K`);
  const status = s.prompt !== null ? `/${s.prompt}` : left;
  const room = cols - visibleWidth(status);
  const bar = room > visibleWidth(right) + 1 ? status + ' '.repeat(room - visibleWidth(right)) + right : fitAnsi(status, cols);
  // Pad by cells, not string length: a wide character past the last column would scroll the screen.
  const text = fitAnsi(stripAnsi(bar), cols);
  return `\x1b[H${body.join('\r\n')}\r\n\x1b[7m${text}${' '.repeat(Math.max(0, cols - visibleWidth(text)))}\x1b[0m\x1b[K\r\n${keyMap(keys, cols)}`;
}

export type Input =
  | { kind: 'key'; key: string } // 'up' 'down' 'pageup' 'pagedown' 'home' 'end' 'enter' 'esc' 'backspace' 'ctrl-c' or a character
  | { kind: 'wheel'; delta: number };

// Legacy keys and SGR mouse reports (1006). Unknown escape sequences are dropped, not typed.
export function parseInput(data: string): Input[] {
  const out: Input[] = [];
  const named: Record<string, string> = {
    '\x1b[A': 'up', '\x1bOA': 'up', '\x1b[B': 'down', '\x1bOB': 'down', '\x1b[5~': 'pageup', '\x1b[6~': 'pagedown',
    '\x1b[H': 'home', '\x1bOH': 'home', '\x1b[1~': 'home', '\x1b[F': 'end', '\x1bOF': 'end', '\x1b[4~': 'end',
  };
  let i = 0;
  while (i < data.length) {
    const rest = data.slice(i);
    const mouse = /^\x1b\[<(\d+);\d+;\d+[Mm]/.exec(rest);
    if (mouse) {
      const b = Number(mouse[1]);
      if (b === 64 || b === 65) out.push({ kind: 'wheel', delta: b === 64 ? -1 : 1 });
      i += mouse[0].length; continue;
    }
    const key = Object.keys(named).find(k => rest.startsWith(k));
    if (key) { out.push({ kind: 'key', key: named[key]! }); i += key.length; continue; }
    const other = /^\x1b(\[[0-9;:?]*[ -/]*[@-~]|O.)/.exec(rest);
    if (other) { i += other[0].length; continue; }
    const ch = String.fromCodePoint(rest.codePointAt(0)!);
    i += ch.length;
    if (ch === '\x1b') out.push({ kind: 'key', key: 'esc' });
    else if (ch === '\r' || ch === '\n') out.push({ kind: 'key', key: 'enter' });
    else if (ch === '\x7f' || ch === '\b') out.push({ kind: 'key', key: 'backspace' });
    else if (ch === '\x03') out.push({ kind: 'key', key: 'ctrl-c' });
    else if (ch >= ' ') out.push({ kind: 'key', key: ch });
  }
  return out;
}
