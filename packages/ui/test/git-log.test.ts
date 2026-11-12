import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseNumstat, parseCommits, listCommits, listFiles, commitBase, browseLog, repositoryRoot } from '#lib/git-log.ts';
import { selectCommand, parseSelectResult, fzfSelect } from '#lib/fzf.ts';
import { TerminalOverlay } from '#lib/terminal-overlay.ts';
import type { Terminal } from '@xterm/headless';

const has = (command: string) => spawnSync('/bin/sh', ['-c', 'command -v "$1"', 'sh', command]).status === 0;

function repo(t: TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'calliopi-git-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const g = (...args: string[]) => {
    const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_DATE: '2026-01-02T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-02T00:00:00Z' } });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout;
  };
  g('init', '-q', '-b', 'main'); g('config', 'user.name', '테스트'); g('config', 'user.email', 't@example.com'); g('config', 'commit.gpgsign', 'false');
  return { dir, g };
}

test('numstat -z: plain, rename, binary and names with tabs/newlines/pathspec magic', () => {
  const out = '1\t2\ta.txt\0' + '0\t0\t\0old name\0new\tname\0' + '-\t-\timg.png\0' + '3\t0\t:(top)weird\nname\0';
  const files = parseNumstat(out);
  assert.deepEqual(files.map(f => f.paths), [['a.txt'], ['old name', 'new\tname'], ['img.png'], [':(top)weird\nname']]);
  assert.match(files[0].display, /^\+1 -2/);
  assert.match(files[1].display, /old name → new\tname/);
  assert.match(files[2].display, /bin/);
});

test('commit records parse subject/author with spaces and reject non-hash junk', () => {
  const hash = 'a'.repeat(40);
  const commits = parseCommits(`${hash}\x1faaaaaaa\x1f2026-01-02\x1f김 철수\x1fFix: tabs\tand stuff\0\n${'z'.repeat(40)}\x1fx\x1fy\x1fz\x1fw\0`);
  assert.deepEqual(commits.map(c => c.hash), [hash]);
  assert.equal(commits[0].display, 'aaaaaaa  2026-01-02  김 철수  Fix: tabs\tand stuff');
});

