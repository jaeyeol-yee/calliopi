import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { visibleWidth } from '@earendil-works/pi-tui';
import { DEFAULT_BUDGET, FILES, createAgent, listGoals, saveGoal, writeResult, type AgentMeta, type AgentRecord, type Goal } from '@calliopi/core/agents';
import { Fleet } from '#lib/fleet.ts';
import { collect, retention, CONFIG_FILE } from '#lib/gc.ts';
import { CONTINUE_MESSAGE, MAX_CONTINUATIONS, NO_PROGRESS_LIMIT, goalReminder, installGoals } from '#lib/goals.ts';
import { goalExport } from '#lib/export.ts';
import { AgentsView, listItems } from '#lib/viewer.ts';

const tmp = (t: { after: (fn: () => void) => void }) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'calliopi-goals-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');
const agentMeta = (cwd: string, goal: string | null, over: Partial<AgentMeta> = {}) => ({
  root: 'sess-1', parent: null, goal, depth: 1, role: 'scout', model: 'm/x', modelSource: 'inherit' as const, tools: ['read'], cwd, createdAt: Date.now(),
  call: { task: 'Look', budget: DEFAULT_BUDGET, context: 'none' as const, background: true }, pane: null, ...over,
});

/** A Pi stand-in: handlers, tools and commands by name, and what was sent. */
function fakePi() {
  const handlers = new Map<string, (event: unknown, ctx?: unknown) => unknown>();
  const tools = new Map<string, { execute: (...a: unknown[]) => Promise<{ content: { text: string }[]; isError?: boolean }> }>();
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
  const sent: { content: string; options?: { deliverAs?: string; triggerTurn?: boolean } }[] = [];
  const entries: unknown[] = [];
  const statuses: (string | undefined)[] = [];
  const notices: string[] = [];
  let pending = false;
  const ctx = {
    sessionManager: { getSessionId: () => 'sess-1' }, hasPendingMessages: () => pending,
    ui: { setStatus: (_k: string, v: string | undefined) => statuses.push(v), notify: (m: string) => notices.push(m) },
  };
  const pi = {
    on: (n: string, fn: (e: unknown, c?: unknown) => unknown) => handlers.set(n, fn),
    registerTool: (t: { name: string }) => tools.set(t.name, t as never),
    registerCommand: (n: string, c: never) => commands.set(n, c),
    sendMessage: (m: { content: string }, options?: { deliverAs?: string; triggerTurn?: boolean }) => sent.push({ content: m.content, options }),
    appendEntry: (_t: string, d: unknown) => entries.push(d),
  };
  const run = (opts: { tools?: number; stop?: string } = {}) => {
    handlers.get('agent_start')!({});
    for (let i = 0; i < (opts.tools ?? 1); i++) handlers.get('tool_execution_start')!({ toolName: 'read' });
    handlers.get('message_end')!({ message: { role: 'assistant', usage: { input: 10, output: 5 } } });
    handlers.get('turn_end')!({});
    handlers.get('agent_end')!({ messages: [{ role: 'assistant', stopReason: opts.stop ?? 'stop' }] }, ctx);
  };
  return { pi, ctx, handlers, tools, commands, sent, entries, statuses, notices, run, setPending: (v: boolean) => { pending = v; } };
}

