// PR actions for a fan-out task (A/B hybrid):
//  B: fix requests go to Cursor as a PR comment (`@cursor …`, Cursor GitHub integration);
//  A: merging stays local and explicit (`gh pr merge --match-head-commit`, refused if the head moved).
// All GitHub access goes through the user's `gh` (no tokens handled here).
import { prTarget } from './github-review.ts';
import type { AgentView } from './types.ts';

export type GhRun = (args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;

export interface PrState {
  url: string;
  number: number;
  title: string;
  state: 'OPEN' | 'CLOSED' | 'MERGED' | string;
  isDraft: boolean;
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' | string;
  mergeStateStatus: string;
  headRefName: string;
  headRefOid: string;
  baseRefName: string;
  reviewDecision: string | null;
  checks: { total: number; failing: number; pending: number };
}

/** The task's PR. Several PRs (multi-branch) need an explicit --pr. */
export function pickPr(agent: Pick<AgentView, 'git' | 'label'>, wanted?: string | null): string {
  const urls = [...new Set((agent.git?.branches || []).map((b) => b.prUrl).filter((u): u is string => Boolean(u && prTarget(u))))];
  if (wanted) {
    if (!urls.includes(wanted)) throw new Error(`${wanted} is not a PR of ${agent.label}`);
    return wanted;
  }
  if (!urls.length) throw new Error(`${agent.label}: no pull request recorded yet`);
  if (urls.length > 1) throw new Error(`${agent.label} has ${urls.length} PRs; pass --pr <url>: ${urls.join(' ')}`);
  return urls[0];
}

const FIELDS = 'number,url,title,state,isDraft,mergeable,mergeStateStatus,headRefName,headRefOid,baseRefName,reviewDecision,statusCheckRollup';

type CheckItem = { conclusion?: string | null; state?: string | null; status?: string | null };
export function summarizeChecks(rollup: CheckItem[] | null | undefined): PrState['checks'] {
  const items = rollup || [];
  const failing = items.filter((c) => /^(FAILURE|ERROR|CANCELLED|TIMED_OUT|ACTION_REQUIRED|STARTUP_FAILURE)$/.test(String(c.conclusion || c.state || ''))).length;
  const pending = items.filter((c) => /^(PENDING|QUEUED|IN_PROGRESS|EXPECTED|WAITING)$/.test(String(c.status || c.state || '')) && !c.conclusion).length;
  return { total: items.length, failing, pending };
}

export async function prState(gh: GhRun, url: string): Promise<PrState> {
  const r = await gh(['pr', 'view', url, '--json', FIELDS]);
  if (r.code !== 0) throw new Error(`gh pr view failed: ${r.stderr.trim() || r.code}`);
  const j = JSON.parse(r.stdout) as Omit<PrState, 'checks'> & { statusCheckRollup?: CheckItem[] };
  const { statusCheckRollup, ...rest } = j;
  return { ...rest, checks: summarizeChecks(statusCheckRollup) };
}

/** Reasons not to merge right now (empty = ok). UNKNOWN mergeability is GitHub still computing. */
export function mergeBlockers(s: PrState): string[] {
  const out: string[] = [];
  if (s.state !== 'OPEN') out.push(`PR is ${s.state.toLowerCase()}`);
  if (s.isDraft) out.push('PR is a draft');
  if (s.mergeable === 'CONFLICTING') out.push(`conflicts with ${s.baseRefName}`);
  if (s.mergeable === 'UNKNOWN') out.push('GitHub is still computing mergeability; retry shortly');
  if (s.checks.failing) out.push(`${s.checks.failing} failing check(s)`);
  if (s.checks.pending) out.push(`${s.checks.pending} pending check(s)`);
  if (s.reviewDecision === 'CHANGES_REQUESTED') out.push('changes requested');
  return out;
}

export function describePr(s: PrState): string {
  const checks = s.checks.total ? `${s.checks.total - s.checks.failing - s.checks.pending}/${s.checks.total} passing` : 'no checks';
  return [
    `#${s.number} ${s.title}`,
    `${s.headRefName} → ${s.baseRefName} @ ${s.headRefOid.slice(0, 7)}`,
    `state ${s.state}${s.isDraft ? ' (draft)' : ''} · mergeable ${s.mergeable} · ${checks}${s.reviewDecision ? ` · review ${s.reviewDecision}` : ''}`,
    s.url,
  ].join('\n');
}

/** Squash-merge exactly the head that was shown to the user. */
export async function mergePr(gh: GhRun, url: string, headSha: string, { method = 'squash', deleteBranch = true }: { method?: 'squash' | 'merge' | 'rebase'; deleteBranch?: boolean } = {}): Promise<void> {
  if (!/^[0-9a-f]{40}$/.test(headSha)) throw new Error('a full head commit SHA is required');
  const r = await gh(['pr', 'merge', url, `--${method}`, '--match-head-commit', headSha, ...(deleteBranch ? ['--delete-branch'] : [])]);
  if (r.code !== 0) throw new Error(`gh pr merge failed: ${(r.stderr || r.stdout).trim() || r.code}`);
}

export const REBASE_REQUEST = (base: string) =>
  `Please rebase this branch onto the latest \`${base}\` and resolve the conflicts. If package-lock.json conflicts, take \`${base}\`'s version and regenerate it with \`npm install\` at the repo root. Re-run typecheck and tests, then push.`;

/** B: hand a change request to Cursor's GitHub integration as a PR comment. */
export async function askCursor(gh: GhRun, url: string, request: string): Promise<void> {
  const text = request.trim();
  if (!text) throw new Error('empty request');
  const r = await gh(['pr', 'comment', url, '--body', `@cursor ${text}`]);
  if (r.code !== 0) throw new Error(`gh pr comment failed: ${r.stderr.trim() || r.code}`);
}
