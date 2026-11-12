import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fzfSelect, shellQuote, cleanDisplay, fzfEnv, parseSelectResult, type FzfSelection } from '#lib/fzf.ts';
import { keyName } from '#lib/terminal-input.ts';
import type { RunProgram } from '#lib/types.ts';
import type { TerminalOverlay } from '#lib/terminal-overlay.ts';

const previewScript = fileURLToPath(new URL('../bin/git-preview.ts', import.meta.url));
export const MAX_COMMITS = 2000;

// Pathspecs are literal everywhere: a file named ":(top)x" must not be interpreted as magic.
export const gitEnv: NodeJS.ProcessEnv = { GIT_LITERAL_PATHSPECS: '1', GIT_OPTIONAL_LOCKS: '0' };

function git(cwd: string, args: string[]): string {
  const result = spawnSync('git', ['--no-pager', ...args], {
    cwd, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024, timeout: 15_000, env: { ...process.env, ...gitEnv },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error((result.stderr as Buffer).toString('utf8').trim() || `git ${args[0]} 실패`);
  return (result.stdout as Buffer).toString('utf8');
}

export function repositoryRoot(cwd: string): string { return git(cwd, ['rev-parse', '--show-toplevel']).trim(); }

export interface CommitRecord {
  hash: string;
  display: string;
}

export function parseCommits(output: string): CommitRecord[] {
  return output.split('\0').filter(Boolean).map(record => {
    const [hash, short, date, author, subject = ''] = record.replace(/^\n/, '').split('\x1f');
    return { hash: hash ?? '', display: `${short}  ${date}  ${author}  ${subject}` };
  }).filter(commit => /^[0-9a-f]{40,64}$/.test(commit.hash));
}

export function listCommits(root: string): CommitRecord[] {
  // An unborn branch (fresh `git init`) has no HEAD; that is "no commits", not an error.
  if (spawnSync('git', ['rev-parse', '--verify', '--quiet', 'HEAD'], { cwd: root }).status !== 0) return [];
  // -z separates commits with NUL; \x1f separates fields. Subjects stay single-line.
  return parseCommits(git(root, ['log', '-z', `--max-count=${MAX_COMMITS}`, '--date=short', '--format=%H%x1f%h%x1f%ad%x1f%an%x1f%s']));
}

// Merge commits are compared with their first parent, root commits with the empty tree.
export function commitBase(root: string, hash: string): string {
  const parents = git(root, ['rev-list', '--parents', '-n', '1', hash]).trim().split(/\s+/).slice(1);
  if (parents.length) return parents[0]!;
  return spawnSync('git', ['hash-object', '-t', 'tree', '--stdin'], { cwd: root, input: '', encoding: 'utf8' }).stdout!.trim();
}

export interface GitFileRecord {
  paths: string[];
  display: string;
}

// `git diff --numstat -z`: "add\tdel\tpath\0", or for renames/copies "add\tdel\t\0old\0new\0".
export function parseNumstat(output: string): GitFileRecord[] {
  const fields = output.split('\0');
  const files: GitFileRecord[] = [];
  for (let i = 0; i < fields.length; i++) {
    const match = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(fields[i] ?? '');
    if (!match) continue;
    const added = match[1];
    const deleted = match[2];
    const single = match[3];
    if (added === undefined || deleted === undefined) continue;
    const paths = single ? [single] : [fields[++i], fields[++i]];
    if (paths.some(p => p === undefined)) break;
    const binary = added === '-';
    const label = paths.length === 2 ? `${paths[0]} → ${paths[1]}` : paths[0];
    files.push({ paths: paths as string[], display: `${binary ? '   bin   ' : `+${added} -${deleted}`.padEnd(9)}  ${label}` });
  }
  return files;
}

export function listFiles(root: string, base: string, hash: string): GitFileRecord[] {
  return parseNumstat(git(root, ['diff', '--numstat', '-z', '-M', '--no-ext-diff', base, hash]));
}

interface PreviewState {
  kind: 'commits' | 'files';
  hashes?: string[];
  base?: string;
  hash?: string;
  paths?: string[][];
}

function writeState(file: string, state: PreviewState): void { fs.writeFileSync(file, JSON.stringify(state), { mode: 0o600 }); }
function previewCommand(statePath: string): string { return `${shellQuote(process.execPath)} ${shellQuote(previewScript)} ${shellQuote(statePath)} {1}`; }

export function pagerCommand(): string {
  return spawnSync('/bin/sh', ['-c', 'command -v delta']).status === 0 ? 'delta --paging=always' : 'less -R';
}

function pagerEnv(pager: string): NodeJS.ProcessEnv {
  // LESS without F: never quit immediately on a short diff; the user leaves with q.
  return { ...process.env, ...gitEnv, LESS: '-R', LESSSECURE: '1', GIT_PAGER: pager, DELTA_PAGER: 'less -R' };
}

function pagerArgs(base: string, hash: string, paths: string[]): { args: string[]; env: NodeJS.ProcessEnv } {
  // -c pager.diff wins over a user's own pager.diff (including "false") for this command only.
  const pager = pagerCommand();
  return { args: ['-c', `pager.diff=${pager}`, '--paginate', 'diff', '--no-ext-diff', '-M', base, hash, '--', ...paths], env: pagerEnv(pager) };
}

function writeList(file: string, items: readonly string[]): void {
  fs.writeFileSync(file, items.map((item, i) => `${i}\t${cleanDisplay(item)}\0`).join(''), { mode: 0o600 });
}

interface CommitFiles {
  hash: string;
  base: string;
  files: GitFileRecord[];
}

export interface BrowseSplitOptions {
  root: string;
  directory: string;
  view: TerminalOverlay;
  setFooter?: (text: string) => void;
  cancelled?: () => boolean;
  commits?: CommitRecord[];
  debounceMs?: number;
}

// Split view: commits (left, a long-running fzf) and the focused commit's files (right, an fzf with
// the file diff as its preview). The left fzf reports its cursor through execute-silent into a
// private file; the right fzf is replaced whenever that changes. No fzf --listen server is used.
export function browseLogSplit({ root, directory, view, setFooter = () => {}, cancelled = () => false, commits = listCommits(root), debounceMs = 80 }: BrowseSplitOptions): Promise<{ empty: true } | null> {
  if (!commits.length) return Promise.resolve({ empty: true });
  const left = view.pane('left'), right = view.pane('right');
  const focusLog = path.join(directory, 'focus.log');
  const commitList = path.join(directory, 'commits.list');
  fs.writeFileSync(focusLog, '', { mode: 0o600 });
  writeList(commitList, commits.map(c => c.display));
  const report = `execute-silent(printf '%s\\n' {1} >> ${shellQuote(focusLog)})`;
  const leftCommand = ['exec fzf --read0 --no-multi --no-mouse --layout=reverse --border=none --info=inline',
    `--delimiter=${shellQuote('\\t')} --with-nth=2.. --prompt=${shellQuote('Commit > ')}`,
    `--bind=${shellQuote(`start:${report}`)} --bind=${shellQuote(`focus:${report}`)}`,
    `< ${shellQuote(commitList)}`].join(' ');
  const filesCache = new Map<number, CommitFiles>();
  const filesOf = (index: number): CommitFiles => {
    const cached = filesCache.get(index);
    if (cached) return cached;
    const { hash } = commits[index]!;
    const base = commitBase(root, hash);
    const entry = { hash, base, files: listFiles(root, base, hash) };
    filesCache.set(index, entry);
    return entry;
  };

  return new Promise((resolve, reject) => {
    let closed = false, current = -1, offset = 0, pager = false;
    let timer: ReturnType<typeof setInterval> | null = null;
    let debounce: ReturnType<typeof setTimeout> | null = null;
    let rightView: { index?: number; query: string; position: number } = { query: '', position: 0 };
    const footers: Record<'left' | 'right', string> = {
      left: ' Tab/Enter: 파일 목록 · Esc: 닫기 ',
      right: ' Enter: diff 보기 · Tab/Esc: 커밋 목록 ',
    };
    const focus = (name: 'left' | 'right') => { view.focusPane(name); setFooter(footers[name]); };
    const close = (value: { empty: true } | null, error?: unknown) => {
      if (closed) return;
      closed = true;
      clearInterval(timer ?? undefined); clearTimeout(debounce ?? undefined);
      view.keyHandler = null;
      left.stop(); right.stop();
      error ? reject(error) : resolve(value);
    };
    // Any failure (sync or async) ends the session with an error instead of an unhandled rejection.
    const guard = <A extends unknown[], R>(fn: (...args: A) => R) => (...args: A): R | undefined => {
      try {
        const result = fn(...args);
        if (result && typeof (result as { then?: unknown }).then === 'function') {
          (result as unknown as Promise<unknown>).catch(error => close(null, error));
        }
        return result;
      } catch (error) { close(null, error); return undefined; }
    };

    let showFiles: (index: number) => void;
    showFiles = guard((index: number) => {
      if (closed || cancelled()) return;
      const { hash, base, files } = filesOf(index);
      view.paneTitles.right = ` Files · ${hash.slice(0, 7)} `;
      if (!files.length) {
        void right.run('/bin/sh', ['-c', 'printf "\\n  (변경 파일 없음)\\n"; exec sleep 2147483647']);
        return;
      }
      const listPath = path.join(directory, `files-${index}.list`);
      const statePath = path.join(directory, `files-${index}.json`);
      const outPath = path.join(directory, `files-${index}.out`);
      writeList(listPath, files.map(f => f.display));
      writeState(statePath, { kind: 'files', base, hash, paths: files.map(f => f.paths) });
      fs.writeFileSync(outPath, '', { mode: 0o600 });
      const restore = rightView.index === index ? rightView : { query: '', position: 0 };
      const command = ['exec fzf --read0 --print0 --print-query --no-multi --no-mouse --layout=reverse --border=none --info=inline',
        `--delimiter=${shellQuote('\\t')} --with-nth=2.. --prompt=${shellQuote('File > ')} --query=${shellQuote(restore.query)}`,
        `--preview=${shellQuote(previewCommand(statePath))} --preview-window=${shellQuote('down:65%:wrap')}`,
        !restore.query && restore.position > 0 ? `--bind=${shellQuote(`load:pos(${restore.position})`)}` : '',
        `< ${shellQuote(listPath)} > ${shellQuote(outPath)}`].join(' ');
      void right.run('/bin/sh', ['-c', command], fzfEnv()).then(guard(async (result) => {
        if (result.stopped || closed || cancelled()) return;
        if (result.exitCode !== 0) { focus('left'); showFiles(index); return; } // e.g. Ctrl+G inside fzf
        const picked = parseSelectResult(fs.readFileSync(outPath), files.length);
        rightView = { index, query: picked.query, position: picked.index + 1 };
        // Full-size pager on the main pane; the split panes keep running underneath.
        pager = true;
        view.setLayout('single', 'main');
        setFooter(' q: 파일 목록 ');
        const { args, env } = pagerArgs(base, hash, files[picked.index]!.paths);
        await view.pane('main').run('git', args, env);
        pager = false;
        if (closed || cancelled()) return;
        view.setLayout('split', 'right');
        focus('right');
        showFiles(index);
      }), error => close(null, error));
    });

    view.keyHandler = data => {
      if (pager) return false;
      const key = keyName(data);
      if (view.active === 'left') {
        if (key === 'escape' || key === 'ctrl+c') { close(null); return true; }
        if (key === 'tab' || key === 'enter') {
          if (current >= 0 && filesOf(current).files.length) focus('right');
          return true;
        }
        return key === 'shift+tab';
      }
      if (key === 'escape' || key === 'tab' || key === 'shift+tab' || key === 'ctrl+c') { focus('left'); return true; }
      return false;
    };

    // Follow the left cursor. Debounced so scrolling quickly doesn't spawn an fzf per row.
    timer = setInterval(guard(() => {
      if (closed) return;
      if (cancelled()) { close(null); return; }
      const data = fs.readFileSync(focusLog, 'utf8');
      if (data.length === offset) return;
      const lines = data.slice(offset).split('\n').filter(Boolean);
      offset = data.length;
      const index = Number(lines.at(-1));
      if (!Number.isInteger(index) || index < 0 || index >= commits.length || index === current) return;
      current = index;
      clearTimeout(debounce ?? undefined);
      debounce = setTimeout(() => showFiles(index), debounceMs);
    }), 30);

    view.paneTitles = { left: ' Commits ', right: ' Files ' };
    view.setLayout('split', 'left');
    focus('left');
    // The commit list ends the session when it exits for any reason (Esc is handled above).
    left.run('/bin/sh', ['-c', leftCommand], fzfEnv()).then(() => close(null), error => close(null, error));
  });
}

export interface BrowseLogOptions {
  root: string;
  directory: string;
  run: RunProgram;
  setFooter?: (text: string) => void;
  cancelled?: () => boolean;
  commits?: CommitRecord[];
}

// commit list → changed files → file diff. Esc goes one step back, q leaves the pager.
export async function browseLog({ root, directory, run, setFooter = () => {}, cancelled = () => false, commits = listCommits(root) }: BrowseLogOptions): Promise<{ empty: true } | null> {
  if (!commits.length) return { empty: true };
  const commitState = path.join(directory, 'commits.json');
  writeState(commitState, { kind: 'commits', hashes: commits.map(c => c.hash) });
  let commitView: { query: string; position: number } = { query: '', position: 0 };
  for (;;) {
    setFooter(' Enter: 변경 파일 · Esc: 닫기 ');
    const commit: FzfSelection | null = await fzfSelect({ run, directory, name: 'commits', items: commits.map(c => c.display), prompt: 'Commit > ',
      preview: previewCommand(commitState), ...commitView });
    if (!commit || cancelled()) return null;
    commitView = { query: commit.query, position: commit.index + 1 };
    const { hash } = commits[commit.index]!;
    const base = commitBase(root, hash);
    const files = listFiles(root, base, hash);
    if (!files.length) continue; // e.g. empty commit: stay on the commit list
    const fileState = path.join(directory, 'files.json');
    writeState(fileState, { kind: 'files', base, hash, paths: files.map(f => f.paths) });
    let fileView: { query: string; position: number } = { query: '', position: 0 };
    for (;;) {
      setFooter(' Enter: diff 보기 (q: 돌아가기) · Esc: 커밋 목록 ');
      const file = await fzfSelect({ run, directory, name: 'files', items: files.map(f => f.display), prompt: `${hash.slice(0, 7)} > `,
        preview: previewCommand(fileState), ...fileView });
      if (cancelled()) return null;
      if (!file) break;
      fileView = { query: file.query, position: file.index + 1 };
      setFooter(' q: 파일 목록 ');
      const { args, env } = pagerArgs(base, hash, files[file.index]!.paths);
      await run('git', args, env);
      if (cancelled()) return null;
    }
  }
}
