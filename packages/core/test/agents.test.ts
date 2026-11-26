import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_BUDGET, budgetFor, buildTree, classifyEnd, createAgent, decodeRequests, delegates, encodeRequest, exceeded, formatBudget,
  listAgents, markDelivered, treeDir, mayDelegate, mergeCatalog, nearLimit, parseRole, postInbox, readAgent, readDelivered, readInbox, remaining,
  resolveModel, resolveTools, descendantTokens, DEFAULT_RETENTION, goalAgentTokens, goalOverBudget, goalsDir, listGoals, moveGoal, newGoalId, openGoal, planPrune, saveGoal, staleGoals, resultForParent, roleGuidelines, setPane, stateOf, treeCounts, treeRows, writeResult, writeStatus,
  type AgentMeta, type AgentRole, type FullBudget, type Goal,
} from '#lib/agents/index.ts';

const role = (over: Partial<AgentRole> = {}): AgentRole => ({
  name: 'reviewer', description: 'Reviews a change', disallowedTools: [], modelLocked: false, allowedSubagents: [],
  approval: 'none', budget: {}, context: 'summary', instructions: '', source: 'reviewer.md', ...over,
});
const usage = (turns = 0, minutes = 0, tokens = 0, idleMinutes = 0) => ({ turns, ms: minutes * 60_000, tokens, idleMs: idleMinutes * 60_000 });
const tmp = (t: { after: (fn: () => void) => void }) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'calliopi-agents-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

test('budget: call over role over default, capped, and never more than the parent has left', () => {
  assert.deepEqual(budgetFor(undefined, undefined).budget, DEFAULT_BUDGET);
  assert.deepEqual(budgetFor({ turns: 10 }, { turns: 20, minutes: 5 }).budget, { ...DEFAULT_BUDGET, turns: 10, minutes: 5 });
  assert.equal(budgetFor({ turns: 10_000 }, undefined).budget.turns, 200); // MAX_BUDGET
  assert.equal(budgetFor({ turns: -3, tokens: Number.NaN }, undefined).budget.turns, DEFAULT_BUDGET.turns); // nonsense ignored
  // a child of a child: what the parent has left bounds it, like f(n-1)
  const parent: FullBudget = { turns: 30, minutes: 10, tokens: 100_000, idleMinutes: 5 };
  const left = remaining(parent, usage(25, 4, 90_000, 3));
  assert.deepEqual(left, { turns: 5, minutes: 6, tokens: 10_000, idleMinutes: 5 }); // idle is not spent
  const child = budgetFor({ turns: 20, tokens: 50_000, idleMinutes: 9 }, undefined, left);
  assert.deepEqual(child.budget, { turns: 5, minutes: 6, tokens: 10_000, idleMinutes: 9 });
  assert.deepEqual(child.clamped, ['turns', 'minutes', 'tokens']);
  assert.equal(remaining(parent, usage(40, 20, 200_000)).turns, 0); // never negative
  // nothing left to give: reported, so the caller can refuse instead of starting a child that ends at once
  const spent = budgetFor(undefined, undefined, remaining(parent, usage(30, 9.7, 100_000)));
  assert.deepEqual(spent.exhausted, ['turns', 'minutes', 'tokens']);
  assert.equal(spent.budget.minutes, 0.3); // a tenth of a minute at most
  // rounding never gives a child more than its parent has left
  const close = budgetFor(undefined, undefined, { turns: 5, minutes: 0.96, tokens: 1000, idleMinutes: 5 });
  assert.equal(close.budget.minutes, 0.9);
  assert.deepEqual(budgetFor(undefined, undefined, { turns: 5, minutes: 0.46, tokens: 1000, idleMinutes: 5 }).exhausted, ['minutes']);
  assert.deepEqual(budgetFor({ turns: 5 }, undefined, left).exhausted, []);
});

