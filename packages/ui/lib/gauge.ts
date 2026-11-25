// Usage gauges: one bar per metric, grouped by provider, with an even-pace mark and the time to reset.
//
//   ╭─ Claude · Max 20x ────────────────────────────────────── Pi 로그인 ─╮
//   │ 주간         █░░░░░░░░░░│░░░░░░░░░░░░      4%  ↻ 4일 17시간 · 11/30 11:00 │
//   │ 주간 Fable   ░░░░░░░░░░░│░░░░░░░░░░░░      0%  ↻ 4일 17시간 · 11/30 11:00 │
//   ╰────────────────────────────────────────────────────────────────────╯
//   ╭─ Cursor · Ultra (통합) ───────────────────────────────── Cursor 앱 ─╮
//   │ └ Grok Bot   ░│░░░░░░░░░░░░░░░ $7.02 / $553.95  ↻ 6일 21시간 · 12/2 15:18 │
//   ╰────────────────────────────────────────────────────────────────────╯
//
// The pace mark (│) is where usage would be if spread evenly over the window: a fill past it means
// the window is being used faster than it refills.
import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
import type { UsageMetric, UsageSnapshot } from '@calliopi/core/usage';

export type Level = 'ok' | 'warn' | 'high';

export interface GaugePaint {
  title(s: string): string;
  border(s: string): string;
  dim(s: string): string;
  error(s: string): string;
  fill(s: string, level: Level): string;
  empty(s: string): string;
  pace(s: string): string;
}

export const PLAIN_GAUGE: GaugePaint = { title: (s) => s, border: (s) => s, dim: (s) => s, error: (s) => s, fill: (s) => s, empty: (s) => s, pace: (s) => s };

const FILL = '█';
const EMPTY = '░';
const PACE = '│';
const MIN_BAR = 8;

export const level = (fraction: number): Level => (fraction >= 0.9 ? 'high' : fraction >= 0.7 ? 'warn' : 'ok');

/** Share of the window already elapsed, 0–1, or undefined when the window is unknown. */
export function paceFraction(metric: Pick<UsageMetric, 'resetsAt' | 'periodMs'>, now: number): number | undefined {
  if (!metric.resetsAt || !metric.periodMs) return undefined;
  const elapsed = metric.periodMs - (metric.resetsAt - now);
  return Math.min(1, Math.max(0, elapsed / metric.periodMs));
}

