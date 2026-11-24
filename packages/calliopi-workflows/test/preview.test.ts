import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseBranches, listBranches, diffFile, mergeBase, changedSince, defaultBase, nearestBranch, parentBranch } from '#lib/preview-git.ts';
import { batVersionOk, fitAnsi, renderDiff, renderFile, stripAnsi, visibleWidth, wrapPlain } from '#lib/preview-render.ts';
import { find, frame, keyMap, parseInput, scroll, type ViewerState } from '#lib/preview-viewer.ts';
import { drainShares, shareMessage, writeShare } from '#lib/preview-share.ts';
import { renderTarget, rootRelative } from '#lib/preview-pane.ts';

const plainTools = { bat: false, delta: false };

function repo(t: TestContext) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'calliopi-preview-test-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let tick = 0;
  const g = (...args: string[]) => {
    const date = `2026-01-0${1 + Math.min(8, tick++)}T00:00:00Z`; // increasing commit dates for a stable branch order
    const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout;
  };
  g('init', '-q', '-b', 'main'); g('config', 'user.name', 't'); g('config', 'user.email', 't@e'); g('config', 'commit.gpgsign', 'false');
  return { dir, g, write: (f: string, s: string) => fs.writeFileSync(path.join(dir, f), s) };
}

// main: a.txt 1/2/3 → feature branches off → main changes line 3 → on feature, line 1 edited (uncommitted).
function diverged(t: TestContext) {
  const r = repo(t);
  r.write('a.txt', '1\n2\n3\n'); r.g('add', '.'); r.g('commit', '-qm', 'base');
  r.g('branch', 'feature');
  r.write('a.txt', '1\n2\n3main\n'); r.g('commit', '-qam', 'main moves on');
  r.g('checkout', '-q', 'feature');
  r.write('a.txt', '1mine\n2\n3\n');
  return r;
}

test('branches: newest first, current marked, remote HEAD alias dropped', () => {
  const parsed = parseBranches([
    'refs/heads/feature\x1ffeature\x1f1 hour ago\x1f*', 'refs/remotes/origin/HEAD\x1forigin\x1f2 days ago\x1f ',
    'refs/remotes/origin/main\x1forigin/main\x1f2 days ago\x1f ', 'refs/tags/v1\x1fv1\x1fnow\x1f ',
  ].join('\n'));
  assert.deepEqual(parsed.map(b => [b.name, b.current, b.remote]), [['feature', true, false], ['origin/main', false, true]]);
  assert.match(parsed[1]!.display, /원격/);
});

test('changed since divergence: committed, uncommitted and untracked; not main\'s side or ignored; cwd-relative', t => {
  const { dir, g, write } = diverged(t);
  assert.equal(defaultBase(dir), 'main');
  fs.mkdirSync(path.join(dir, 'sub'));
  write('sub/committed.txt', 'x\n'); g('add', '.'); g('commit', '-qm', 'feature work');
  write('sub/new.txt', 'y\n'); write('.gitignore', 'ignored.txt\n'); write('ignored.txt', 'z\n');
  assert.deepEqual([...changedSince(dir, 'main')!].sort(), ['.gitignore', 'a.txt', 'sub/committed.txt', 'sub/new.txt']);
  assert.deepEqual([...changedSince(path.join(dir, 'sub'), 'main')!].sort(), ['committed.txt', 'new.txt']);
  g('checkout', '-q', '--orphan', 'lonely'); g('rm', '-rqf', '.'); write('l.txt', 'l\n'); g('add', 'l.txt'); g('commit', '-qm', 'unrelated');
  assert.equal(changedSince(dir, 'main'), null);
});

test('parent branch: nearest branch whose tip HEAD grew from; siblings, children and own remote copy skipped', t => {
  const b = (name: string, ahead: number, behind: number, current = false) => ({ name, ahead, behind, current });
  assert.equal(nearestBranch([b('main', 0, 3), b('dev', 0, 1), b('me', 0, 0, true)], 'main'), 'dev');
  assert.equal(nearestBranch([b('main', 16, 1), b('sibling', 1, 1)], 'main'), null); // moved on: not guessed
  assert.equal(nearestBranch([b('main', 0, 0), b('child', 2, 0)], 'main'), 'main');
  assert.equal(nearestBranch([b('sibling', 0, 0), b('main', 0, 0)], 'main'), 'main'); // tie: preferred

  const { dir, g, write } = diverged(t); // feature (current) left main, which moved on since
  assert.equal(parentBranch(dir), 'main'); // fallback: the default branch
  g('stash', '-q'); g('checkout', '-q', 'main'); g('checkout', '-qb', 'dev');
  write('d.txt', 'd\n'); g('add', '.'); g('commit', '-qm', 'dev work');
  g('checkout', '-qb', 'topic'); write('t.txt', 't\n'); g('add', '.'); g('commit', '-qm', 'topic work');
  g('checkout', '-qb', 'topic-child'); write('c.txt', 'c\n'); g('add', '.'); g('commit', '-qm', 'child');
  g('checkout', '-q', 'topic'); g('branch', 'sibling'); g('checkout', '-q', 'sibling'); write('s.txt', 's\n'); g('add', '.'); g('commit', '-qm', 'sib');
  g('checkout', '-q', 'topic');
  assert.equal(parentBranch(dir), 'dev'); // not main (farther), topic-child (grew from here) or sibling
  assert.deepEqual([...changedSince(dir, 'dev')!], ['t.txt']);
  // A stale local branch loses to its fresher remote copy; the current branch's own remote copy is skipped.
  g('update-ref', 'refs/remotes/origin/dev', 'HEAD~1'); g('update-ref', 'refs/remotes/origin/topic', 'HEAD');
  g('update-ref', 'refs/heads/dev', 'HEAD~2');
  write('t2.txt', 'u\n'); g('add', '.'); g('commit', '-qm', 'unpushed');
  assert.equal(parentBranch(dir), 'origin/dev');
  assert.equal(changedSince(dir, '--output=x'), null);
});

