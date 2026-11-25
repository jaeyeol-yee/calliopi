// Which pull requests is the current branch's work in? Looked up by commit, not branch name: the same
// branch may be pushed to several remotes (a fork and its upstream), under another name, or deleted
// after a merge. Candidates are every GitHub remote plus each fork's parent, so a PR from a fork to
// its upstream is found too. GitHub only (github.com); other remotes are ignored.
import type { Capture } from '#lib/capture.ts';

export type PullState = 'open' | 'draft' | 'merged' | 'closed';

export interface PullRef {
  /** Base repository, owner/repo: the PR number belongs to it. */
  repo: string;
  number: number;
  url: string;
  state: PullState;
  headRepo: string;
  headRef: string;
  baseRef: string;
  updatedAt: string;
}

export interface BranchPulls {
  /** Local branch name; undefined when HEAD is detached. */
  branch?: string;
  head: string;
  /** PRs this branch is in, most relevant first (open, draft, merged, closed; then most recent). */
  pulls: PullRef[];
  /** Commits on HEAD not yet pushed (to @{push}); undefined when the branch has no push target. */
  ahead?: number;
}

/** owner/repo of a github.com remote URL (https, scp-style ssh, ssh://), or undefined. */
export function githubRepo(url: string): string | undefined {
  const m = url.trim().match(/^(?:https?:\/\/(?:[^@/]+@)?|ssh:\/\/(?:[^@/]+@)?|[^@/]+@)github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
  return m ? `${m[1]}/${m[2]}` : undefined;
}

/** GitHub repositories of the configured remotes, by remote name (fetch URLs). */
export function parseRemotes(remoteV: string): Map<string, string> {
  const remotes = new Map<string, string>();
  for (const line of remoteV.split('\n')) {
    const m = line.match(/^(\S+)\s+(\S+)\s+\(fetch\)$/);
    const repo = m && githubRepo(m[2]!);
    if (m && repo) remotes.set(m[1]!, repo);
  }
  return remotes;
}

const RANK: Record<PullState, number> = { open: 0, draft: 1, merged: 2, closed: 3 };

export function pullState(pr: { state?: string; draft?: boolean; merged_at?: string | null }): PullState {
  if (pr.state === 'open') return pr.draft ? 'draft' : 'open';
  return pr.merged_at ? 'merged' : 'closed';
}

/** A PR as returned for a commit; `headSha` decides whether it is this branch's PR. */
export type CommitPull = PullRef & { headSha: string };

/** Parse `gh api repos/{repo}/commits/{sha}/pulls`. */
export function parsePulls(json: string): CommitPull[] {
  const list = JSON.parse(json) as unknown;
  if (!Array.isArray(list)) return [];
  return list.flatMap((pr: any) => (typeof pr?.number === 'number' && pr.base?.repo?.full_name ? [{
    repo: String(pr.base.repo.full_name), number: pr.number, url: String(pr.html_url ?? ''), state: pullState(pr),
    headRepo: String(pr.head?.repo?.full_name ?? ''), headRef: String(pr.head?.ref ?? ''), baseRef: String(pr.base?.ref ?? ''),
    updatedAt: String(pr.updated_at ?? ''), headSha: String(pr.head?.sha ?? ''),
  }] : []));
}

export function sortPulls<T extends PullRef>(pulls: T[]): T[] {
  return [...pulls].sort((a, b) => RANK[a.state] - RANK[b.state] || b.updatedAt.localeCompare(a.updatedAt));
}

export interface LookupOptions {
  cwd: string;
  run: Capture;
  /** Cache of fork parents (owner/repo → parent or ''), kept by the caller across lookups. */
  parents?: Map<string, string>;
}

const git = async (o: LookupOptions, args: string[]) => {
  const r = await o.run('git', args, { cwd: o.cwd });
  return r.code === 0 ? r.stdout.trim() : undefined;
};

async function parentOf(o: LookupOptions, repo: string): Promise<string | undefined> {
  const cached = o.parents?.get(repo);
  if (cached !== undefined) return cached || undefined;
  const r = await o.run('gh', ['api', `repos/${repo}`, '--jq', '.parent.full_name // ""'], { cwd: o.cwd });
  if (r.code !== 0) return undefined; // not cached: retry next time (offline, not logged in)
  const parent = r.stdout.trim();
  o.parents?.set(repo, parent);
  return parent || undefined;
}

/** Local git facts for a lookup; cheap, no network. Undefined outside a repository. */
export async function localState(o: LookupOptions) {
  const head = await git(o, ['rev-parse', 'HEAD']);
  if (!head) return undefined;
  const branch = await git(o, ['symbolic-ref', '--short', '-q', 'HEAD']);
  const push = branch ? await git(o, ['rev-parse', '--verify', '--quiet', '@{push}']) : undefined;
  const pushName = push ? await git(o, ['rev-parse', '--abbrev-ref', '@{push}']) : undefined;
  const ahead = push ? Number(await git(o, ['rev-list', '--count', '@{push}..HEAD'])) : undefined;
  const remotes = parseRemotes((await git(o, ['remote', '-v'])) ?? '');
  // <remote>/<branch> → <branch>; remote names are matched exactly since they may contain '/'.
  const remote = pushName && [...remotes.keys()].sort((a, b) => b.length - a.length).find((r) => pushName.startsWith(`${r}/`));
  const pushBranch = pushName && remote ? pushName.slice(remote.length + 1) : undefined;
  return { head, branch, push, pushBranch, ahead: Number.isFinite(ahead) ? ahead : undefined, remotes };
}

/**
 * PRs for the current branch. A PR counts when its head is one of our commits (HEAD or the pushed
 * commit) or its head branch has our branch's name: a merge commit on main belongs to the PR it
 * merged, and must not make `main` look like that PR's branch.
 */
export async function lookupPulls(o: LookupOptions): Promise<BranchPulls | undefined> {
  const local = await localState(o);
  if (!local) return undefined;
  const repos = new Set(local.remotes.values());
  for (const repo of [...repos]) {
    const parent = await parentOf(o, repo);
    if (parent) repos.add(parent);
  }
  const shas = [...new Set([local.head, local.push].filter((s): s is string => Boolean(s)))];
  const names = new Set([local.branch, local.pushBranch].filter((s): s is string => Boolean(s)));
  const found = new Map<string, CommitPull>();
  await Promise.all([...repos].flatMap((repo) => shas.map(async (sha) => {
    // 422 when the commit is not on GitHub (e.g. not pushed yet): no PRs from this pair.
    const r = await o.run('gh', ['api', `repos/${repo}/commits/${sha}/pulls`], { cwd: o.cwd });
    if (r.code !== 0) return;
    let pulls: CommitPull[];
    try { pulls = parsePulls(r.stdout); } catch { return; }
    for (const pr of pulls) {
      if (shas.includes(pr.headSha) || names.has(pr.headRef)) found.set(`${pr.repo}#${pr.number}`, pr);
    }
  })));
  const pulls = sortPulls([...found.values()]).map(({ headSha: _sha, ...pr }) => pr);
  return { branch: local.branch, head: local.head, pulls, ahead: local.ahead };
}