/** "4일 18시간", "4시간 59분", "12분", "곧". */
export function formatRemaining(ms: number): string {
  if (ms <= 60_000) return '곧';
  const minutes = Math.floor(ms / 60_000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  if (days) return hours ? `${days}일 ${hours}시간` : `${days}일`;
  if (hours) return `${hours}시간 ${minutes % 60}분`;
  return `${minutes}분`;
}

/** The reset moment in local time: "11/30 11:00". */
export function formatResetAt(at: number): string {
  const d = new Date(at);
  const two = (n: number) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()} ${two(d.getHours())}:${two(d.getMinutes())}`;
}

const money = (n: number) => `$${n.toFixed(2)}`;

/** Percent with one decimal below 10, so small usage still moves: "0%", "1.7%", "42%". */
export function formatPercent(used: number): string {
  if (used <= 0) return '0%';
  return used < 10 ? `${Number(used.toFixed(1))}%` : `${Math.round(used)}%`;
}

/** The value column: "4%", "$1.20 / $5.00", "120 크레딧". */
export function formatValue(m: UsageMetric): string {
  if (m.unit === 'percent') return formatPercent(m.used);
  if (m.unit === 'usd') return m.limit ? `${money(m.used)} / ${money(m.limit)}` : money(m.used);
  return m.limit ? `${m.used} / ${m.limit} 크레딧` : `${m.used} 크레딧`;
}

/** A bar `width` cells wide, filled to `fraction`, with the pace mark at `pace`. */
export function bar(fraction: number, width: number, pace: number | undefined, paint: GaugePaint = PLAIN_GAUGE): string {
  const filled = Math.round(Math.min(1, Math.max(0, fraction)) * width);
  const mark = pace === undefined ? -1 : Math.min(width - 1, Math.round(pace * width));
  let out = '';
  for (let i = 0; i < width; i++) {
    if (i === mark) out += paint.pace(PACE);
    else out += i < filled ? paint.fill(FILL, level(fraction)) : paint.empty(EMPTY);
  }
  return out;
}

const pad = (s: string, w: number) => s + ' '.repeat(Math.max(0, w - visibleWidth(s)));
const padStart = (s: string, w: number) => ' '.repeat(Math.max(0, w - visibleWidth(s))) + s;

/**
 * Lines for every provider, each at most `width` cells. Each provider sits in its own box, with the
 * name and plan in the top edge and the credential source on its right:
 *
 *   ╭─ Claude · Max 20x ──────────────────────────────── Pi 로그인 ─╮
 *   │ 주간         █░░░░░░│░░░░░░░░░░   4%  ↻ 4일 17시간 · 11/30 11:00 │
 *   ╰───────────────────────────────────────────────────────────────╯
 *
 * Columns line up across boxes.
 */
export function renderGauges(snapshots: readonly UsageSnapshot[], width: number, now: number, paint: GaugePaint = PLAIN_GAUGE): string[] {
  const inner = Math.max(MIN_BAR + 10, width - 4); // "│ " + row + " │"
  const metrics = snapshots.flatMap((s) => s.metrics);
  const labelW = Math.max(6, ...metrics.map((m) => visibleWidth(m.label)));
  const valueW = Math.max(4, ...metrics.map((m) => visibleWidth(formatValue(m))));
  // Reset column: countdown and moment ("↻ 4일 17시간 · 11/30 11:00"); the moment goes first, then the
  // whole column, before the bar gets too short to read.
  const full = metrics.map((m) => (m.resetsAt ? `↻ ${formatRemaining(m.resetsAt - now)} · ${formatResetAt(m.resetsAt)}` : ''));
  const short = metrics.map((m) => (m.resetsAt ? `↻ ${formatRemaining(m.resetsAt - now)}` : ''));
  const fixed = labelW + 1 + 1 + valueW;
  const fits = (texts: string[]) => {
    const w = Math.max(0, ...texts.map(visibleWidth));
    return w > 0 && inner - fixed - 2 - w >= MIN_BAR ? w : undefined;
  };
  const fullW = fits(full);
  const shortW = fullW === undefined ? fits(short) : undefined;
  const resetMode: 'full' | 'short' | 'none' = fullW !== undefined ? 'full' : shortW !== undefined ? 'short' : 'none';
  const resetW = fullW ?? shortW ?? 0;
  const barW = Math.max(MIN_BAR, inner - fixed - (resetMode === 'none' ? 0 : 2 + resetW));
  const resetText = (m: UsageMetric) => (!m.resetsAt || resetMode === 'none' ? ''
    : `↻ ${formatRemaining(m.resetsAt - now)}${resetMode === 'full' ? ` · ${formatResetAt(m.resetsAt)}` : ''}`);

  const row = (text: string) => {
    const fitted = truncateToWidth(text, inner);
    return `${paint.border('│')} ${fitted}${' '.repeat(Math.max(0, inner - visibleWidth(fitted)))} ${paint.border('│')}`;
  };
  const top = (s: UsageSnapshot) => {
    const title = ` ${paint.title(s.label)}${s.plan ? paint.dim(` · ${s.plan}`) : ''} `;
    let source = s.source ? ` ${paint.dim(s.source)} ` : '';
    // Edges: "╭─" + title + fill + source + "─╮"; the source goes when there is no room for it.
    if (visibleWidth(title) + visibleWidth(source) + 4 > width) source = '';
    const fill = Math.max(0, width - 4 - visibleWidth(title) - visibleWidth(source));
    return truncateToWidth(paint.border('╭─') + title + paint.border('─'.repeat(fill)) + source + paint.border('─╮'), width);
  };
  const bottom = paint.border(`╰${'─'.repeat(Math.max(0, width - 2))}╯`);

  const lines: string[] = [];
  for (const s of snapshots) {
    lines.push(top(s));
    if (s.error) lines.push(row(paint.error(`! ${s.error}`)));
    else if (!s.metrics.length) lines.push(row(paint.dim('표시할 한도가 없습니다')));
    for (const m of s.metrics) {
      const reset = resetText(m);
      const fraction = m.limit ? m.used / m.limit : undefined;
      const gauge = fraction === undefined ? ' '.repeat(barW) : bar(fraction, barW, paceFraction(m, now), paint);
      lines.push(row(`${pad(m.label, labelW)} ${gauge} ${padStart(formatValue(m), valueW)}${reset ? `  ${paint.dim(reset)}` : ''}`));
    }
    lines.push(bottom);
  }
  return lines;
}
