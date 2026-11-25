// Branch status for the footer slot: `onto owner/repo#N state`, only when the branch is in a PR.
import type { BranchPulls, PullState } from '@calliopi/core/pr-lookup';

export interface StatusPaint {
  dim(s: string): string;
  /** The `owner/repo#N` reference; gets the PR link. */
  ref(s: string, url: string): string;
  state(s: string, state: PullState): string;
}

export const PLAIN: StatusPaint = { dim: (s) => s, ref: (s) => s, state: (s) => s };

/**
 *   onto them/r#12 open          one PR
 *   onto them/r#12 open +1       more PRs (see /cl-branch)
 *   onto them/r#12 open ↑2       commits not pushed yet
 * Undefined when the branch is in no PR.
 */
export function formatStatus(result: BranchPulls | undefined, paint: StatusPaint = PLAIN): string | undefined {
  const pr = result?.pulls[0];
  if (!pr) return undefined;
  const more = result!.pulls.length > 1 ? paint.dim(` +${result!.pulls.length - 1}`) : '';
  const ahead = result!.ahead ? paint.dim(` ↑${result!.ahead}`) : '';
  return `${paint.dim('onto ')}${paint.ref(`${pr.repo}#${pr.number}`, pr.url)} ${paint.state(pr.state, pr.state)}${more}${ahead}`;
}

/** Re-check a PR that can still change (open or draft); merged and closed ones stay as they are. */
export function pollDelay(result: BranchPulls | undefined, pollSeconds: number): number | undefined {
  return result?.pulls.some((p) => p.state === 'open' || p.state === 'draft') ? pollSeconds * 1000 : undefined;
}

/** Theme token per state, matching GitHub's colors where the theme allows. */
export const STATE_COLOR: Record<PullState, 'success' | 'muted' | 'accent' | 'error'> = {
  open: 'success', draft: 'muted', merged: 'accent', closed: 'error',
};

/** One line per PR for /cl-branch. */
export function describePulls(result: BranchPulls | undefined): string {
  if (!result) return '저장소가 아니거나 git을 실행할 수 없습니다.';
  const head = `${result.branch ?? '(detached)'}${result.ahead ? ` ↑${result.ahead}` : ''}`;
  if (!result.pulls.length) return `${head}: 연결된 PR이 없습니다.`;
  return [head, ...result.pulls.map((p) => `  ${p.repo}#${p.number} ${p.state}  ${p.headRepo}:${p.headRef} → ${p.baseRef}  ${p.url}`)].join('\n');
}
