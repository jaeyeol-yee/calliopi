// Goals: what a session is working towards, and what its subagents belong to. One goal is open
// (active or paused) per session at a time; subagents started while it is open are linked to it,
// so its end is their end: running ones are stopped, and their records age out with it.
import fs from 'node:fs';
import path from 'node:path';
import { readJson, treeDir, writeJson } from '#lib/agents/registry.ts';
import { descendantTokens } from '#lib/agents/tree.ts';
import type { AgentRecord } from '#lib/agents/types.ts';

export type GoalStatus = 'active' | 'paused' | 'done' | 'abandoned';
export const OPEN: readonly GoalStatus[] = ['active', 'paused'];

export interface Goal {
  id: string;
  /** Session id of the top Pi that owns it. */
  session: string;
  objective: string;
  /** When it is done, as something that can be checked. */
  done?: string;
  status: GoalStatus;
  /**
   * Opened by itself for a request that needed subagents (no goal was open): it groups them, does not
   * carry on or remind, and closes once they have all ended. goal_create or /cl-goal makes it explicit.
   */
  implicit?: boolean;
  /** Optional limits for the goal as a whole (the session's own turns and tokens, plus its subagents'). */
  budget?: { turns?: number; tokens?: number };
  /** The latest progress note, and why it was paused when it was. */
  progress?: string;
  pausedBecause?: string;
  /** How it ended: the closing note and what its subagents reported. */
  outcome?: string;
  /** Times the session was told to carry on by itself. */
  continuations: number;
  usage: { turns: number; tokens: number };
  createdAt: number;
  updatedAt: number;
  closedAt?: number;
}

export const goalsDir = (root: string, session: string) => path.join(treeDir(root, session), 'goals');
const goalFile = (root: string, g: Pick<Goal, 'id' | 'session'>) => path.join(goalsDir(root, g.session), `${g.id}.json`);

export function saveGoal(root: string, goal: Goal): void {
  fs.mkdirSync(goalsDir(root, goal.session), { recursive: true, mode: 0o700 });
  writeJson(goalFile(root, goal), goal);
}

export function listGoals(root: string, session: string): Goal[] {
  const dir = goalsDir(root, session);
  let names: string[];
  try { names = fs.readdirSync(dir).filter(n => n.endsWith('.json')); } catch { return []; }
  return names.flatMap(n => readJson<Goal>(path.join(dir, n)) ?? []).sort((a, b) => a.createdAt - b.createdAt);
}

/** The session's open goal (active or paused), if any. */
export const openGoal = (goals: Goal[]): Goal | undefined => goals.find(g => OPEN.includes(g.status));

/** A new goal id, sortable by creation: g-<time>-<random>. */
export const newGoalId = (now = Date.now()) => `g-${now.toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

const MOVES: Record<GoalStatus, GoalStatus[]> = { active: ['paused', 'done', 'abandoned'], paused: ['active', 'done', 'abandoned'], done: [], abandoned: [] };

/** A goal moved to `to`, or why it cannot: a closed goal stays closed. */
export function moveGoal(goal: Goal, to: GoalStatus, note: string | undefined, now = Date.now()): Goal | { error: string } {
  if (goal.status === to) return { error: `이미 ${to} 상태입니다.` };
  if (!MOVES[goal.status].includes(to)) return { error: `${goal.status} 상태의 goal은 ${to}(으)로 바꿀 수 없습니다.` };
  const closing = to === 'done' || to === 'abandoned';
  return {
    ...goal, status: to, updatedAt: now,
    ...(to === 'paused' ? { pausedBecause: note } : { pausedBecause: undefined }),
    ...(closing ? { closedAt: now, outcome: note ?? goal.outcome } : {}),
  };
}

/** Whether the goal's own budget is used up: why, or null. */
export function goalOverBudget(goal: Goal, agentTokens: number): string | null {
  if (goal.budget?.turns && goal.usage.turns >= goal.budget.turns) return `goal 예산의 턴(${goal.budget.turns})을 다 썼습니다`;
  const tokens = goal.usage.tokens + agentTokens;
  if (goal.budget?.tokens && tokens >= goal.budget.tokens) return `goal 예산의 토큰(${goal.budget.tokens})을 다 썼습니다`;
  return null;
}

/** Tokens the goal's subagents spent (finished ones by their result, running ones by their status). */
export function goalAgentTokens(goal: Goal, records: AgentRecord[]): number {
  // Grandchildren inherit the goal, and a finished child's result already counts them: sum the goal's
  // topmost agents, each by its result, or (running) by its status plus what runs below it.
  const linked = records.filter(r => r.meta.goal === goal.id);
  const ids = new Set(linked.map(r => r.meta.id));
  return linked.filter(r => !r.meta.parent || !ids.has(r.meta.parent))
    .reduce((n, r) => n + (r.result ? r.result.usage.tokens : (r.status?.tokens ?? 0) + descendantTokens(records, r.meta.id)), 0);
}

export interface Retention { requestsDays: number; recordsDays: number }
export const DEFAULT_RETENTION: Retention = { requestsDays: 3, recordsDays: 14 };

export interface PruneAction { dir: string; what: 'requests' | 'all' }

/**
 * What to clean up: an agent's request log once it is `requestsDays` past, and its whole directory
 * once it is `recordsDays` past. "Past" counts from its goal's close, or from its own end when it
 * has no goal (or its goal is gone). Nothing of a running agent or of an open goal is touched.
 */
export function planPrune(records: AgentRecord[], goals: Goal[], retention: Retention, now = Date.now(), hasRequests: (dir: string) => boolean = () => true): PruneAction[] {
  const byId = new Map(goals.map(g => [g.id, g]));
  const day = 24 * 60 * 60 * 1000;
  const actions: PruneAction[] = [];
  for (const r of records) {
    const goal = r.meta.goal ? byId.get(r.meta.goal) : undefined;
    if (goal && OPEN.includes(goal.status)) continue;
    // Without a result it is running, or was lost (killed with its Pi): only once it has been silent past
    // the records retention, counted from its last status, or its creation when it never wrote one.
    if (!r.result) {
      if (now - (r.status?.updatedAt ?? r.meta.createdAt) >= Math.max(1, retention.recordsDays) * day) actions.push({ dir: r.dir, what: 'all' });
      continue;
    }
    const since = goal?.closedAt ?? r.result.endedAt;
    const age = now - since;
    if (age >= retention.recordsDays * day) actions.push({ dir: r.dir, what: 'all' });
    else if (age >= retention.requestsDays * day && hasRequests(r.dir)) actions.push({ dir: r.dir, what: 'requests' });
  }
  return actions;
}

/** Closed goals with nothing left linked to them, past the records retention: their files can go too. */
export function staleGoals(goals: Goal[], records: AgentRecord[], retention: Retention, now = Date.now()): Goal[] {
  const linked = new Set(records.map(r => r.meta.goal));
  return goals.filter(g => g.closedAt && !linked.has(g.id) && now - g.closedAt >= retention.recordsDays * 24 * 60 * 60 * 1000);
}
