// Working tree status for the footer slot: how many files are conflicted, staged, modified and
// untracked, so edits the agent made (or left half-staged) stay visible. Nothing when clean.
//
//   onto them/r#12 open  ✖1 +2 ~3 ?1     (slot keys sort: branch-status, then worktree)
//                        │  │  │  └ untracked
//                        │  │  └ changed, not staged
//                        │  └ staged
//                        └ conflicted (unmerged)

export interface WorktreeCounts {
  conflicted: number;
  staged: number;
  modified: number;
  untracked: number;
}

export type WorktreeKind = keyof WorktreeCounts;

/**
 * `git` arguments: porcelain v2 status (stable across versions and locales), NUL-separated so paths
 * need no unquoting. `--no-optional-locks` (git 2.15) keeps polling from refreshing the index, so it
 * never takes index.lock from under the agent's own git commands.
 */
export const WORKTREE_ARGS = ['--no-optional-locks', 'status', '--porcelain=v2', '-z', '--untracked-files=normal', '--ignore-submodules=dirty'];

/**
 * Count `git status --porcelain=v2 -z` entries. A file staged and then changed again counts as both
 * staged and modified, as in git's own prompt. Unknown entry types are skipped.
 */
export function parseWorktree(out: string): WorktreeCounts {
  const counts: WorktreeCounts = { conflicted: 0, staged: 0, modified: 0, untracked: 0 };
  const fields = out.split('\0');
  for (let i = 0; i < fields.length; i++) {
    const entry = fields[i]!;
    switch (entry[0]) {
      case '1':
      case '2': {
        const [x, y] = [entry[2], entry[3]];
        if (x && x !== '.') counts.staged++;
        if (y && y !== '.') counts.modified++;
        // A rename or copy carries its original path as the next field.
        if (entry[0] === '2') i++;
        break;
      }
      case 'u': counts.conflicted++; break;
      case '?': counts.untracked++; break;
    }
  }
  return counts;
}

export const isClean = (c: WorktreeCounts) => !c.conflicted && !c.staged && !c.modified && !c.untracked;

export type WorktreePaint = (s: string, kind: WorktreeKind) => string;

const SYMBOL: Record<WorktreeKind, string> = { conflicted: '✖', staged: '+', modified: '~', untracked: '?' };
const ORDER: WorktreeKind[] = ['conflicted', 'staged', 'modified', 'untracked'];

/** Theme token per kind: conflicts need attention, staged is ready, untracked is quiet. */
export const KIND_COLOR: Record<WorktreeKind, 'error' | 'success' | 'warning' | 'dim'> = {
  conflicted: 'error', staged: 'success', modified: 'warning', untracked: 'dim',
};

/** `✖1 +2 ~3 ?1`, leaving out zero counts. Undefined when clean or unknown (not a repository). */
export function formatWorktree(counts: WorktreeCounts | undefined, paint: WorktreePaint = (s) => s): string | undefined {
  if (!counts || isClean(counts)) return undefined;
  return ORDER.filter((k) => counts[k]).map((k) => paint(`${SYMBOL[k]}${counts[k]}`, k)).join(' ');
}

const LABEL: Record<WorktreeKind, string> = { conflicted: '충돌', staged: '스테이징', modified: '수정', untracked: '추적 안 함' };

/** One line for /cl-branch. */
export function describeWorktree(counts: WorktreeCounts | undefined): string {
  if (!counts) return '작업 트리: 알 수 없음';
  if (isClean(counts)) return '작업 트리: 깨끗함';
  return `작업 트리: ${ORDER.filter((k) => counts[k]).map((k) => `${LABEL[k]} ${counts[k]}`).join(', ')}`;
}