test('goal: one open at a time, a reminder on every request, carry-on after each run with its safeguards', async t => {
  const root = tmp(t);
  const fleet = new Fleet();
  let collected = 0;
  const f = fakePi();
  const goals = installGoals(f.pi as never, { root: () => root, fleet, collect: () => { collected++; } });
  f.handlers.get('session_start')!({}, f.ctx);
  assert.equal(goals.linkId(), null);

  const made = await f.tools.get('goal_create')!.execute('id', { objective: 'Ship login retries', done: 'tests pass' }, undefined, undefined, f.ctx);
  assert.match(made.content[0]!.text, /^Goal g-.* is active/);
  const id = goals.linkId()!;
  assert.equal(listGoals(root, 'sess-1')[0]!.status, 'active');
  assert.equal(collected, 1); // aged records go when a goal starts
  assert.match(f.statuses.at(-1)!, /◆ Ship login retries · 진행 중/);
  const again = await f.tools.get('goal_create')!.execute('id', { objective: 'Other' }, undefined, undefined, f.ctx);
  assert.ok(again.isError && /이미 열린 goal/.test(again.content[0]!.text));

  // the goal at the end of each request, not stored
  const out = f.handlers.get('context')!({ messages: [{ role: 'user', content: 'x' }] }) as { messages: { content: { text: string }[] }[] };
  assert.equal(out.messages.at(-1)!.content[0]!.text, goalReminder(listGoals(root, 'sess-1')[0]!));

  // a run that did something: carry on, as a follow-up that starts a turn
  f.run();
  assert.equal(f.sent.length, 1);
  assert.match(f.sent[0]!.content, /^Continue working toward the active goal: Ship login retries\nDone when: tests pass/);
  assert.deepEqual(f.sent[0]!.options, { deliverAs: 'followUp', triggerTurn: true });
  assert.deepEqual(listGoals(root, 'sess-1')[0]!.usage, { turns: 1, tokens: 15 });

  // the user said something meanwhile: that comes first
  f.setPending(true); f.run(); f.setPending(false);
  assert.equal(f.sent.length, 1);
  // its subagent is still at work: its result will wake the session
  const linked = createAgent(root, agentMeta(root, id));
  f.run();
  assert.equal(f.sent.length, 1);
  writeResult(linked.dir, { status: 'done', summary: 'found it', usage: { turns: 1, tokens: 100, ms: 1 }, endedAt: Date.now() });
  // runs without a tool call, several in a row: pause
  for (let i = 0; i < NO_PROGRESS_LIMIT; i++) f.run({ tools: 0 });
  assert.equal(listGoals(root, 'sess-1')[0]!.status, 'paused');
  assert.match(listGoals(root, 'sess-1')[0]!.pausedBecause!, /아무 작업 없이/);
  assert.match(f.notices.at(-1)!, /goal 일시 중지/);

  // resumed by the user: carries on at once
  await f.commands.get('cl-goal')!.handler('resume', f.ctx);
  assert.equal(listGoals(root, 'sess-1')[0]!.status, 'active');
  assert.equal(f.sent.at(-1)!.options?.triggerTurn, true);
  // the user interrupting pauses it
  f.run({ stop: 'aborted' });
  assert.match(listGoals(root, 'sess-1')[0]!.pausedBecause!, /사용자가 중단/);
  await f.commands.get('cl-goal')!.handler('resume', f.ctx);

  // the carry-on limit
  const g = listGoals(root, 'sess-1')[0]!;
  saveGoal(root, { ...g, continuations: MAX_CONTINUATIONS });
  f.handlers.get('session_start')!({}, f.ctx); // reload from disk
  f.run();
  assert.match(listGoals(root, 'sess-1')[0]!.pausedBecause!, /20번/);

  // done: closed with what its subagents reported; no more reminders or carry-ons
  await f.commands.get('cl-goal')!.handler('resume', f.ctx);
  const done = await f.tools.get('goal_update')!.execute('id', { status: 'done', outcome: 'tests pass' }, undefined, undefined, f.ctx);
  assert.match(done.content[0]!.text, /^Goal done\. tests pass\n서브에이전트 1개:\n- scout-1 \(scout\): 완료 — found it$/);
  assert.equal(goals.linkId(), null);
  assert.equal(f.handlers.get('context')!({ messages: [] }), undefined);
  const before = f.sent.length;
  f.run();
  assert.equal(f.sent.length, before);
  assert.equal(f.statuses.at(-1), undefined); // the footer line is gone
  assert.ok(f.entries.length >= 5, 'every change is in the session');
});

