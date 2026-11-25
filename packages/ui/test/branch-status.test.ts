import test from 'node:test';
import assert from 'node:assert/strict';
import type { BranchPulls, PullRef } from '@calliopi/core/pr-lookup';
import { describePulls, formatStatus, pollDelay } from '#lib/branch-status.ts';

const pr = (number: number, state: PullRef['state'], repo = 'them/r'): PullRef => ({
  repo, number, state, url: `https://github.com/${repo}/pull/${number}`,
  headRepo: 'me/r', headRef: 'feat/x', baseRef: 'main', updatedAt: '',
});
const result = (pulls: PullRef[], ahead?: number): BranchPulls => ({ branch: 'feat/x', head: 'h', pulls, ahead });

test('the status shows only for a branch in a PR: onto owner/repo#N state', () => {
  assert.equal(formatStatus(undefined), undefined);
  assert.equal(formatStatus(result([])), undefined);
  assert.equal(formatStatus(result([pr(4, 'open')])), 'onto them/r#4 open');
  assert.equal(formatStatus(result([pr(4, 'merged')])), 'onto them/r#4 merged');
  assert.equal(formatStatus(result([pr(12, 'open'), pr(3, 'closed', 'me/r')], 2)), 'onto them/r#12 open +1 ↑2');
});

test('the reference carries the PR link and the state its own paint', () => {
  const seen: string[] = [];
  const text = formatStatus(result([pr(4, 'draft')]), {
    dim: (s) => s, ref: (s, url) => { seen.push(url); return `[${s}]`; }, state: (s, state) => `<${state}>`,
  });
  assert.equal(text, 'onto [them/r#4] <draft>');
  assert.deepEqual(seen, ['https://github.com/them/r/pull/4']);
});

test('only open and draft PRs are polled', () => {
  assert.equal(pollDelay(result([pr(1, 'open')]), 60), 60_000);
  assert.equal(pollDelay(result([pr(1, 'merged'), pr(2, 'draft')]), 30), 30_000);
  assert.equal(pollDelay(result([pr(1, 'merged'), pr(2, 'closed')]), 60), undefined);
  assert.equal(pollDelay(undefined, 60), undefined);
});

test('/cl-branch lists every PR with its link', () => {
  assert.match(describePulls(undefined), /저장소가 아니거나/);
  assert.equal(describePulls(result([])), 'feat/x: 연결된 PR이 없습니다.');
  assert.equal(describePulls(result([pr(4, 'open')], 1)),
    'feat/x ↑1\n  them/r#4 open  me/r:feat/x → main  https://github.com/them/r/pull/4');
});