test('since-divergence diff shows only my side, uncommitted edits included; tip mode mixes both', t => {
  const { dir } = diverged(t);
  assert.deepEqual(listBranches(dir).map(b => [b.name, b.current]), [['main', false], ['feature', true]]);
  const base = diffFile(dir, 'a.txt', 'main', 'base');
  assert.equal(base.status, 'changed');
  if (base.status !== 'changed') return;
  assert.equal(base.base, mergeBase(dir, 'main'));
  assert.match(base.text, /^--- a\/a\.txt\n\+\+\+ b\/a\.txt$/m);
  assert.match(base.text, /^-1\n\+1mine$/m);
  assert.doesNotMatch(base.text, /3main/);
  const tip = diffFile(dir, 'a.txt', 'main', 'tip');
  assert.ok(tip.status === 'changed' && /^-3main\n\+3$/m.test(tip.text));
});

test('new, deleted, unchanged, binary files and unrelated histories', t => {
  const { dir, g, write } = diverged(t);
  write('new.txt', 'hello\n');
  const added = diffFile(dir, 'new.txt', 'main', 'base');
  assert.ok(added.status === 'changed' && /^--- \/dev\/null\n\+\+\+ b\/new\.txt$/m.test(added.text));
  fs.rmSync(path.join(dir, 'a.txt'));
  const deleted = diffFile(dir, 'a.txt', 'main', 'base');
  assert.ok(deleted.status === 'changed' && /^\+\+\+ \/dev\/null$/m.test(deleted.text));
  g('checkout', '-q', '--', 'a.txt');
  assert.equal(diffFile(dir, 'a.txt', 'main', 'base').status, 'same');
  write('bin.dat', 'a\0b'); g('add', 'bin.dat'); g('commit', '-qm', 'bin');
  write('bin.dat', 'a\0c');
  assert.equal(diffFile(dir, 'bin.dat', 'HEAD', 'base').status, 'binary');
  assert.equal(diffFile(dir, 'nope.txt', 'main', 'base').status, 'missing');
  g('checkout', '-q', '--orphan', 'lonely'); g('commit', '-qm', 'orphan', '--allow-empty');
  assert.equal(diffFile(dir, 'a.txt', 'main', 'base').status, 'no-base');
  assert.equal(diffFile(dir, 'a.txt', 'main', 'tip').status !== 'no-base', true);
});

test('paths are made root-relative through symlinks; targets render a file or explain the result', t => {
  const { dir, g, write } = diverged(t);
  fs.mkdirSync(path.join(dir, 'sub')); write('sub/b.txt', 'x\n');
  assert.equal(rootRelative(dir, path.join(dir, 'sub'), 'b.txt'), 'sub/b.txt');
  const view = renderTarget({ cwd: dir, root: dir }, 'a.txt', { mode: 'view' }, 40, plainTools);
  assert.deepEqual(view.lines.map(stripAnsi), ['1 1mine', '2 2', '3 3']);
  const diff = renderTarget({ cwd: dir, root: dir }, 'a.txt', { mode: 'base', ref: 'main' }, 40, plainTools);
  assert.ok(diff.share?.includes('+1mine'));
  assert.ok(diff.lines.some(l => l.includes('\x1b[32m+1mine')));
  const added = renderTarget({ cwd: dir, root: dir }, 'sub/b.txt', { mode: 'base', ref: 'main' }, 40, plainTools);
  assert.ok(added.share?.includes('+++ b/sub/b.txt')); // untracked: new since the branch point
  g('checkout', '-q', '--', 'a.txt');
  const same = renderTarget({ cwd: dir, root: dir }, 'a.txt', { mode: 'base', ref: 'main' }, 40, plainTools);
  assert.match(same.lines[0]!, /^\(변경 없음: main에서 갈라진 지점 대비\)$/);
  assert.equal(same.share, null);
});

