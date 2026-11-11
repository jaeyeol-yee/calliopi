// Workspace sources for tree/arch: git refs and local working trees only (public, no Cursor RPCs).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/** Base tree from a local clone at a ref (fetched); stands in for "GitHub at the starting ref". */
export function gitRefSource(repoDir, ref) {
  const git = (...a) => execFileSync('git', ['-C', repoDir, ...a], { encoding: 'utf8', maxBuffer: 64 << 20 });
  return {
    kind: `git ${ref}`,
    list: async () => git('ls-tree', '-r', '--name-only', ref).split('\n').filter(Boolean),
    readFile: async (p) => { try { return git('show', `${ref}:${p}`); } catch { return null; } },
  };
}

/** Local working tree (tracked + untracked, .gitignore respected) — used for previews/tests. */
export function localSource(repoDir) {
  const git = (...a) => execFileSync('git', ['-C', repoDir, ...a], { encoding: 'utf8', maxBuffer: 64 << 20 });
  return {
    kind: `local working tree ${repoDir}`,
    list: async () => git('ls-files', '-co', '--exclude-standard').split('\n').filter(Boolean),
    /** Content-level changes vs a ref (tracked files). Agent sources get these from changes.jsonl instead. */
    modified: async (ref = 'HEAD') => new Map(git('diff', '--numstat', ref).split('\n').filter(Boolean).map((l) => {
      const [a, d, p] = l.split('\t'); return [p, { linesAdded: Number(a) || 0, linesRemoved: Number(d) || 0, confidence: 'exact' }];
    })),
    readFile: async (p) => { try { return fs.readFileSync(path.join(repoDir, p), 'utf8'); } catch { return null; } },
  };
}

/**
 * GitHub ref via the `gh` CLI (public GitHub API; uses the user's existing gh auth).
 * Reads what an agent has PUSHED: full tree, file contents, and a compare against a base ref.
 */
export function ghRefSource(repo, ref) {
  const gh = (...a) => execFileSync('gh', ['api', ...a], { encoding: 'utf8', maxBuffer: 256 << 20 });
  const enc = encodeURIComponent;
  return {
    kind: `github ${repo}@${ref} (gh)`,
    list: async () => {
      const t = JSON.parse(gh(`repos/${repo}/git/trees/${enc(ref)}?recursive=1`));
      if (t.truncated) process.stderr.write('warn: GitHub tree listing truncated (very large repo)\n');
      return t.tree.filter((e) => e.type === 'blob').map((e) => e.path);
    },
    readFile: async (p) => {
      try { return gh('-H', 'Accept: application/vnd.github.raw', `repos/${repo}/contents/${p.split('/').map(enc).join('/')}?ref=${enc(ref)}`); } catch { return null; }
    },
    /** compare base...ref → Map(path → {linesAdded, linesRemoved, status}) */
    modified: async (base) => {
      const c = JSON.parse(gh(`repos/${repo}/compare/${enc(base)}...${enc(ref)}`));
      return new Map((c.files || []).map((f) => [f.filename, { linesAdded: f.additions, linesRemoved: f.deletions, confidence: 'exact', ghStatus: f.status, patch: f.patch }]));
    },
  };
}
