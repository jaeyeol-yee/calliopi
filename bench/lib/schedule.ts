// Which planned run starts next when several may run at once: in plan order, the first whose provider
// is under its own limit and has not run out. The plan alternates arms (repetition, then task, then
// arm), so a provider limit below the total keeps the slots spread over providers.
import type { PlannedRun } from './spec.ts';

export interface Limits {
  /** Runs at once. */
  total: number;
  /** Runs at once per provider (subscriptions and rate limits are per provider). */
  perProvider: number;
}

export const providerOf = (run: PlannedRun) => run.arm.model.split('/')[0]!;

/** The index in `queue` of the next run to start, or -1 when none may start now. */
export function nextRun(queue: PlannedRun[], active: Map<string, number>, limits: Limits, exhausted: Set<string>): number {
  const running = [...active.values()].reduce((a, n) => a + n, 0);
  if (running >= limits.total) return -1;
  return queue.findIndex(run => !exhausted.has(providerOf(run)) && (active.get(providerOf(run)) ?? 0) < limits.perProvider);
}