test('width handling: ANSI kept, Korean counts two cells, plain text wraps by cells', () => {
  assert.equal(visibleWidth('\x1b[31m한글a\x1b[0m'), 5);
  assert.equal(fitAnsi('\x1b[31m한글abc', 4), '\x1b[31m한글\x1b[0m');
  assert.equal(fitAnsi('plain text', 5), 'plain');
  assert.deepEqual(wrapPlain('abcdef\tx', 4), ['abcd', 'ef  ', '  x']);
  assert.deepEqual(wrapPlain('가나다', 4), ['가나', '다']);
  assert.ok(batVersionOk('bat 0.13.0') && batVersionOk('bat 1.0.0') && !batVersionOk('bat 0.12.1'));
  const lines = renderDiff('--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n', 20, plainTools);
  assert.deepEqual(lines.map(stripAnsi), ['--- a/x', '+++ b/x', '@@ -1 +1 @@', '-old', '+new']);
  assert.deepEqual(renderFile('/x', 10, plainTools, () => null), ['(바이너리이거나 1 MiB를 넘는 파일이라 표시하지 않습니다)']);
});

test('viewer: scrolling clamps, search wraps with smart case, frame fills the screen', () => {
  const s: ViewerState = { lines: Array.from({ length: 50 }, (_, i) => `line ${i}${i === 30 ? ' Needle' : ''}`), offset: 0, query: '', prompt: null };
  scroll(s, -5, 10); assert.equal(s.offset, 0);
  scroll(s, 1000, 10); assert.equal(s.offset, 42); // 50 lines, 8 body rows
  assert.equal(find(s, 'needle', 0, 1), 30);
  assert.equal(find(s, 'Needle', 40, 1), 30); // wraps around
  assert.equal(find(s, 'NEEDLE', 0, 1), -1); // uppercase query is case-sensitive
  s.offset = 0;
  const keys = [{ key: 'b', label: '브랜치' }, { key: 'q', label: '닫기' }];
  const screen = frame(s, 20, 10, ' left', 'right ', keys);
  const rows = screen.split('\r\n');
  assert.equal(rows.length, 10);
  assert.match(rows[8]!, /^\x1b\[7m left {9}right \x1b\[0m/);
  assert.equal(stripAnsi(rows[9]!), ' b  브랜치  q  닫기 ');
  // Wide characters are padded by cells: the bars never exceed the width (that would scroll the screen).
  for (const left of [' 파일 · 갈라진 뒤', ' 아주 긴 한글 상태 표시줄 텍스트입니다']) {
    assert.equal(visibleWidth(frame(s, 20, 10, left, '휠 ').split('\r\n')[8]!), 20);
  }
  s.prompt = 'nee';
  assert.match(frame(s, 20, 10, ' left', 'right ').split('\r\n')[8]!, /\/nee/);
});

test('key map: hints that do not fit are dropped whole, row padded to the width', () => {
  const keys = [{ key: 'b', label: '브랜치와 비교' }, { key: 's', label: '대화로' }, { key: 'q', label: '닫기' }];
  const row = keyMap(keys, 30);
  assert.equal(stripAnsi(row), ' b  브랜치와 비교  s  대화로  ');
  assert.equal(visibleWidth(row), 30);
  assert.equal(visibleWidth(keyMap(keys, 5)), 5); // nothing fits: blank row
});

test('input: keys, SGR wheel reports, unknown sequences dropped', () => {
  assert.deepEqual(parseInput('\x1b[A\x1b[6~j/\x1b[<64;5;5M\x1b[<65;5;5M\x1b[<0;1;1M\x1b[1;5Cq\r\x7f\x03\x1b'), [
    { kind: 'key', key: 'up' }, { kind: 'key', key: 'pagedown' }, { kind: 'key', key: 'j' }, { kind: 'key', key: '/' },
    { kind: 'wheel', delta: -1 }, { kind: 'wheel', delta: 1 }, { kind: 'key', key: 'q' },
    { kind: 'key', key: 'enter' }, { kind: 'key', key: 'backspace' }, { kind: 'key', key: 'ctrl-c' }, { kind: 'key', key: 'esc' },
  ]);
  assert.deepEqual(parseInput('한'), [{ kind: 'key', key: '한' }]);
});

test('outbox: atomic writes drained oldest first; messages respect size limits', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'calliopi-outbox-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  writeShare(dir, { file: 'a', mode: 'view', text: 'one' });
  writeShare(dir, { file: 'b', mode: 'base', ref: 'main', base: 'abc', text: '+x' });
  fs.writeFileSync(path.join(dir, '.partial.tmp'), '{');
  assert.deepEqual(drainShares(dir).map(s => s.file), ['a', 'b']);
  assert.deepEqual(drainShares(dir), []);
  assert.deepEqual(fs.readdirSync(dir), ['.partial.tmp']);
  assert.match(shareMessage({ file: 'a.ts', mode: 'base', ref: 'main', base: '0123456789abcdef', text: '+x' }), /since diverging from main \(merge-base 0123456789ab\)[\s\S]*<preview-diff>\n\+x\n<\/preview-diff>$/);
  assert.match(shareMessage({ file: 'a.ts', mode: 'view', text: 'x\n'.repeat(500) }), /Content omitted/);
});