test('budget: exceeded names the first spent dimension; near limit warns before', () => {
  const b: FullBudget = { turns: 10, minutes: 5, tokens: 1000, idleMinutes: 2 };
  assert.equal(exceeded(b, usage(9, 4, 900, 1)), null);
  assert.equal(exceeded(b, usage(10)), 'turns');
  assert.equal(exceeded(b, usage(1, 5)), 'minutes');
  assert.equal(exceeded(b, usage(1, 1, 1000)), 'tokens');
  assert.equal(exceeded(b, usage(1, 1, 1, 2)), 'idleMinutes');
  assert.deepEqual(nearLimit(b, usage(8, 1, 850)), ['turns', 'tokens']);
  assert.deepEqual(nearLimit({ ...b, turns: 0, tokens: 0 }, usage()), ['turns', 'tokens']); // a zero limit is reached, not NaN
  assert.equal(formatBudget({ ...b, minutes: 6.4794 }), '턴 10 · 6.4분 · 1k');
  assert.equal(formatBudget(b, usage(3, 2, 1500)), '턴 3/10 · 2/5분 · 2k/1k');
});

test('catalog: frontmatter becomes a role; bad files are errors, odd keys warnings; later layers win', () => {
  const ok = parseRole('reviewer', {
    description: 'Read-only reviewer.', when: 'a change set touches 3+ files', not_when: 'a one-line fix', tools: 'read, grep, bash',
    disallowed_tools: ['edit', 'write'], model: 'openai/gpt-6.2', model_locked: true, allowed_subagents: 'scout', approval: 'once',
    budget: { turns: 12, idle_minutes: 3 }, context: 'none', persona: 'grumpy',
  }, '\nYou review.\n', '/p/reviewer.md');
  assert.ok('role' in ok);
  assert.deepEqual(ok.role.tools, ['read', 'grep', 'bash']);
  assert.deepEqual(ok.role.disallowedTools, ['edit', 'write']);
  assert.deepEqual(ok.role.budget, { turns: 12, minutes: undefined, tokens: undefined, idleMinutes: 3 });
  assert.equal(ok.role.instructions, 'You review.');
  assert.deepEqual(ok.warnings, ['/p/reviewer.md: 알 수 없는 키 persona']);
  assert.match((parseRole('x', {}, '', 'x.md') as { error: string }).error, /description이 없습니다/);
  assert.match((parseRole('Bad Name', { description: 'd' }, '', 'b.md') as { error: string }).error, /이름/);
  assert.match((parseRole('x', { description: 'd', approval: 'sometimes' }, '', 'x.md') as { error: string }).error, /approval/);
  const none = parseRole('quiet', { description: 'No tools', tools: [] }, '', 'q.md');
  assert.ok('role' in none && Array.isArray(none.role.tools) && none.role.tools.length === 0); // empty means none, not all
  const defaults = parseRole('scout', { description: 'Recon' }, '', 's.md');
  assert.ok('role' in defaults && defaults.role.context === 'summary' && defaults.role.approval === 'none' && defaults.role.tools === undefined);

  const { roles, shadowed } = mergeCatalog([[role({ source: 'builtin' })], [role({ source: '~/.pi/agents/reviewer.md', model: 'x' })]]);
  assert.equal(roles.get('reviewer')!.model, 'x');
  assert.deepEqual(shadowed, ['reviewer: ~/.pi/agents/reviewer.md가 builtin를 대신합니다.']);
  const lines = roleGuidelines('subagent', [role({ when: 'a change is ready.', notWhen: 'a typo' })]);
  assert.ok(lines.every(l => l.includes('subagent'))); // Pi appends them flat: each names the tool
  assert.equal(lines.at(-1), 'Use subagent with role "reviewer" (Reviews a change) when a change is ready; not a typo.');
});