test('closing a goal stops its running subagents and frees their screens', async t => {
  const root = tmp(t);
  const stopped: string[] = [], released: string[][] = [];
  const fleet = { stop: (id: string) => stopped.push(id), release: (ids: string[]) => released.push(ids) } as unknown as Fleet;
  const f = fakePi();
  const goals = installGoals(f.pi as never, { root: () => root, fleet, collect: () => {} });
  f.handlers.get('session_start')!({}, f.ctx);
  await f.commands.get('cl-goal')!.handler('Find the bug --done the failing test passes', f.ctx);
  const g = listGoals(root, 'sess-1')[0]!;
  assert.deepEqual([g.objective, g.done], ['Find the bug', 'the failing test passes']);
  assert.match(f.sent.at(-1)!.content, /^Continue working toward the active goal: Find the bug/); // it starts at once
  const running = createAgent(root, agentMeta(root, goals.linkId()));
  const ended = createAgent(root, agentMeta(root, goals.linkId()));
  writeResult(ended.dir, { status: 'done', summary: 'ok', usage: { turns: 0, tokens: 0, ms: 0 }, endedAt: 0 });
  createAgent(root, agentMeta(root, null)); // not the goal's
  await f.commands.get('cl-goal')!.handler('abandon not needed', f.ctx);
  assert.deepEqual(stopped, [running.meta.id]);
  assert.deepEqual(released, [[running.meta.id, ended.meta.id]]);
  const closed = listGoals(root, 'sess-1')[0]!;
  assert.equal(closed.status, 'abandoned');
  assert.match(closed.outcome!, /^not needed\n서브에이전트 2개:/);
});

test('gc: request logs, then records, then empty goals and trees go; exports and open work stay', t => {
  const root = tmp(t), agentDir = tmp(t);
  assert.deepEqual(retention(agentDir), { requestsDays: 3, recordsDays: 14 });
  fs.writeFileSync(path.join(agentDir, CONFIG_FILE), JSON.stringify({ retention: { requestsDays: 1, recordsDays: -2 } }));
  assert.deepEqual(retention(agentDir), { requestsDays: 1, recordsDays: 14 }); // nonsense ignored
  const day = 24 * 60 * 60 * 1000, now = 50 * day;
  const goal = (id: string, status: Goal['status'], closedAt?: number): Goal => ({ id, session: 'sess-1', objective: id, status, continuations: 0, usage: { turns: 0, tokens: 0 }, createdAt: 0, updatedAt: 0, closedAt });
  saveGoal(root, goal('g-old', 'done', now - 20 * day));
  saveGoal(root, goal('g-open', 'active'));
  const old = createAgent(root, agentMeta(root, 'g-old'));
  const open = createAgent(root, agentMeta(root, 'g-open'));
  const loose = createAgent(root, agentMeta(root, null));
  for (const r of [old, open, loose]) {
    writeResult(r.dir, { status: 'done', summary: '', usage: { turns: 0, tokens: 0, ms: 0 }, endedAt: now - 5 * day });
    fs.writeFileSync(path.join(r.dir, FILES.requests), '{}\n');
  }
  fs.mkdirSync(path.join(root, 'exports')); fs.writeFileSync(path.join(root, 'exports', 'x.json'), '{}');
  assert.deepEqual(collect(root, { requestsDays: 3, recordsDays: 14 }, now), { requests: 1, records: 1, goals: 1 });
  assert.equal(fs.existsSync(old.dir), false); // its goal closed 20 days ago
  assert.equal(fs.existsSync(path.join(loose.dir, FILES.requests)), false); // no goal, ended 5 days ago: requests only
  assert.ok(fs.existsSync(path.join(open.dir, FILES.requests))); // its goal is open
  assert.deepEqual(listGoals(root, 'sess-1').map(g => g.id), ['g-open']); // the old goal had nothing left
  assert.ok(fs.existsSync(path.join(root, 'exports', 'x.json')));
});

