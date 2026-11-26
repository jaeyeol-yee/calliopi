// The active goal of a session: one open goal (active or paused) at a time. The model works with it
// through goal_get / goal_create / goal_update, the user through /cl-goal. While it is active:
// - every request ends with a short reminder of it (not stored), so it stays in view;
// - when a run ends without the goal being done, the session is told to carry on (continuation),
//   unless the user interrupted, a message is waiting, its subagents are still at work (their results
//   will wake it), it made no progress several times, or its limits are reached: then it pauses;
// - subagents started meanwhile are linked to it (lib/parent.ts), so closing it stops those still
//   running, frees their screens, records what they reported, and lets their records age out.
// A request that needs subagents while no goal is open opens one by itself (implicit): its objective
// is what the user asked, it only groups those subagents (no reminder, no carry-on, no pausing), and
// it closes once they have all ended and the run is over. goal_create or /cl-goal makes it explicit,
// keeping its subagents.
import { Type } from 'typebox';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import {
  STATUS_TEXT, goalAgentTokens, goalOverBudget, listAgents, listGoals, moveGoal, newGoalId, openGoal, saveGoal,
  type AgentRecord, type Goal, type GoalStatus,
} from '@calliopi/core/agents';
import { spent } from '#lib/child.ts';
import type { Fleet } from '#lib/fleet.ts';

export const GOAL_ENTRY = 'calliopi-goal';
export const CONTINUE_MESSAGE = 'calliopi-goal-continue';
/** Carry-ons without the user before the goal pauses itself. */
export const MAX_CONTINUATIONS = 20;
/** Runs in a row without a single tool call: it is not getting anywhere. */
export const NO_PROGRESS_LIMIT = 3;
const STATUS_KEY = 'calliopi-goal';

const STATE: Record<GoalStatus, string> = { active: '진행 중', paused: '일시 중지', done: '완료', abandoned: '포기' };

/** The reminder at the end of each request while the goal is active. */
export function goalReminder(goal: Goal): string {
  return [
    `[Active goal] ${goal.objective}`,
    ...(goal.done ? [`Done when: ${goal.done}`] : []),
    ...(goal.progress ? [`Progress so far: ${goal.progress}`] : []),
    'When the done condition is met, call goal_update with status "done" and the outcome; if you cannot go on without the user, call it with status "blocked" and why.',
  ].join('\n');
}

/** What the session is told when it is to carry on by itself. */
export function continueMessage(goal: Goal): string {
  return [
    `Continue working toward the active goal: ${goal.objective}`,
    ...(goal.done ? [`Done when: ${goal.done}`] : []),
    ...(goal.progress ? [`Progress so far: ${goal.progress}`] : []),
    'Check the done condition against the actual state (run the checks, read the files) before claiming it.',
    'If it is met, call goal_update with status "done" and the outcome. If you need the user, call goal_update with status "blocked" and say why. Otherwise take the next step; record progress with goal_update when something meaningful changes.',
  ].join('\n');
}

/** What the user last asked, on one line: the objective of a goal opened by itself. */
export function lastRequest(entries: readonly unknown[], max = 120): string {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i] as { type?: string; message?: { role?: string; content?: unknown } };
    if (e.type !== 'message' || e.message?.role !== 'user') continue;
    const c = e.message.content;
    const text = typeof c === 'string' ? c
      : Array.isArray(c) ? c.map(p => ((p as { type?: string }).type === 'text' ? (p as { text?: string }).text ?? '' : '')).join(' ') : '';
    const line = text.replace(/\s+/g, ' ').trim();
    if (line) return line.length > max ? `${line.slice(0, max - 1)}…` : line;
  }
  return '';
}

/** Why a goal opened by itself closes. */
export const IMPLICIT_CLOSED = '서브에이전트가 모두 끝나 자동으로 닫힘';

/** One line per subagent of the goal, for its outcome. */
export const agentOutcomes = (records: AgentRecord[]) =>
  records.map(r => `- ${r.meta.id} (${r.meta.role}): ${r.result ? `${STATUS_TEXT[r.result.status]} — ${(r.result.summary.split('\n')[0] ?? '').slice(0, 160)}` : '중지됨'}`).join('\n');

export interface GoalOptions {
  root: () => string;
  fleet: Fleet;
  /** Removes aged records; run when a goal is created or closed. */
  collect: () => void;
}