test('delegation: depth cap, allowed roles, model precedence, tools never widen', () => {
  assert.deepEqual(mayDelegate(0, undefined, 'reviewer'), { ok: true });
  assert.equal(mayDelegate(1, role(), 'scout').ok, false); // allowed_subagents empty
  assert.equal(mayDelegate(1, role({ allowedSubagents: ['scout'] }), 'scout').ok, true);
  assert.equal(mayDelegate(1, role({ allowedSubagents: ['*'] }), 'worker').ok, true);
  assert.match((mayDelegate(2, role({ allowedSubagents: ['*'] }), 'scout') as { why: string }).why, /최대 깊이/);
  assert.match((mayDelegate(1, undefined, 'scout') as { why: string }).why, /역할이 없는/); // only the top Pi delegates without a role
  assert.equal(delegates(1, role({ allowedSubagents: ['scout'] })), true);
  assert.equal(delegates(2, role({ allowedSubagents: ['scout'] })), false); // at the cap: no tool at all

  assert.deepEqual(resolveModel(role({ model: 'a', modelLocked: true }), 'b', 'p'), { model: 'a', source: 'pin' });
  assert.deepEqual(resolveModel(role({ model: 'a' }), 'b', 'p'), { model: 'b', source: 'caller' });
  assert.deepEqual(resolveModel(role({ model: 'a' }), undefined, 'p'), { model: 'a', source: 'default' });
  assert.deepEqual(resolveModel(role(), undefined, 'p'), { model: 'p', source: 'inherit' });

  assert.deepEqual(resolveTools(role({ tools: ['read', 'web_search'] }), ['read', 'bash']), ['read']); // not the parent's: dropped
  assert.deepEqual(resolveTools(role({ disallowedTools: ['edit', 'write'] }), ['read', 'edit', 'write', 'bash']), ['read', 'bash']);
  assert.deepEqual(resolveTools(role({ tools: [] }), ['read', 'bash']), []);
});

test('outcome: finish wins, then what the harness saw; the parent is told when there was no finish', () => {
  assert.deepEqual(classifyEnd({ finish: { status: 'partial', summary: 's' }, exceeded: 'turns' }), { status: 'partial' });
  assert.equal(classifyEnd({ error: 'boom', exceeded: 'turns' }).status, 'error');
  assert.equal(classifyEnd({ exceeded: 'turns', idle: true }).status, 'budget_exceeded');
  assert.equal(classifyEnd({ idle: true }).status, 'idle');
  assert.equal(classifyEnd({ stopped: true }).status, 'stopped');
  assert.equal(classifyEnd({}).status, 'unanswered');
  const meta = { id: 'reviewer-1', role: 'reviewer', model: 'm', call: { task: 'Review', done: 'No blockers left' } } as AgentMeta;
  const done = resultForParent(meta, { status: 'done', summary: 'All good', usage: { turns: 3, tokens: 1200, ms: 4000 }, endedAt: 0 });
  assert.match(done, /Subagent "reviewer-1" \(role reviewer, model m\) ended: done\.\nTask: Review\nDone when: No blockers left\nUsed: 3 turns, 1200 tokens, 4s\.\n\nAll good$/);
  assert.match(resultForParent(meta, { status: 'unanswered', summary: '', usage: { turns: 1, tokens: 1, ms: 1 }, endedAt: 0 }), /did not report through finish/);
});

