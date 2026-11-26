// Budgets bound a tree of agents the way a shrinking argument bounds a recursion: a child gets at
// most what its parent has left, so every path down the tree ends.
import type { Budget, BudgetUsage, FullBudget } from '#lib/agents/types.ts';

export const DEFAULT_BUDGET: FullBudget = { turns: 30, minutes: 15, tokens: 300_000, idleMinutes: 5 };
/** No call may ask for more than this, whatever the role says. */
export const MAX_BUDGET: FullBudget = { turns: 200, minutes: 120, tokens: 2_000_000, idleMinutes: 30 };

const DIMENSIONS = ['turns', 'minutes', 'tokens', 'idleMinutes'] as const;
export type BudgetDimension = (typeof DIMENSIONS)[number];

/** What is left of `budget` after `usage`; never negative. Idle time is not spent, so it stays whole. */
export function remaining(budget: FullBudget, usage: BudgetUsage): FullBudget {
  return {
    turns: Math.max(0, budget.turns - usage.turns),
    minutes: Math.max(0, budget.minutes - usage.ms / 60_000),
    tokens: Math.max(0, budget.tokens - usage.tokens),
    idleMinutes: budget.idleMinutes,
  };
}

/**
 * A child's budget: what the call asks for, else the role's default, else DEFAULT_BUDGET; capped
 * by MAX_BUDGET and by what the parent has left (`parentLeft`, undefined for the top Pi, which has
 * no budget of its own). `clamped` names the dimensions cut down to what the parent had.
 */
export function budgetFor(requested: Budget | undefined, role: Budget | undefined, parentLeft?: FullBudget): { budget: FullBudget; clamped: BudgetDimension[]; exhausted: BudgetDimension[] } {
  const clamped: BudgetDimension[] = [];
  const budget = {} as FullBudget;
  for (const d of DIMENSIONS) {
    const asked = positive(requested?.[d]) ?? positive(role?.[d]) ?? DEFAULT_BUDGET[d];
    let value = Math.min(asked, MAX_BUDGET[d]);
    if (parentLeft && d !== 'idleMinutes' && parentLeft[d] < value) { value = parentLeft[d]; clamped.push(d); }
    // Always down: a child never gets more than its parent has left, not even by rounding.
    budget[d] = d === 'turns' || d === 'tokens' ? Math.floor(value) : Math.floor(value * 10) / 10;
  }
  // Nothing left to give: the caller should not delegate rather than start a child that ends at once.
  const exhausted = clamped.filter(d => budget[d] < (d === 'minutes' ? 0.5 : 1));
  return { budget, clamped, exhausted };
}

const positive = (n: number | undefined) => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : undefined);

/** The first dimension `usage` has used up, or null. */
export function exceeded(budget: FullBudget, usage: BudgetUsage): BudgetDimension | null {
  if (usage.turns >= budget.turns) return 'turns';
  if (usage.ms >= budget.minutes * 60_000) return 'minutes';
  if (usage.tokens >= budget.tokens) return 'tokens';
  if (usage.idleMs >= budget.idleMinutes * 60_000) return 'idleMinutes';
  return null;
}

/** Dimensions at or past `ratio` of their limit (idle excluded): time to wrap up. */
export function nearLimit(budget: FullBudget, usage: BudgetUsage, ratio = 0.8): BudgetDimension[] {
  const used: Record<Exclude<BudgetDimension, 'idleMinutes'>, number> = {
    turns: share(usage.turns, budget.turns), minutes: share(usage.ms, budget.minutes * 60_000), tokens: share(usage.tokens, budget.tokens),
  };
  return (Object.keys(used) as (keyof typeof used)[]).filter(d => used[d] >= ratio);
}

/** Used share of a limit; a zero limit is already reached. */
const share = (used: number, limit: number) => (limit > 0 ? used / limit : 1);

/** "턴 12/30 · 4/15분 · 41k/300k" */
export function formatBudget(budget: FullBudget, usage?: BudgetUsage): string {
  const k = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
  const min = (n: number) => String(Math.floor(n * 10) / 10);
  if (!usage) return `턴 ${budget.turns} · ${min(budget.minutes)}분 · ${k(budget.tokens)}`;
  return `턴 ${usage.turns}/${budget.turns} · ${Math.floor(usage.ms / 60_000)}/${min(budget.minutes)}분 · ${k(usage.tokens)}/${k(budget.tokens)}`;
}
