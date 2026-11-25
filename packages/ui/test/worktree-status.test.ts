import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { capture } from '@calliopi/core/capture';
import { WORKTREE_ARGS, describeWorktree, formatWorktree, isClean, parseWorktree } from '#lib/worktree-status.ts';

const counts = (conflicted: number, staged: number, modified: number, untracked: number) => ({ conflicted, staged, modified, untracked });

test('porcelain v2 entries are counted by kind; a rename skips its original path', () => {
  const out = [
    '1 M. N... 100644 100644 100644 a a staged.ts',
    '1 .M N... 100644 100644 100644 a a modified.ts',
    '1 MM N... 100644 100644 100644 a a both.ts',
    '1 A. N... 000000 100644 100644 0 a added.ts',
    '2 R. N... 100644 100644 100644 a a R100 new name.ts',
    '? looks like an entry.ts', // original path of the rename: must not count as untracked
    'u UU N... 100644 100644 100644 100644 a b c conflict.ts',
    '? untracked.ts',
    '',
  ].join('\0');
  assert.deepEqual(parseWorktree(out), counts(1, 4, 2, 1));
  assert.deepEqual(parseWorktree(''), counts(0, 0, 0, 0));
  assert.ok(isClean(parseWorktree('')));
});

test('the footer text leaves out zeros and is empty when clean', () => {
  assert.equal(formatWorktree(undefined), undefined);
  assert.equal(formatWorktree(counts(0, 0, 0, 0)), undefined);
  assert.equal(formatWorktree(counts(1, 2, 3, 4)), '✖1 +2 ~3 ?4');
  assert.equal(formatWorktree(counts(0, 0, 3, 0)), '~3');
  assert.equal(formatWorktree(counts(0, 2, 0, 1), (s, kind) => `<${kind}:${s}>`), '<staged:+2> <untracked:?1>');
});

test('/cl-branch describes the working tree', () => {
  assert.equal(describeWorktree(undefined), '작업 트리: 알 수 없음');
  assert.equal(describeWorktree(counts(0, 0, 0, 0)), '작업 트리: 깨끗함');
  assert.equal(describeWorktree(counts(0, 1, 2, 0)), '작업 트리: 스테이징 1, 수정 2');
});

test('real git: counts follow edits, staging, renames with spaces and new files', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'calliopi-worktree-'));
  try {
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'test');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
    fs.writeFileSync(path.join(dir, 'b.txt'), 'b\n');
    git('add', '.');
    git('commit', '-qm', 'init');

    const read = async () => {
      const r = await capture()('git', WORKTREE_ARGS, { cwd: dir });
      assert.equal(r.code, 0, r.stderr);
      return parseWorktree(r.stdout);
    };
    assert.deepEqual(await read(), counts(0, 0, 0, 0));

    fs.writeFileSync(path.join(dir, 'a.txt'), 'a2\n');
    git('add', 'a.txt');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'a3\n'); // staged and changed again
    git('mv', 'b.txt', 'b renamed.txt');
    fs.writeFileSync(path.join(dir, 'new file.txt'), 'n\n');
    assert.deepEqual(await read(), counts(0, 2, 1, 1));
    assert.equal(formatWorktree(await read()), '+2 ~1 ?1');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
