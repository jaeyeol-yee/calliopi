import { test } from 'node:test';
import assert from 'node:assert/strict';
import { visibleWidth } from '@earendil-works/pi-tui';
import { DEFAULT_BUDGET, type AgentMeta, type AgentRecord } from '@calliopi/core/agents';
import { Fleet } from '#lib/fleet.ts';
import { AgentsView } from '#lib/viewer.ts';

const rec = (id: string, parent: string | null, createdAt: number, over: Partial<AgentRecord> = {}): AgentRecord => ({
  dir: `/r/${id}`,
  meta: { id, parent, createdAt, depth: parent ? 2 : 1, role: id.replace(/-\d+$/, ''), model: 'm/x', modelSource: 'inherit', session: `/r/${id}/s.jsonl`,
    call: { task: `task of ${id}`, done: 'checked', budget: DEFAULT_BUDGET, context: 'summary', background: true } } as AgentMeta,
  ...over,
});
const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

test('viewer: the tree on the left, the selected agent as a table on the right; moving, a screen, back', () => {
  let renders = 0, closed = false;
  const tui = { terminal: { columns: 100, rows: 30 }, requestRender: () => { renders++; } };
  const theme = { fg: (_c: string, s: string) => s };
  const records = [
    rec('scout-1', null, 1, { status: { state: 'running', activity: 'read', turns: 2, tokens: 10, startedAt: Date.now() - 5000, updatedAt: 0 } }),
    rec('verifier-1', 'scout-1', 2, { status: { state: 'running', turns: 0, tokens: 0, startedAt: Date.now(), updatedAt: 0, briefing: { at: 0, how: 'first' } } }),
    rec('reviewer-1', null, 3, { result: { status: 'done', summary: 'No blockers\nmore', evidence: 'npm test', usage: { turns: 3, tokens: 99, ms: 61_000 }, endedAt: 0 } }),
  ];
  const view = new AgentsView(tui, theme, new Fleet(), () => records, () => { closed = true; });
  let lines = view.render(100).map(plain);
  assert.ok(lines.every(l => visibleWidth(l) === 100), 'every line fills the width exactly');
  assert.match(lines[0]!, /^╭ 서브에이전트 · 실행 중 2 · 끝남 1 .*┬ scout-1 .*╮$/);
  assert.match(lines[1]!, /^│▸├─ ● scout-1 · read · 5초 · 턴 2 *│┌/);
  assert.match(lines[2]!, /^│ │  └─ ● verifier-1/);
  assert.match(lines[3]!, /^│ └─ ✓ reviewer-1 · 완료 · 1분 1초/);
  assert.ok(lines.some(l => /│ 상태 *│ ● 실행 중 · read/.test(l)));
  assert.ok(lines.some(l => /│ 과제 *│ task of scout-1/.test(l)));
  assert.ok(lines.some(l => /│ 예산 *│ 턴 2\/30/.test(l)));

  view.handleInput('\x1b[B'); view.handleInput('\x1b[B'); // down twice
  lines = view.render(100).map(plain);
  assert.match(lines[0]!, /┬ reviewer-1 /);
  assert.ok(lines.some(l => /│ 결과 *│ No blockers/.test(l)) && lines.some(l => /│ 근거 *│ npm test/.test(l)));
  // narrow: the details go under the list
  const narrow = view.render(60).map(plain);
  assert.ok(narrow.every(l => visibleWidth(l) === 60));
  assert.ok(!narrow[0]!.includes('┬') && narrow.some(l => /│ 결과 *│ No blockers/.test(l)));

  view.handleInput('\r'); // a screen; this Pi did not run it, so its record
  lines = view.render(100).map(plain);
  assert.match(lines[0]!, /✓ reviewer-1 · reviewer · 완료/);
  assert.ok(lines.some(l => /No blockers/.test(l)) && lines.some(l => /근거: npm test/.test(l)));
  assert.match(lines.at(-1)!, /Esc·ctrl\+\]: 목록/);
  view.handleInput('\x1b'); // nothing listens on an ended agent: Esc goes back too
  assert.equal(view.mode, 'list');
  view.handleInput('\r'); view.handleInput('\x1d'); // ctrl+]
  assert.equal(view.mode, 'list');
  view.handleInput('\x1b');
  assert.ok(closed && renders > 0);
});

test('viewer: long details scroll with J/K and PgUp/PgDn (and the wheel over them); a new selection starts at the top', () => {
  const tui = { terminal: { columns: 100, rows: 14 }, requestRender: () => {} };
  const theme = { fg: (_c: string, s: string) => s };
  const long = Array.from({ length: 30 }, (_, i) => `para ${i}`).join('\n');
  const records = [
    rec('reviewer-1', null, 1, { result: { status: 'done', summary: long, usage: { turns: 1, tokens: 1, ms: 1000 }, endedAt: 0 } }),
    rec('scout-1', null, 2),
  ];
  const view = new AgentsView(tui, theme, new Fleet(), () => records, () => {});
  const body = () => view.render(100).map(plain);
  let lines = body();
  assert.match(lines.at(-1)!, /PgUp\/PgDn·J\/K: 상세 1–\d+\/\d+/);
  assert.ok(lines.some(l => /│ 상태 /.test(l)));
  view.handleInput('J'); view.handleInput('J');
  lines = body();
  assert.match(lines.at(-1)!, /상세 3–/);
  assert.ok(!lines.some(l => /│ 상태 /.test(l)), 'the first rows scrolled out');
  for (let i = 0; i < 20; i++) view.handleInput('\x1b[6~'); // PgDn, past the end
  lines = body();
  assert.ok(lines.some(l => /│ 세션 /.test(l)), 'scrolled to the end, clamped');
  view.handleInput('K');
  view.handleMouse({ type: 'wheel', button: 'none', x: 80, y: 3, screenX: 80, screenY: 3, width: 100, height: 14, shift: false, alt: false, ctrl: false, wheelDelta: -100 });
  assert.match(body().at(-1)!, /상세 1–/);
  view.handleInput('J');
  view.handleMouse({ type: 'wheel', button: 'none', x: 5, y: 3, screenX: 5, screenY: 3, width: 100, height: 14, shift: false, alt: false, ctrl: false, wheelDelta: 1 });
  lines = body();
  assert.match(lines[0]!, /┬ scout-1 /, 'the wheel over the list moves the selection');
  assert.match(lines.at(-1)!, /상세 1–|접기 · x:/, 'a new selection starts at the top of its details');
});

test('viewer: a Kitty key release is not a second scroll', () => {
  const tui = { terminal: { columns: 100, rows: 14 }, requestRender: () => {} };
  const long = Array.from({ length: 30 }, (_, i) => `para ${i}`).join('\n');
  const records = [rec('reviewer-1', null, 1, { result: { status: 'done', summary: long, usage: { turns: 1, tokens: 1, ms: 1000 }, endedAt: 0 } })];
  const view = new AgentsView(tui, { fg: (_c: string, s: string) => s }, new Fleet(), () => records, () => {});
  view.render(100);
  view.handleInput('K'); view.handleInput('\x1b[75;2:3u'); // K pressed, its Kitty release
  assert.match(view.render(100).map(plain).at(-1)!, /상세 1–/, 'K moved up from the top: nothing; the release did nothing either');
  view.handleInput('J'); view.handleInput('\x1b[74;2:3u'); view.handleInput('\x1b[6;2:3~'); // J, its release, a Shift+PgDn release
  assert.match(view.render(100).map(plain).at(-1)!, /상세 2–/);
});
