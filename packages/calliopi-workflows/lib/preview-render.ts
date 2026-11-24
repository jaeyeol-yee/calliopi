// Display lines for the preview pane at a given width. bat (file) and delta (diff) are used when
// present; otherwise plain text is wrapped and colored here. Every returned line fits the width.
import { spawnSync } from 'node:child_process';

export interface Tools {
  /** bat ≥ 0.13.0: earlier releases ignore --wrap when output is piped. */
  bat: boolean;
  delta: boolean;
}

export function batVersionOk(versionOutput: string): boolean {
  const m = /bat (\d+)\.(\d+)\.(\d+)/.exec(versionOutput);
  return !!m && (Number(m[1]) > 0 || Number(m[2]) >= 13);
}

export function detectTools(): Tools {
  // Deterministic plain output (tests), independent of the user's bat/delta setup.
  if (process.env.CALLIOPI_PREVIEW_PLAIN === '1') return { bat: false, delta: false };
  const bat = spawnSync('bat', ['--version'], { encoding: 'utf8', timeout: 3000 });
  const delta = spawnSync('delta', ['--version'], { encoding: 'utf8', timeout: 3000 });
  return { bat: bat.status === 0 && batVersionOk(bat.stdout), delta: delta.status === 0 };
}

// Terminal cell width of one code point: East Asian wide/fullwidth take two.
const cellWidth = (ch: string) => /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6\u{1F300}-\u{1FAFF}\u{20000}-\u{3FFFD}]/u.test(ch) ? 2 : 1;
const ANSI = /\x1b\[[0-9;:?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/y;

export const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;:?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '');
export const visibleWidth = (s: string) => [...stripAnsi(s)].reduce((n, ch) => n + cellWidth(ch), 0);

/** Cut an ANSI-colored line to at most `width` cells, keeping escapes and resetting style at the end. */
export function fitAnsi(line: string, width: number): string {
  let out = '', cells = 0, i = 0, styled = false;
  while (i < line.length) {
    ANSI.lastIndex = i;
    const m = ANSI.exec(line);
    if (m) { out += m[0]; styled = true; i += m[0].length; continue; }
    const ch = String.fromCodePoint(line.codePointAt(i)!);
    const w = cellWidth(ch);
    if (cells + w > width) break;
    out += ch; cells += w; i += ch.length;
  }
  return styled ? `${out}\x1b[0m` : out;
}

// Plain text only (no escapes): tabs expanded, control characters dropped, wrapped by cells.
export function wrapPlain(text: string, width: number): string[] {
  const w = Math.max(1, width);
  return text.split('\n').flatMap(raw => {
    const line = raw.replace(/\t/g, '    ').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
    if (!line) return [''];
    const rows: string[] = [];
    let row = '', cells = 0;
    for (const ch of line) {
      const cw = cellWidth(ch);
      if (cells + cw > w) { rows.push(row); row = ''; cells = 0; }
      row += ch; cells += cw;
    }
    rows.push(row);
    return rows;
  });
}

const SGR = { add: '\x1b[32m', del: '\x1b[31m', hunk: '\x1b[36m', meta: '\x1b[1m', dim: '\x1b[2m', reset: '\x1b[0m' };

export function renderFile(absolute: string, width: number, tools: Tools, readText: () => string | null): string[] {
  if (tools.bat) {
    const r = spawnSync('bat', ['--color=always', '--decorations=always', '--style=numbers', '--paging=never', '--wrap=character', `--terminal-width=${width}`, '--', absolute], {
      encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 10_000,
    });
    if (r.status === 0 && typeof r.stdout === 'string') return r.stdout.replace(/\n$/, '').split('\n').map(l => fitAnsi(l, width));
  }
  const text = readText();
  if (text === null) return ['(바이너리이거나 1 MiB를 넘는 파일이라 표시하지 않습니다)'];
  const lines = text.replace(/\n$/, '').split('\n');
  const gutter = String(lines.length).length;
  return lines.flatMap((line, i) => wrapPlain(line, Math.max(1, width - gutter - 1)).map((row, j) =>
    `${SGR.dim}${(j ? '' : String(i + 1)).padStart(gutter)}${SGR.reset} ${row}`));
}

export function renderDiff(diff: string, width: number, tools: Tools): string[] {
  if (tools.delta) {
    const r = spawnSync('delta', ['--paging=never', `--width=${width}`], { input: diff, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 10_000 });
    if (r.status === 0 && typeof r.stdout === 'string' && r.stdout.trim()) return r.stdout.replace(/\n$/, '').split('\n').map(l => fitAnsi(l, width));
  }
  return diff.replace(/\n$/, '').split('\n').flatMap(line => {
    const color = line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ') ? SGR.meta
      : line.startsWith('+') ? SGR.add : line.startsWith('-') ? SGR.del : line.startsWith('@@') ? SGR.hunk : '';
    return wrapPlain(line, width).map(row => color ? `${color}${row}${SGR.reset}` : row);
  });
}