test('fzf command hides the index column, ignores user defaults and restores cursor only without query', () => {
  const cmd = selectCommand({ listPath: "/tmp/it's", outPath: '/tmp/o', prompt: 'Commit > ', preview: 'p {1}', query: '', position: 3 });
  assert.match(cmd, /--read0 --print0 --print-query --no-multi/);
  assert.match(cmd, /--with-nth=2\.\./);
  assert.match(cmd, /load:pos\(3\)/);
  assert.match(cmd, /'\/tmp\/it'\\''s'/);
  assert.doesNotMatch(selectCommand({ listPath: 'l', outPath: 'o', prompt: '>', query: 'fix', position: 3 }), /pos\(/);
  assert.deepEqual(parseSelectResult(Buffer.from('fix\x002\tdisplay\0'), 3), { index: 2, query: 'fix' });
  for (const bad of ['q\x003\tx\0', 'q\x00-1\tx\0', 'q\x00\0', 'q\x00x\ty\0']) assert.throws(() => parseSelectResult(Buffer.from(bad), 3));
});

test('real repo: root, rename, merge first-parent; unborn branch has no commits', t => {
  const { dir, g } = repo(t);
  assert.deepEqual(listCommits(dir), []);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\ntwo\nthree\nfour\n'); g('add', '.'); g('commit', '-qm', 'root');
  g('mv', 'a.txt', 'b c.txt'); g('commit', '-qm', 'rename');
  g('checkout', '-qb', 'side'); fs.writeFileSync(path.join(dir, 'side.txt'), 's\n'); g('add', '.'); g('commit', '-qm', 'side');
  g('checkout', '-q', 'main'); fs.writeFileSync(path.join(dir, 'main.txt'), 'm\n'); g('add', '.'); g('commit', '-qm', 'main');
  g('merge', '-q', '--no-ff', '-m', 'merge side', 'side');
  const root = repositoryRoot(dir);
  const commits = listCommits(root);
  const bySubject = (subject: string) => {
    const commit = commits.find(c => c.display.endsWith(subject));
    if (!commit) throw new Error(subject);
    return commit.hash;
  };
  assert.equal(commits.length, 5);
  const rootHash = bySubject('root');
  assert.deepEqual(listFiles(root, commitBase(root, rootHash), rootHash).map(f => f.paths), [['a.txt']]);
  const renameHash = bySubject('rename');
  assert.deepEqual(listFiles(root, commitBase(root, renameHash), renameHash).map(f => f.paths), [['a.txt', 'b c.txt']]);
  const mergeHash = bySubject('merge side');
  assert.deepEqual(listFiles(root, commitBase(root, mergeHash), mergeHash).map(f => f.paths), [['side.txt']]);
});

test('navigation: commit → files → pager → back keeps query/position; Esc steps back', async t => {
  const { dir, g } = repo(t);
  fs.writeFileSync(path.join(dir, 'x.txt'), 'x\n'); fs.writeFileSync(path.join(dir, 'y.txt'), 'y\n'); g('add', '.'); g('commit', '-qm', 'two files');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'calliopi-log-flow-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const script: ReadonlyArray<readonly [string, string | null, number, RegExp?]> = [
    ['commits', 'two\x000\ttwo files\0', 0], ['files', '\x001\ty\0', 0], ['pager', null, 0],
    ['files', null, 130, /load:pos\(2\)/], ['commits', null, 130, /--query='two'/],
  ];
  const calls: string[] = [];
  const result = await browseLog({ root: repositoryRoot(dir), directory: temp, run: async (command, args) => {
    const current = script[calls.length];
    if (!current) throw new Error('unexpected call');
    const [step, output, exitCode, expect] = current;
    calls.push(step);
    if (step === 'pager') {
      assert.equal(command, 'git');
      assert.match(args[1], /^pager\.diff=/);
      assert.deepEqual(args.slice(-2), ['--', 'y.txt']);
      return { exitCode: 0 };
    }
    assert.match(args[1], new RegExp(`${step}\\.list`));
    if (expect) assert.match(args[1], expect);
    if (output) fs.writeFileSync(path.join(temp, `${step}.out`), output);
    return { exitCode };
  } });
  assert.equal(result, null);
  assert.deepEqual(calls, ['commits', 'files', 'pager', 'files', 'commits']);
});

const screen = (term: Terminal) => Array.from({ length: term.rows }, (_, y) => term.buffer.active.getLine(term.buffer.active.viewportY + y)?.translateToString(true) || '').join('\n');
const waitFor = async (predicate: () => boolean, label: string, view: { terminal: Terminal }) => {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > 8000) throw new Error(`${label}\n${screen(view.terminal)}`);
    await new Promise(r => setTimeout(r, 20));
  }
};

test('real fzf → real fzf → real pager → back → back, entirely through the overlay PTY', { timeout: 30_000 }, async t => {
  if (!['git', 'fzf', 'less'].every(has)) return t.skip('git/fzf/less required');
  const { dir, g } = repo(t);
  g('config', 'pager.diff', 'false'); // the user's own setting must not break the pager step
  fs.writeFileSync(path.join(dir, '한글 file.txt'), 'old line\n'); g('add', '.'); g('commit', '-qm', 'first');
  fs.writeFileSync(path.join(dir, '한글 file.txt'), 'new-marker line\n'); g('add', '.'); g('commit', '-qm', 'second commit');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'calliopi-log-pty-'));
  const view = new TerminalOverlay({ tui: { terminal: { columns: 120, rows: 34 }, requestRender() {} }, theme: { fg: (_n, s) => s },
    cwd: dir, ui: { CURSOR_MARKER: '', renderFakeCursor: s => s, truncateToWidth: (s, n) => s.slice(0, n).padEnd(n) } });
  view.focused = true;
  view.render(110);
  t.after(() => { view.dispose(); fs.rmSync(temp, { recursive: true, force: true }); });
  const steps: string[] = [];
  const result = await browseLog({ root: repositoryRoot(dir), directory: temp, run: async (command, args, env) => {
    const running = view.run(command, args, env);
    const step = command === 'git' ? 'pager' : /commits\.list/.test(args[1]) ? 'commits' : 'files';
    steps.push(step);
    const visits = steps.filter(s => s === step).length;
    if (step === 'commits') {
      await waitFor(() => screen(view.terminal).includes('Commit >') && screen(view.terminal).includes('second commit'), 'commit list', view);
      if (visits === 1) {
        await waitFor(() => screen(view.terminal).includes('1 file changed'), 'commit --stat preview', view);
        view.handleInput('\x1b[13u'); // Kitty Enter on the newest commit
      } else view.handleInput('\x1b[27u'); // Kitty Esc: close
    } else if (step === 'files') {
      await waitFor(() => screen(view.terminal).includes('한글 file.txt'), 'file list', view);
      if (visits === 1) {
        await waitFor(() => screen(view.terminal).includes('new-marker'), 'file diff preview', view);
        view.handleInput('\r');
      } else view.handleInput('\x1b[27u'); // back to commits
    } else {
      await waitFor(() => view.terminal.buffer.active.type === 'alternate' && screen(view.terminal).includes('new-marker'), 'pager', view);
      view.handleInput('q');
    }
    return running;
  } });
  assert.equal(result, null);
  assert.deepEqual(steps, ['commits', 'files', 'pager', 'files', 'commits']);
});

