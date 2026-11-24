// Git side of /cl-preview: branches, merge-base, and a single file's diff against a revision.
// Nothing is checked out: the revision side is read from the object store, the other side is the
// working-tree file (uncommitted edits included, the index ignored).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isUtf8 } from 'node:buffer';
import { spawnSync } from 'node:child_process';
import { gitEnv } from '#lib/git-log.ts';
import { MAX_FILE_BYTES } from '#lib/file-edit.ts';

/** 'base': since the branch diverged (merge-base with HEAD). 'tip': against the branch as it is now. */
export type DiffMode = 'base' | 'tip';

export interface BranchRecord {
  ref: string;
  name: string;
  remote: boolean;
  current: boolean;
  display: string;
}

function git(root: string, args: string[], input?: string) {
  return spawnSync('git', ['--no-pager', ...args], { cwd: root, encoding: 'buffer', input, maxBuffer: 64 * 1024 * 1024, timeout: 15_000, env: { ...process.env, ...gitEnv } });
}

// Local and remote branches, most recent commit first. Ref names cannot contain control characters,
// so \x1f-separated fields on separate lines are unambiguous.
export function parseBranches(output: string): BranchRecord[] {
  return output.split('\n').filter(Boolean).flatMap(line => {
    const [ref = '', name = '', when = '', head = ''] = line.split('\x1f');
    if (!ref.startsWith('refs/heads/') && !ref.startsWith('refs/remotes/')) return [];
    if (ref.startsWith('refs/remotes/') && ref.endsWith('/HEAD')) return []; // origin/HEAD is an alias
    const remote = ref.startsWith('refs/remotes/');
    const current = head === '*';
    return [{ ref, name, remote, current, display: `${current ? '*' : ' '} ${name}  ${when}${remote ? '  (원격 · 마지막 fetch 기준)' : ''}` }];
  });
}

export function listBranches(root: string): BranchRecord[] {
  const r = git(root, ['for-each-ref', '--sort=-committerdate', '--format=%(refname)%1f%(refname:short)%1f%(committerdate:relative)%1f%(HEAD)', 'refs/heads', 'refs/remotes']);
  return r.status === 0 ? parseBranches(r.stdout.toString('utf8')) : [];
}

/** Where HEAD and ref diverged; null for unrelated histories or an unborn HEAD. */
export function mergeBase(root: string, ref: string): string | null {
  const r = git(root, ['merge-base', 'HEAD', ref]);
  return r.status === 0 ? r.stdout.toString('utf8').trim() || null : null;
}

/**
 * Branch to compare against when none is given: the local copy of origin's default branch, then
 * main or master, then origin's default branch itself. null when none exists.
 */
export function defaultBase(cwd: string): string | null {
  const head = git(cwd, ['symbolic-ref', '-q', '--short', 'refs/remotes/origin/HEAD']);
  const remote = head.status === 0 ? head.stdout.toString('utf8').trim() : '';
  const local = remote.includes('/') ? remote.slice(remote.indexOf('/') + 1) : '';
  for (const name of [local, 'main', 'master'].filter(Boolean)) {
    if (git(cwd, ['rev-parse', '--verify', '-q', `refs/heads/${name}`]).status === 0) return name;
  }
  return remote || null;
}

export interface BranchDistance {
  name: string;
  /** Commits only on the branch. */
  ahead: number;
  /** Commits only on HEAD: what this side added since the two diverged. */
  behind: number;
  current: boolean;
}

/**
 * The local branch HEAD certainly grew from: one whose tip is an ancestor of HEAD (ahead 0), the
 * nearest such (fewest HEAD-only commits). Ties: `preferred`, then by name. A branch that moved on
 * since is not guessed at: by distance alone a sibling forked at the same point looks just as close
 * as the parent, so the caller falls back to the default branch instead.
 */
export function nearestBranch(branches: readonly BranchDistance[], preferred: string | null): string | null {
  const candidates = branches.filter(b => !b.current && b.ahead === 0);
  candidates.sort((a, b) => a.behind - b.behind
    || Number(b.name === preferred) - Number(a.name === preferred) || a.name.localeCompare(b.name));
  return candidates[0]?.name ?? null;
}

/**
 * Branch to show changes against: the nearest branch HEAD grew from, else defaultBase. Remote
 * branches count too (a stale local main would otherwise pull in everything merged upstream since),
 * except copies of the current branch: unpushed commits would make those the nearest ancestor.
 * Needs git 2.41 for ahead-behind; older git gets defaultBase.
 */
