import { test } from 'node:test';
import assert from 'node:assert/strict';
import { visibleWidth } from '@earendil-works/pi-tui';
import { DEFAULT_BUDGET, type AgentMeta, type AgentRecord } from '@calliopi/core/agents';
import { Fleet } from '#lib/fleet.ts';
import { AgentsView } from '#lib/viewer.ts';

const rec = (id: string, parent: string | null, createdAt: number, over: Partial<AgentRecord> = {}): AgentRecord => ({
  dir: `/r/${id}`,
  meta: { id, parent, createdAt, role: id.replace(/-\d+$/, ''), model: 'm/x', modelSource: 'inherit', session: `/r/${id}/s.jsonl`,
    call: { task: `task of ${id}`, done: 'checked', budget: DEFAULT_BUDGET, context: 'summary', background: true } } as AgentMeta,
  ...over,
});
const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

test('viewer: the tree with states, details of the selected one, moving and switching to a screen', () => {
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
  assert.match(lines[0]!, /서브에이전트 · 실행 중 2 · 끝남 1/);
  assert.match(lines[1]!, /▸├─ ● scout-1 · read · 5초 · 턴 2 · scout/);
  assert.match(lines[2]!, / │  └─ ○ verifier-1|│  └─ ● verifier-1/);
  assert.match(lines[3]!, / └─ ✓ reviewer-1 · 완료 · 1분 1초 · reviewer/);
  assert.ok(lines.some(l => /과제   task of scout-1/.test(l)));

  view.handleInput('\x1b[B'); view.handleInput('\x1b[B'); // down twice
  lines = view.render(100).map(plain);
  assert.ok(lines.some(l => /결과   완료 · No blockers/.test(l)));
  view.handleInput('\r'); // a screen; this Pi did not run it, so its record
  lines = view.render(100).map(plain);
  assert.match(lines[0]!, /✓ reviewer-1 · reviewer · 완료/);
  assert.ok(lines.some(l => /No blockers/.test(l)) && lines.some(l => /근거: npm test/.test(l)));
  assert.match(lines.at(-1)!, /ctrl\+\]: 목록/);
  view.handleInput('\x1d'); // ctrl+]
  assert.equal(view.mode, 'list');
  view.handleInput('\x1b');
  assert.ok(closed && renders > 0);
});