test('split view: left cursor drives right files; Tab into files, Enter → pager, q/Esc back, Esc closes', { timeout: 30_000 }, async t => {
  if (!['git', 'fzf', 'less'].every(has)) return t.skip('git/fzf/less required');
  const { dir, g } = repo(t);
  fs.writeFileSync(path.join(dir, 'older.txt'), 'older-marker\n'); g('add', '.'); g('commit', '-qm', 'older commit');
  fs.writeFileSync(path.join(dir, '한글 new.txt'), 'newer-marker\n'); g('add', '.'); g('commit', '-qm', 'newer commit');
  const { browseLogSplit } = await import('#lib/git-log.ts');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'calliopi-split-'));
  const view = new TerminalOverlay({ tui: { terminal: { columns: 140, rows: 40 }, requestRender() {} }, theme: { fg: (_n, s) => s },
    cwd: dir, ui: { CURSOR_MARKER: '', renderFakeCursor: s => s, truncateToWidth: (s, n) => s.slice(0, n).padEnd(n) } });
  view.focused = true;
  t.after(() => { view.dispose(); fs.rmSync(temp, { recursive: true, force: true }); });
  const pane = (name: string) => ({ terminal: view.pane(name).terminal });
  const footers: string[] = [];
  const done = browseLogSplit({ root: repositoryRoot(dir), directory: temp, view, setFooter: f => footers.push(f) });
  const tick = setInterval(() => view.render(130), 20); // keep pane sizes applied, like Pi's renderer
  t.after(() => clearInterval(tick));

  await waitFor(() => screen(view.pane('left').terminal).includes('newer commit'), 'left commits', pane('left'));
  await waitFor(() => screen(view.pane('right').terminal).includes('한글 new.txt') && screen(view.pane('right').terminal).includes('newer-marker'), 'right files + diff preview', pane('right'));
  assert.equal(view.active, 'left');
  view.handleInput('\x1b[57353u'); // Kitty Down: left cursor to the older commit
  await waitFor(() => screen(view.pane('right').terminal).includes('older.txt') && screen(view.pane('right').terminal).includes('older-marker'), 'right follows left', pane('right'));
  view.handleInput('\x1b[9u'); // Tab → files
  assert.equal(view.active, 'right');
  view.handleInput('\r'); // open pager
  await waitFor(() => view.layout === 'single' && screen(view.pane('main').terminal).includes('older-marker'), 'pager', pane('main'));
  view.handleInput('q');
  await waitFor(() => view.layout === 'split' && view.active === 'right' && screen(view.pane('right').terminal).includes('older.txt'), 'back to split', pane('right'));
  view.handleInput('\x1b[27u'); // Esc → commits (left fzf kept its cursor)
  assert.equal(view.active, 'left');
  const cursorRow = screen(view.pane('left').terminal).split('\n').find(line => line.includes('older commit'));
  if (!cursorRow) throw new Error('cursor row missing');
  assert.match(cursorRow, /^[>▌▍]/, 'fzf pointer stays on the older commit');
  view.handleInput('\x1b[27u'); // Esc → close
  assert.equal(await done, null);
  assert.ok(footers.some(f => /Tab\/Enter/.test(f)) && footers.some(f => /q:/.test(f)));
});