test('viewer: agents grouped by goal, the open one first, closed ones folded; a goal row shows the goal and exports it', () => {
  const now = Date.now();
  const goals: Goal[] = [
    { id: 'g-a', session: 's', objective: 'Old work', status: 'done', continuations: 2, usage: { turns: 3, tokens: 40 }, createdAt: 1, updatedAt: 2, closedAt: 2, outcome: 'merged' },
    { id: 'g-b', session: 's', objective: 'Ship retries', done: 'tests pass', status: 'active', progress: 'half', continuations: 1, usage: { turns: 2, tokens: 10 }, createdAt: 3, updatedAt: 3 },
  ];
  const rec = (id: string, goal: string | null, done: boolean): AgentRecord => ({ dir: `/r/${id}`,
    meta: { id, goal, parent: null, createdAt: now, depth: 1, role: 'scout', model: 'm', modelSource: 'inherit', session: '', call: { task: 't', budget: DEFAULT_BUDGET, context: 'none', background: true } } as AgentMeta,
    status: { state: 'running', turns: 1, tokens: 5, startedAt: now, updatedAt: now },
    result: done ? { status: 'done', summary: 's', usage: { turns: 1, tokens: 7, ms: 1000 }, endedAt: now } : undefined });
  const records = [rec('scout-1', 'g-a', true), rec('scout-2', 'g-b', false), rec('scout-3', null, true)];
  const kinds = (items: ReturnType<typeof listItems>) => items.map(i => i.kind === 'goal' ? `goal:${i.goal?.id ?? '-'}` : `  ${i.record.meta.id}`);
  assert.deepEqual(kinds(listItems(records, goals, (_k, closed) => closed)), ['goal:g-b', '  scout-2', 'goal:g-a', 'goal:-', '  scout-3']);
  assert.deepEqual(kinds(listItems(records, [], () => false)), ['  scout-1', '  scout-2', '  scout-3']); // no goals: the plain tree

  const exported: (string | null)[] = [];
  const view = new AgentsView({ terminal: { columns: 110, rows: 30 }, requestRender: () => {} }, { fg: (_c, s) => s }, new Fleet(), () => records, () => {}, () => goals,
    g => { exported.push(g?.id ?? null); return '/x/out.json'; });
  let lines = view.render(110).map(plain);
  assert.ok(lines.every(l => visibleWidth(l) === 110));
  assert.match(lines[0]!, /^╭ 서브에이전트 · 실행 중 1 · 끝남 2 .*┬ goal g-b /);
  assert.match(lines[1]!, /▸▾ ▶ Ship retries · 진행 중 \(1 · 실행 1\)/);
  assert.match(lines[3]!, /▸ ✓ Old work · 완료 \(1\)/); // folded
  assert.ok(lines.some(l => /│ 목표 *│ Ship retries/.test(l)) && lines.some(l => /│ 진척 *│ half/.test(l)) && lines.some(l => /│ 사용 *│ 턴 2 · 토큰 15/.test(l)));
  view.handleInput('\x1b[B'); view.handleInput('\x1b[B'); view.handleInput('\r'); // unfold the closed goal
  lines = view.render(110).map(plain);
  assert.ok(lines.some(l => /└─ ✓ scout-1/.test(l)));
  assert.ok(lines.some(l => /│ 결과 *│ merged/.test(l)));
  view.handleInput('e');
  assert.deepEqual(exported, ['g-a']);
  assert.match(view.render(110).map(plain).at(-1)!, /내보냄: \/x\/out\.json/);
});

test('export: the goal, its delegation summaries and its agents as a tree with their compactions', t => {
  const root = tmp(t);
  const parent = createAgent(root, agentMeta(root, 'g-1'));
  const child = createAgent(root, agentMeta(root, 'g-1', { parent: parent.meta.id, depth: 2, createdAt: Date.now() + 1 }));
  createAgent(root, agentMeta(root, 'g-other'));
  fs.writeFileSync(path.join(child.dir, `2026_${child.meta.id}.jsonl`), [{ type: 'session' }, { type: 'compaction', id: 'c1', summary: '## Goal\nX', tokensBefore: 9, firstKeptEntryId: 'k' }].map(l => JSON.stringify(l)).join('\n'));
  const session = path.join(root, 'top.jsonl');
  fs.writeFileSync(session, [{ type: 'custom', customType: 'calliopi-summary', timestamp: 't1', data: { summary: 'S1', agents: [parent.meta.id] } }, { type: 'custom', customType: 'calliopi-summary', data: { summary: 'S2', agents: ['nope'] } }].map(l => JSON.stringify(l)).join('\n'));
  const goal = { id: 'g-1', objective: 'O' } as Goal;
  const out = goalExport(goal, [parent, child].concat(createAgent(root, agentMeta(root, 'g-2'))), { parentSession: session }) as unknown as { goal: Goal; summaries: { summary: string }[]; agents: { id: string; children: { id: string; compactions: { summary: string }[] }[] }[] };
  assert.equal(out.goal.id, 'g-1');
  assert.deepEqual(out.summaries.map(s => s.summary), ['S1']);
  assert.deepEqual(out.agents.map(a => a.id), [parent.meta.id]);
  assert.equal(out.agents[0]!.children[0]!.id, child.meta.id);
  assert.equal(out.agents[0]!.children[0]!.compactions[0]!.summary, '## Goal\nX');
});