export function parentBranch(cwd: string): string | null {
  const r = git(cwd, ['for-each-ref', '--format=%(refname)%1f%(refname:short)%1f%(ahead-behind:HEAD)%1f%(HEAD)', 'refs/heads', 'refs/remotes']);
  const fallback = defaultBase(cwd);
  if (r.status !== 0) return fallback;
  const rows = r.stdout.toString('utf8').split('\n').filter(Boolean).map(line => line.split('\x1f'));
  const current = rows.find(([, , , head]) => head === '*')?.[0]?.replace(/^refs\/heads\//, '');
  const branches = rows.flatMap(([ref = '', name = '', counts = '', head = '']) => {
    if (ref.startsWith('refs/remotes/') && (ref.endsWith('/HEAD') || (current && ref.endsWith(`/${current}`)))) return [];
    const [ahead, behind] = counts.split(' ').map(Number);
    return Number.isInteger(ahead) && Number.isInteger(behind) ? [{ name, ahead: ahead!, behind: behind!, current: head === '*' }] : [];
  });
  return nearestBranch(branches, fallback) ?? fallback;
}

/**
 * cwd-relative files that differ since HEAD diverged from `ref`: committed on this side, edited but
 * uncommitted, or new and untracked (ignored files excluded). null when there is no common ancestor.
 */
export function changedSince(cwd: string, ref: string): Set<string> | null {
  if (!ref || ref.startsWith('-')) return null; // user-typed: never let it read as an option
  const base = mergeBase(cwd, ref);
  if (!base) return null;
  // '-- .' limits the work, not just the output, to cwd (the picker's scope): without it git diff
  // stats every tracked file in the repository even with --relative.
  const diff = git(cwd, ['diff', '--name-only', '-z', '--no-renames', '--relative', base, '--', '.']);
  const untracked = git(cwd, ['ls-files', '--others', '--exclude-standard', '-z', '--', '.']);
  if (diff.status !== 0 || untracked.status !== 0) return null;
  return new Set([diff, untracked].flatMap(r => r.stdout.toString('utf8').split('\0')).filter(Boolean));
}

interface Side { exists: boolean; text: string | null }

function textOf(data: Buffer): string | null {
  return data.length > MAX_FILE_BYTES || data.includes(0) || !isUtf8(data) ? null : data.toString('utf8');
}

function atRevision(root: string, rev: string, rel: string): Side {
  // rev:path takes a literal, root-relative path (no pathspec magic).
  const size = git(root, ['cat-file', '-s', `${rev}:${rel}`]);
  if (size.status !== 0) return { exists: false, text: null };
  if (Number(size.stdout.toString('utf8')) > MAX_FILE_BYTES) return { exists: true, text: null };
  const blob = git(root, ['cat-file', 'blob', `${rev}:${rel}`]);
  return blob.status === 0 ? { exists: true, text: textOf(blob.stdout) } : { exists: false, text: null };
}

function inWorkTree(root: string, rel: string): Side {
  try {
    const file = path.join(root, rel);
    if (!fs.statSync(file).isFile()) return { exists: false, text: null };
    if (fs.statSync(file).size > MAX_FILE_BYTES) return { exists: true, text: null };
    return { exists: true, text: textOf(fs.readFileSync(file)) };
  } catch { return { exists: false, text: null }; }
}

export type FileDiff =
  | { status: 'changed'; base: string; text: string }
  | { status: 'same' | 'missing' | 'binary'; base: string }
  | { status: 'no-base' };

/** Unified diff of one root-relative file: revision (merge-base or branch tip) → working tree. */
export function diffFile(root: string, rel: string, ref: string, mode: DiffMode): FileDiff {
  const base = mode === 'base' ? mergeBase(root, ref) : ref;
  if (!base) return { status: 'no-base' };
  const before = atRevision(root, base, rel);
  const after = inWorkTree(root, rel);
  if (!before.exists && !after.exists) return { status: 'missing', base };
  if ((before.exists && before.text === null) || (after.exists && after.text === null)) return { status: 'binary', base };
  if (before.exists && after.exists && before.text === after.text) return { status: 'same', base };
  // Both sides as files named after rel, so the headers read a/<rel> and b/<rel>.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'calliopi-preview-diff-'));
  try {
    const write = (side: 'a' | 'b', text: string) => {
      const file = path.join(dir, side, rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text, { mode: 0o600 });
      return path.join(side, rel);
    };
    const a = before.exists ? write('a', before.text!) : '/dev/null';
    const b = after.exists ? write('b', after.text!) : '/dev/null';
    const r = spawnSync('git', ['--no-pager', 'diff', '--no-index', '--no-ext-diff', '--no-textconv', '--no-prefix', '--color=never', '--', a, b], {
      cwd: dir, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 10_000, env: { ...process.env, ...gitEnv },
    });
    if (r.status !== 1 || typeof r.stdout !== 'string') return { status: 'same', base };
    return { status: 'changed', base, text: r.stdout };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
