import test from 'node:test';
import assert from 'node:assert/strict';
import { visibleWidth } from '@earendil-works/pi-tui';
import type { UsageSnapshot } from '@calliopi/core/usage';
import { bar, formatRemaining, formatResetAt, formatValue, level, paceFraction, renderGauges } from '#lib/gauge.ts';

const NOW = Date.UTC(2026, 10, 25, 12);
const H = 3_600_000;

test('bar: filled share, empty rest, pace mark on top; clamped', () => {
  assert.equal(bar(0.5, 10, undefined), '█████░░░░░');
  assert.equal(bar(0.2, 10, 0.5), '██░░░│░░░░');
  assert.equal(bar(1.4, 4, undefined), '████');
  assert.equal(bar(0, 4, 1), '░░░│', 'a pace at the end stays inside');
});

test('levels, pace, remaining time and values', () => {
  assert.deepEqual([level(0.2), level(0.7), level(0.95)], ['ok', 'warn', 'high']);
  assert.equal(paceFraction({ resetsAt: NOW + H, periodMs: 5 * H }, NOW), 0.8);
  assert.equal(paceFraction({ resetsAt: NOW + H }, NOW), undefined);
  assert.deepEqual([formatRemaining(30_000), formatRemaining(12 * 60_000), formatRemaining(4 * H + 59 * 60_000), formatRemaining(4 * 24 * H + 18 * H)],
    ['곧', '12분', '4시간 59분', '4일 18시간']);
  assert.equal(formatValue({ label: '', used: 3.6, limit: 100, unit: 'percent' }), '4%');
  assert.equal(formatValue({ label: '', used: 1.2, limit: 5, unit: 'usd' }), '$1.20 / $5.00');
  assert.equal(formatValue({ label: '', used: 120, unit: 'credits' }), '120 크레딧');
});

const SNAPSHOTS: UsageSnapshot[] = [
  { id: 'claude', label: 'Claude', plan: 'Max 20x', source: 'Pi 로그인', fetchedAt: NOW,
    metrics: [{ label: '주간', used: 40, limit: 100, unit: 'percent', resetsAt: NOW + 3.5 * 24 * H, periodMs: 7 * 24 * H }] },
  { id: 'codex', label: 'Codex', fetchedAt: NOW, metrics: [], error: 'Codex 로그인이 만료되었습니다.' },
  { id: 'cursor', label: 'Cursor', fetchedAt: NOW, metrics: [
    { label: '추가 사용', used: 1.2, limit: 5, unit: 'usd' },
    { label: '크레딧', used: 120, unit: 'credits' },
  ] },
];

test('renderGauges: one box per provider, name and plan in the top edge, source on its right', () => {
  const lines = renderGauges(SNAPSHOTS, 80, NOW);
  for (const line of lines) assert.equal(visibleWidth(line), 80, line);
  assert.match(lines[0]!, /^╭─ Claude · Max 20x ─+ Pi 로그인 ─╮$/);
  const moment = formatResetAt(NOW + 3.5 * 24 * H);
  assert.match(lines[1]!, /^│ 주간 +█+░*│░+ +40% {2}↻ 3일 12시간 · /, 'pace mark at half the week, past the 40% fill');
  assert.ok(lines[1]!.includes(`↻ 3일 12시간 · ${moment}`), lines[1]);
  assert.match(lines[2]!, /^╰─+╯$/);
  assert.match(lines[3]!, /^╭─ Codex ─+╮$/, 'no plan, no source');
  assert.match(lines[4]!, /^│ ! Codex 로그인이 만료되었습니다\. +│$/);
  assert.match(lines[7]!, /^│ 추가 사용 +█+░+ +\$1\.20 \/ \$5\.00 +│$/);
  assert.match(lines[8]!, /^│ 크레딧 +120 크레딧 +│$/, 'no bar without a limit');
  assert.equal(lines.length, 10);
  // Bars line up across boxes (Korean labels are two cells wide).
  const barColumn = (line: string) => visibleWidth(line.slice(0, line.indexOf('█')));
  assert.equal(barColumn(lines[1]!), barColumn(lines[7]!));
});

test('renderGauges drops the reset moment, then the countdown, before the bar gets too short', () => {
  const at = (width: number) => renderGauges(SNAPSHOTS.slice(0, 1), width, NOW)[1]!;
  assert.match(at(76), /↻ 3일 12시간 · /);
  assert.match(at(48), /↻ 3일 12시간 +│$/);
  assert.doesNotMatch(at(34), /↻/);
  for (const w of [76, 48, 34]) assert.equal(visibleWidth(at(w)), w);
  assert.doesNotMatch(renderGauges(SNAPSHOTS.slice(0, 1), 30, NOW)[0]!, /Pi 로그인/, 'the source goes from a narrow top edge');
});

test('formatResetAt: local month/day and 24-hour time', () => {
  const d = new Date(2026, 10, 30, 9, 5);
  assert.equal(formatResetAt(d.getTime()), '11/30 09:05');
});