test('registry: one private directory per agent, results written once, inbox in order and delivered once', t => {
  const root = tmp(t);
  const base = { root: 'sess/01', parent: null, depth: 1, role: 'reviewer', model: 'm', modelSource: 'inherit' as const, tools: ['read'], cwd: '/repo', createdAt: 1, call: { task: 't', budget: DEFAULT_BUDGET, context: 'summary' as const, background: false }, pane: null };
  const a = createAgent(root, base), b = createAgent(root, { ...base, createdAt: 2 });
  assert.deepEqual([a.meta.id, b.meta.id], ['reviewer-1', 'reviewer-2']);
  assert.match(path.basename(path.dirname(a.dir)), /^h-[0-9a-f]{24}$/); // not a plain id: hashed
  assert.equal(treeDir('/r', 'abc-1_2'), '/r/abc-1_2');
  for (const bad of ['..', '.', '', '../x', 'a/b']) assert.equal(path.dirname(treeDir('/r', bad)), '/r', bad); // nothing escapes the root
  assert.notEqual(treeDir('/r', 'a/b'), treeDir('/r', 'a_b')); // and ids do not collide
  const hashed = path.basename(treeDir('/r', 'a/b'));
  assert.notEqual(treeDir('/r', hashed), treeDir('/r', 'a/b')); // not even with an id shaped like a hash
  assert.throws(() => createAgent(root, { ...base, role: '../../x' }), /역할 이름/);
  assert.equal(fs.statSync(path.dirname(a.dir)).mode & 0o777, 0o700);
  assert.equal(a.meta.session, path.join(a.dir, 'session.jsonl'));

  setPane(a.dir, { multiplexer: 'tmux', session: '/s', pane: '%3' });
  writeStatus(a.dir, { state: 'running', activity: 'read', turns: 2, tokens: 100, startedAt: 1, updatedAt: 2 });
  assert.equal(stateOf(readAgent(a.dir)!), 'running');
  assert.equal(writeResult(a.dir, { status: 'done', summary: 'first', usage: { turns: 2, tokens: 100, ms: 9 }, endedAt: 3 }), true);
  assert.equal(writeResult(a.dir, { status: 'stopped', summary: 'late', usage: { turns: 2, tokens: 100, ms: 9 }, endedAt: 4 }), false); // a stop racing a finish
  const read = readAgent(a.dir)!;
  assert.equal(read.result!.summary, 'first');
  assert.deepEqual(read.meta.pane, { multiplexer: 'tmux', session: '/s', pane: '%3' });
  assert.deepEqual(listAgents(root, 'sess/01').map(r => r.meta.id), ['reviewer-1', 'reviewer-2']);
  assert.deepEqual(listAgents(root, 'other'), []);

  const m1 = postInbox(a.dir, { id: 'brief-1', kind: 'briefing', text: 'Background', at: 1 });
  const m2 = postInbox(a.dir, { id: 'steer-1', kind: 'steer', text: 'Focus on X', at: 2 });
  assert.deepEqual([m1.seq, m2.seq], [1, 2]);
  assert.deepEqual(readInbox(a.dir).map(m => m.id), ['brief-1', 'steer-1']);
  markDelivered(a.dir, m1);
  assert.deepEqual(readDelivered(a.dir), { seq: 1, ids: ['brief-1'] });
  assert.deepEqual(readInbox(a.dir, readDelivered(a.dir).seq).map(m => m.id), ['steer-1']);
});

test('requests: each record keeps what changed; decoding gives back every payload exactly', () => {
  const p1 = { model: 'm', system: 'S', tools: [{ name: 'read' }], messages: [{ role: 'user', content: 'hi' }] };
  const p2 = { ...p1, messages: [...p1.messages, { role: 'assistant', content: 'yo' }, { role: 'user', content: 'more' }] };
  const p3 = { model: 'm', system: 'S2', messages: [{ role: 'user', content: 'compacted' }], temperature: 0 }; // tools gone, prefix broken
  const r1 = encodeRequest(undefined, p1, 1, 10), r2 = encodeRequest(p1, p2, 2, 20), r3 = encodeRequest(p2, p3, 3, 30);
  assert.deepEqual(r2, { seq: 2, at: 20, set: { messages: [{ role: 'assistant', content: 'yo' }, { role: 'user', content: 'more' }] }, prefix: { messages: 1 } });
  assert.deepEqual(r3.drop, ['tools']);
  assert.deepEqual(Object.keys(r3.set).sort(), ['messages', 'system', 'temperature']);
  assert.ok(JSON.stringify(r2).length < JSON.stringify(p2).length);
  const text = [r1, r2, r3, encodeRequest(p3, 'raw', 4, 40)].map(r => JSON.stringify(r)).join('\n') + '\n{"seq":5,"at"'; // torn last line
  assert.deepEqual(decodeRequests(text).map(d => d.payload), [p1, p2, p3, 'raw']);
  // a key set to undefined is not sent: it decodes as absent, not as its old value
  const q1 = { model: 'm', temperature: 0 }, q2 = { model: 'm', temperature: undefined };
  const lines = [encodeRequest(undefined, q1, 1, 1), encodeRequest(q1, q2, 2, 2), encodeRequest(q2, undefined, 3, 3)].map(r => JSON.stringify(r)).join('\n');
  assert.deepEqual(decodeRequests(lines).map(d => d.payload), [q1, { model: 'm' }, null]);
});