export interface Goals {
  /** The open goal's id, to link the subagents started now; null when there is none. */
  linkId(): string | null;
  /**
   * The goal the subagents started now belong to: the open one, or else one opened by itself for this
   * request (implicit; `hint` names it when the user's request cannot be read).
   */
  ensure(ctx: ExtensionContext, hint: string): string | null;
}

export function installGoals(pi: ExtensionAPI, opts: GoalOptions): Goals {
  let session = '';
  let ctxRef: ExtensionContext | undefined;
  let goal: Goal | undefined;
  let toolCalls = 0; // in the current run
  let idleRuns = 0; // consecutive runs without a tool call

  const records = () => (session ? listAgents(opts.root(), session) : []);
  const linked = (g: Goal) => records().filter(r => r.meta.goal === g.id);
  const footer = () => ctxRef?.ui.setStatus(STATUS_KEY, goal ? `${goal.implicit ? '◇' : '◆'} ${goal.objective.slice(0, 48)} · ${goal.implicit ? '자동' : STATE[goal.status]}` : undefined);
  const save = (next: Goal, note?: string) => {
    goal = next;
    saveGoal(opts.root(), next);
    pi.appendEntry(GOAL_ENTRY, { goal: next, note }); // the history, in the session
    footer();
  };

  const create = (objective: string, done: string | undefined, budget?: Goal['budget']): Goal | { error: string } => {
    if (!session) return { error: '세션이 아직 시작되지 않았습니다.' };
    const open = openGoal(listGoals(opts.root(), session));
    if (open?.implicit) { // opened by itself for subagents: it becomes this goal, its subagents with it
      const next: Goal = { ...open, objective, done, budget, implicit: undefined, status: 'active', pausedBecause: undefined, updatedAt: Date.now() };
      save(next, 'made explicit');
      idleRuns = 0;
      return next;
    }
    if (open) return { error: `이미 열린 goal이 있습니다(${open.status}): ${open.objective}. 먼저 끝내거나 포기하세요.` };
    const now = Date.now();
    const next: Goal = { id: newGoalId(now), session, objective, done, status: 'active', budget, continuations: 0, usage: { turns: 0, tokens: 0 }, createdAt: now, updatedAt: now };
    save(next, 'created');
    idleRuns = 0;
    opts.collect();
    return next;
  };

  /** Move the goal; closing it stops its running subagents, frees their screens and records their results. */
  const move = (to: GoalStatus, note?: string): Goal | { error: string } => {
    if (!goal) return { error: '열린 goal이 없습니다.' };
    let next = moveGoal(goal, to, note);
    if ('error' in next) return next;
    if (to === 'done' || to === 'abandoned') {
      const mine = linked(goal);
      for (const r of mine) if (!r.result) opts.fleet.stop(r.meta.id);
      // An implicit goal closes as soon as its subagents end: their screens stay to be looked at.
      if (!goal.implicit) opts.fleet.release(mine.map(r => r.meta.id));
      if (mine.length) next = { ...next, outcome: [next.outcome, `서브에이전트 ${mine.length}개:`, agentOutcomes(mine)].filter(Boolean).join('\n') };
      save(next, to);
      goal = undefined;
      footer();
      opts.collect();
      return next;
    }
    if (to === 'active') idleRuns = 0;
    save(next, to);
    return next;
  };
  const pause = (why: string) => {
    if (goal?.status !== 'active') return;
    move('paused', why);
    ctxRef?.ui.notify(`goal 일시 중지: ${why}. /cl-goal resume으로 이어서 합니다.`, 'warning');
  };

  pi.on('session_start', (_e, ctx) => {
    ctxRef = ctx;
    session = ctx.sessionManager.getSessionId();
    goal = openGoal(listGoals(opts.root(), session));
    footer();
  });

  // While active: the goal at the end of every request (not stored). Not an implicit one: the request is its objective.
  pi.on('context', (event) => {
    if (goal?.status !== 'active' || goal.implicit) return;
    return { messages: [...event.messages, { role: 'user', content: [{ type: 'text', text: goalReminder(goal) }], timestamp: Date.now() }] };
  });

  pi.on('agent_start', () => { toolCalls = 0; });
  pi.on('tool_execution_start', () => { toolCalls++; });
  pi.on('message_end', (event) => {
    const m = event.message as { role?: string; usage?: { input?: number; output?: number; cacheWrite?: number } };
    if (goal?.status === 'active' && m.role === 'assistant') goal = { ...goal, usage: { ...goal.usage, tokens: goal.usage.tokens + spent(m.usage) } };
  });
  pi.on('turn_end', () => {
    if (goal?.status !== 'active') return;
    goal = { ...goal, usage: { ...goal.usage, turns: goal.usage.turns + 1 }, updatedAt: Date.now() };
    saveGoal(opts.root(), goal);
  });

  // A run ended while the goal is active: carry on, or pause and say why.
  pi.on('agent_end', (event, ctx) => {
    if (goal?.implicit) { // it only groups the subagents of a request: closed when they all have ended
      if (goal.status === 'active' && !ctx.hasPendingMessages() && linked(goal).every(r => r.result)) move('done', IMPLICIT_CLOSED);
      return;
    }
    if (goal?.status !== 'active') return;
    const last = [...event.messages].reverse().find(m => (m as { role?: string }).role === 'assistant') as { stopReason?: string } | undefined;
    if (last?.stopReason === 'aborted') return pause('사용자가 중단했습니다');
    if (last?.stopReason === 'error') return pause('모델 요청이 실패했습니다');
    if (ctx.hasPendingMessages()) return; // the user has said something: that comes first
    if (linked(goal).some(r => !r.result)) return; // its subagents are at work: their results will wake it
    idleRuns = toolCalls ? 0 : idleRuns + 1;
    if (idleRuns >= NO_PROGRESS_LIMIT) return pause(`${NO_PROGRESS_LIMIT}번 연속으로 아무 작업 없이 끝났습니다`);
    if (goal.continuations >= MAX_CONTINUATIONS) return pause(`자동으로 이어서 한 횟수가 ${MAX_CONTINUATIONS}번에 이르렀습니다`);
    const over = goalOverBudget(goal, goalAgentTokens(goal, records()));
    if (over) return pause(over);
    save({ ...goal, continuations: goal.continuations + 1, updatedAt: Date.now() });
    pi.sendMessage({ customType: CONTINUE_MESSAGE, content: continueMessage(goal), display: true, details: { goal: goal.id, n: goal.continuations } }, { deliverAs: 'followUp', triggerTurn: true });
  });

  const describe = (g: Goal | undefined) => {
    if (!g) return 'No open goal.';
    const mine = linked(g);
    return [
      `Goal ${g.id} (${g.status}${g.implicit ? ', implicit' : ''}): ${g.objective}`,
      ...(g.implicit ? ['Opened by itself for the subagents of this request; it closes once they have all ended. goal_create turns it into an explicit goal, keeping its subagents.'] : []),
      ...(g.done ? [`Done when: ${g.done}`] : []),
      ...(g.progress ? [`Progress: ${g.progress}`] : []),
      ...(g.pausedBecause ? [`Paused because: ${g.pausedBecause}`] : []),
      `Used: ${g.usage.turns} turns, ${g.usage.tokens + goalAgentTokens(g, mine)} tokens (subagents included), ${g.continuations} carry-ons.`,
      ...(mine.length ? [`Subagents (${mine.length}):`, agentOutcomes(mine)] : []),
    ].join('\n');
  };
  const text = (t: string, isError = false) => ({ content: [{ type: 'text' as const, text: t }], details: undefined, ...(isError ? { isError } : {}) });

  pi.registerTool({
    name: 'goal_get', label: 'Goal',
    description: 'The open goal of this session (objective, done condition, progress, usage, its subagents), if any.',
    parameters: Type.Object({}),
    async execute() { return text(describe(goal)); },
  });
  pi.registerTool({
    name: 'goal_create', label: 'Create goal',
    description: 'Open a goal for this session: a long-running objective you keep working on until its done condition is met. Only one goal is open at a time. While it is active you are told to carry on after each run; subagents you start are linked to it. If a goal was opened by itself for subagents (implicit), this makes it your explicit goal and keeps its subagents.',
    promptGuidelines: [
      'Use goal_create when the user hands you a multi-step objective to pursue until it is done; give it a done condition that can be checked.',
      'Use goal_update with status "done" only after checking the done condition against the actual state.',
    ],
    parameters: Type.Object({
      objective: Type.String({ description: 'What the goal is, self-contained.' }),
      done: Type.Optional(Type.String({ description: 'When it is done, as something that can be checked.' })),
      budget: Type.Optional(Type.Object({ turns: Type.Optional(Type.Number()), tokens: Type.Optional(Type.Number()) }, { description: 'Limits for the goal as a whole, subagents included.' })),
    }),
    async execute(_id, params, _s, _u, ctx) {
      ctxRef = ctx;
      const r = create(params.objective, params.done, params.budget);
      return 'error' in r ? text(r.error, true) : text(`Goal ${r.id} is active. ${describe(r)}`);
    },
  });
  pi.registerTool({
    name: 'goal_update', label: 'Update goal',
    description: 'Record progress on the open goal, mark it done once its done condition is met, or report it blocked (it pauses until the user resumes it).',
    parameters: Type.Object({
      status: Type.Optional(Type.Union([Type.Literal('done'), Type.Literal('blocked')], { description: 'done: the done condition is met; blocked: you need the user.' })),
      progress: Type.Optional(Type.String({ description: 'What has been achieved so far, replacing the previous note.' })),
      outcome: Type.Optional(Type.String({ description: 'With done: what was achieved and how it was checked. With blocked: what is needed.' })),
    }),
    async execute(_id, params, _s, _u, ctx) {
      ctxRef = ctx;
      if (!goal) return text('No open goal. Create one with goal_create.', true);
      if (params.progress) save({ ...goal, progress: params.progress, updatedAt: Date.now() }, 'progress');
      if (params.status === 'done') {
        const r = move('done', params.outcome);
        return 'error' in r ? text(r.error, true) : text(`Goal done. ${r.outcome ?? ''}`.trim());
      }
      if (params.status === 'blocked') { pause(`막힘: ${params.outcome ?? '이유 없음'}`); return text('Goal paused until the user resumes it. Tell the user what you need.'); }
      return text(describe(goal));
    },
  });

  pi.registerCommand('cl-goal', {
    description: 'Active goal: /cl-goal <목표> [--done <완료 조건>] 만들기 · pause · resume · done [메모] · abandon [메모] · 인자 없이: 지금 goal',
    handler: async (args, ctx) => {
      ctxRef = ctx;
      const [word = '', ...rest] = args.trim().split(/\s+/);
      const note = rest.join(' ') || undefined;
      const say = (r: Goal | { error: string }, ok: string) => ctx.ui.notify('error' in r ? r.error : ok, 'error' in r ? 'warning' : 'info');
      if (!word) return ctx.ui.notify(describe(goal), 'info');
      if (word === 'pause') return say(move('paused', note ?? '사용자가 일시 중지함'), 'goal을 일시 중지했습니다.');
      if (word === 'done' || word === 'abandon') return say(move(word === 'done' ? 'done' : 'abandoned', note), word === 'done' ? 'goal을 완료로 닫았습니다.' : 'goal을 포기했습니다.');
      if (word === 'resume') {
        const r = move('active');
        say(r, 'goal을 다시 진행합니다.');
        if (!('error' in r)) pi.sendMessage({ customType: CONTINUE_MESSAGE, content: continueMessage(r), display: true }, { deliverAs: 'followUp', triggerTurn: true });
        return;
      }
      const m = /^(.*?)(?:\s+--done\s+(.+))?$/s.exec(args.trim())!;
      const r = create(m[1]!.trim(), m[2]?.trim());
      say(r, 'error' in r || r.updatedAt === r.createdAt ? 'goal을 만들었습니다. 바로 시작합니다.' : '자동으로 열린 goal을 이 goal로 바꿨습니다(서브에이전트 유지). 바로 시작합니다.');
      if (!('error' in r)) pi.sendMessage({ customType: CONTINUE_MESSAGE, content: continueMessage(r), display: true }, { deliverAs: 'followUp', triggerTurn: true });
    },
  });

  const ensure = (ctx: ExtensionContext, hint: string): string | null => {
    if (goal) return goal.id;
    ctxRef = ctx;
    session ||= ctx.sessionManager.getSessionId();
    const now = Date.now();
    const objective = lastRequest(ctx.sessionManager.getBranch()) || hint.replace(/\s+/g, ' ').slice(0, 120) || '서브에이전트 작업';
    save({ id: newGoalId(now), session, objective, implicit: true, status: 'active', continuations: 0, usage: { turns: 0, tokens: 0 }, createdAt: now, updatedAt: now }, 'opened for subagents');
    return goal!.id;
  };

  return { linkId: () => (goal ? goal.id : null), ensure };
}