test('tree: parents first, siblings by start, orphans at the top, connectors and counts', () => {
  const rec = (id: string, parent: string | null, createdAt: number, over: Partial<{ state: 'running'; status: 'done' | 'blocked' }> = {}) => ({
    dir: id, meta: { id, parent, createdAt } as AgentMeta,
    status: over.state ? { state: over.state, turns: 0, tokens: 0, startedAt: 0, updatedAt: 0 } : undefined,
    result: over.status ? { status: over.status, summary: '', usage: { turns: 0, tokens: 0, ms: 0 }, endedAt: 0 } : undefined,
  });
  const records = [rec('verify-1', 'research-1', 3, { state: 'running' }), rec('scout-1', null, 1, { status: 'done' }),
    rec('research-1', null, 2, { state: 'running' }), rec('lost-1', 'gone-1', 4, { status: 'blocked' })];
  const top = buildTree(records);
  assert.deepEqual(top.map(n => [n.record.meta.id, n.orphan]), [['scout-1', false], ['research-1', false], ['lost-1', true]]);
  assert.deepEqual(treeRows(top).map(r => `${r.prefix}${r.node.record.meta.id}`), ['├─ scout-1', '├─ research-1', '│  └─ verify-1', '└─ lost-1']);
  assert.deepEqual(treeRows(top, new Set(['research-1'])).map(r => r.node.record.meta.id), ['scout-1', 'research-1', 'lost-1']);
  assert.deepEqual(treeCounts(records), { running: 2, ended: 2, problems: 1 });
  // a damaged pair naming each other as parents still shows
  const loop = buildTree([rec('x-1', 'y-1', 1), rec('y-1', 'x-1', 2), rec('z-1', null, 3)]);
  assert.deepEqual(treeRows(loop).map(r => `${r.prefix}${r.node.record.meta.id}`), ['├─ z-1', '└─ x-1', '   └─ y-1']);
  const spend = (id: string, parent: string | null, tokens: number, done: boolean) => ({ dir: id, meta: { id, parent, createdAt: 0 } as AgentMeta,
    status: { state: 'running' as const, turns: 0, tokens, startedAt: 0, updatedAt: 0 }, result: done ? { status: 'done' as const, summary: '', usage: { turns: 0, tokens: tokens * 10, ms: 0 }, endedAt: 0 } : undefined });
  const family = [spend('a', null, 1, false), spend('b', 'a', 2, true), spend('c', 'b', 3, false), spend('d', null, 4, false)];
  assert.equal(descendantTokens(family, 'a'), 20 + 3); // b by its result, c by its status; not a itself, not d
  assert.equal(descendantTokens(family, 'd'), 0);
});

test('goals: one file each, open goal found, closed goals stay closed, budget over goal and its agents', t => {
  const root = tmp(t);
  const goal = (over: Partial<Goal> = {}): Goal => ({ id: newGoalId(1000), session: 'sess-1', objective: 'Ship retries', status: 'active', continuations: 0, usage: { turns: 0, tokens: 0 }, createdAt: 1, updatedAt: 1, ...over });
  assert.match(newGoalId(1000), /^g-rs-[0-9a-z]{1,4}$/);
  const g1 = goal({ id: 'g-1', status: 'done', closedAt: 5 }), g2 = goal({ id: 'g-2', createdAt: 2 });
  saveGoal(root, g2); saveGoal(root, g1);
  assert.deepEqual(listGoals(root, 'sess-1').map(g => g.id), ['g-1', 'g-2']); // by creation
  assert.equal(openGoal(listGoals(root, 'sess-1'))!.id, 'g-2');
  assert.equal(fs.statSync(goalsDir(root, 'sess-1')).mode & 0o777, 0o700);

  const paused = moveGoal(g2, 'paused', 'user stopped', 10) as Goal;
  assert.deepEqual([paused.status, paused.pausedBecause, paused.closedAt], ['paused', 'user stopped', undefined]);
  const back = moveGoal(paused, 'active', undefined, 11) as Goal;
  assert.equal(back.pausedBecause, undefined);
  const done = moveGoal(back, 'done', 'tests pass', 12) as Goal;
  assert.deepEqual([done.status, done.closedAt, done.outcome], ['done', 12, 'tests pass']);
  assert.match((moveGoal(done, 'active', undefined) as { error: string }).error, /바꿀 수 없습니다/);
  assert.match((moveGoal(back, 'active', undefined) as { error: string }).error, /이미 active/);

  assert.equal(goalOverBudget(goal({ budget: { turns: 5 }, usage: { turns: 4, tokens: 0 } }), 0), null);
  assert.match(goalOverBudget(goal({ budget: { turns: 5 }, usage: { turns: 5, tokens: 0 } }), 0)!, /턴/);
  assert.match(goalOverBudget(goal({ budget: { tokens: 100 }, usage: { turns: 0, tokens: 60 } }), 40)!, /토큰/); // its subagents count
  const linked = (id: string, g: string | null, tokens: number) => ({ dir: id, meta: { id, goal: g } as AgentMeta, result: { status: 'done' as const, summary: '', usage: { turns: 0, tokens, ms: 0 }, endedAt: 0 } });
  assert.equal(goalAgentTokens(goal({ id: 'g-x' }), [linked('a', 'g-x', 7), linked('b', 'g-y', 9), linked('c', null, 3)]), 7);
});

test('pruning: request logs then whole records age out after their goal closes; running and open-goal work is kept', () => {
  const day = 24 * 60 * 60 * 1000, now = 100 * day;
  const g = (id: string, status: Goal['status'], closedAt?: number): Goal => ({ id, session: 's', objective: '', status, continuations: 0, usage: { turns: 0, tokens: 0 }, createdAt: 0, updatedAt: 0, closedAt });
  const r = (id: string, goal: string | null, endedAt?: number) => ({ dir: `/r/${id}`, meta: { id, goal } as AgentMeta,
    result: endedAt === undefined ? undefined : { status: 'done' as const, summary: '', usage: { turns: 0, tokens: 0, ms: 0 }, endedAt } });
  const goals = [g('open', 'active'), g('old', 'done', now - 20 * day), g('recent', 'abandoned', now - 4 * day), g('fresh', 'done', now - 1 * day)];
  const records = [
    r('running', null), // no result: never
    r('in-open', 'open', now - 30 * day), // its goal is still open: kept however old
    r('in-old', 'old', now - 25 * day), // goal closed 20 days ago: all of it
    r('in-recent', 'recent', now - 10 * day), // goal closed 4 days ago (its own end does not count): requests only
    r('in-fresh', 'fresh', now - 30 * day), // goal closed yesterday: nothing yet
    r('no-goal', null, now - 5 * day), // no goal: from its own end
    r('lost-goal', 'gone', now - 15 * day), // goal file gone: from its own end
  ];
  assert.deepEqual(planPrune(records, goals, DEFAULT_RETENTION, now), [
    { dir: '/r/in-old', what: 'all' }, { dir: '/r/in-recent', what: 'requests' }, { dir: '/r/no-goal', what: 'requests' }, { dir: '/r/lost-goal', what: 'all' },
  ]);
  assert.deepEqual(planPrune(records, goals, DEFAULT_RETENTION, now, dir => dir !== '/r/no-goal').map(a => a.dir), ['/r/in-old', '/r/in-recent', '/r/lost-goal']); // already pruned
  assert.deepEqual(staleGoals(goals, records.filter(x => x.meta.id !== 'in-old'), DEFAULT_RETENTION, now).map(x => x.id), ['old']);
});
