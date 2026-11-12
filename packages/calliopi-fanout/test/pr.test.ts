import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { pickPr, summarizeChecks, mergeBlockers, mergePr, askCursor, prState, REBASE_REQUEST } from '../lib/pr.ts';
import type { GhRun, PrState } from '../lib/pr.ts';

const URL1 = 'https://github.com/o/r/pull/1';
const SHA = 'a'.repeat(40);
const base: PrState = {
  url: URL1, number: 1, title: 't', state: 'OPEN', isDraft: false, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN',
  headRefName: 'cursor/x', headRefOid: SHA, baseRefName: 'main', reviewDecision: null, checks: { total: 0, failing: 0, pending: 0 },
};

test('pickPr: the one recorded PR; several need --pr; non-GitHub URLs ignored', () => {
  const agent = (urls: (string | undefined)[]) => ({ label: 'a', git: { branches: urls.map((prUrl) => ({ repoUrl: 'github.com/o/r', branch: 'b', prUrl })) } });
  assert.equal(pickPr(agent([URL1, URL1])), URL1);
  assert.throws(() => pickPr(agent([undefined])), /no pull request/);
  assert.throws(() => pickPr(agent(['https://evil.example/o/r/pull/1'])), /no pull request/);
  assert.throws(() => pickPr(agent([URL1, 'https://github.com/o/r/pull/2'])), /pass --pr/);
  assert.equal(pickPr(agent([URL1, 'https://github.com/o/r/pull/2']), URL1), URL1);
  assert.throws(() => pickPr(agent([URL1]), 'https://github.com/o/r/pull/9'), /not a PR of a/);
});

test('merge blockers: conflicts, drafts, checks, review state, still-computing mergeability', () => {
  assert.deepEqual(mergeBlockers(base), []);
  assert.deepEqual(summarizeChecks([{ conclusion: 'SUCCESS' }, { conclusion: 'FAILURE' }, { status: 'IN_PROGRESS' }]), { total: 3, failing: 1, pending: 1 });
  const all = mergeBlockers({ ...base, state: 'MERGED', isDraft: true, mergeable: 'CONFLICTING', reviewDecision: 'CHANGES_REQUESTED', checks: { total: 2, failing: 1, pending: 1 } });
  assert.equal(all.length, 6);
  assert.match(mergeBlockers({ ...base, mergeable: 'UNKNOWN' })[0], /still computing/);
});

test('mergePr pins the reviewed head; askCursor posts an @cursor comment; gh errors surface', async () => {
  const calls: string[][] = [];
  const gh: GhRun = async (args) => { calls.push(args); return { code: 0, stdout: '', stderr: '' }; };
  await mergePr(gh, URL1, SHA);
  assert.deepEqual(calls[0], ['pr', 'merge', URL1, '--squash', '--match-head-commit', SHA, '--delete-branch']);
  await assert.rejects(() => mergePr(gh, URL1, 'abc'), /full head commit SHA/);
  await askCursor(gh, URL1, '  fix the lint  ');
  assert.deepEqual(calls[1], ['pr', 'comment', URL1, '--body', '@cursor fix the lint']);
  await assert.rejects(() => askCursor(gh, URL1, ' '), /empty request/);
  const failing: GhRun = async () => ({ code: 1, stdout: '', stderr: 'Head branch was modified' });
  await assert.rejects(() => mergePr(failing, URL1, SHA), /Head branch was modified/);
  assert.match(REBASE_REQUEST('main'), /rebase this branch onto the latest `main`[\s\S]*package-lock\.json/);
});

test('prState parses gh JSON and summarizes checks', async () => {
  const gh: GhRun = async () => ({ code: 0, stderr: '', stdout: JSON.stringify({ ...base, checks: undefined, statusCheckRollup: [{ conclusion: 'SUCCESS' }] }) });
  const s = await prState(gh, URL1);
  assert.deepEqual(s.checks, { total: 1, failing: 0, pending: 0 });
  assert.equal(s.headRefOid, SHA);
});

// ---- CLI: tracker pr / merge / fix against a fake `gh` on PATH (no network, no GitHub writes)
const TRACKER = fileURLToPath(new URL('../bin/tracker.ts', import.meta.url));
function run(dir: string, args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [TRACKER, '--dir', dir, ...args], { env: { ...process.env, ...env } });
    let stdout = '', stderr = '';
    p.stdout.on('data', (d) => { stdout += d; });
    p.stderr.on('data', (d) => { stderr += d; });
    p.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('tracker merge/fix: dry run needs --yes, head must match, conflicts block, @cursor comment posted', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'calliopi-pr-'));
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'calliopi-gh-'));
  t.after(() => { fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(bin, { recursive: true, force: true }); });
  const log = path.join(bin, 'calls.log');
  const state = path.join(bin, 'state.json');
  fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nif [ "$1 $2" = "pr view" ]; then cat '${state}'; fi\n`, { mode: 0o755 });
  const setState = (s: Partial<PrState>) => fs.writeFileSync(state, JSON.stringify({ ...base, ...s, checks: undefined, statusCheckRollup: [] }));
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : []);
  fs.writeFileSync(path.join(dir, 'registry.json'), JSON.stringify({ version: 1, meta: {}, batches: {}, agents: {
    'bc-1': { agentId: 'bc-1', label: 'task', status: 'FINISHED', runs: {}, history: [], poll: { nextAt: 0, interval: 0, unchanged: 0, lastAt: null, lastAgentUpdatedAt: null },
      git: { branches: [{ repoUrl: 'github.com/o/r', branch: 'cursor/x', prUrl: URL1 }] } },
  } }), { mode: 0o600 });
  const env = { PATH: `${bin}:${process.env.PATH}` };

  setState({});
  const view = await run(dir, ['pr', 'task'], env);
  assert.equal(view.code, 0, view.stderr);
  assert.match(view.stdout, /ready to merge/);
  assert.notEqual((await run(dir, ['merge', 'task'], env)).code, 0, 'merge without --yes refuses');
  assert.ok(!calls().some((c) => c.startsWith('pr merge')));
  const moved = await run(dir, ['merge', 'task', '--sha', 'b'.repeat(40), '--yes'], env);
  assert.match(moved.stderr, /head moved since review/);
  assert.ok(!calls().some((c) => c.startsWith('pr merge')));
  const ok = await run(dir, ['merge', 'task', '--sha', SHA, '--yes'], env);
  assert.equal(ok.code, 0, ok.stderr);
  assert.ok(calls().includes(`pr merge ${URL1} --squash --match-head-commit ${SHA} --delete-branch`));

  setState({ mergeable: 'CONFLICTING' });
  const blocked = await run(dir, ['merge', 'task', '--yes'], env);
  assert.match(blocked.stderr, /conflicts with main/);
  const fix = await run(dir, ['fix', 'task', '--rebase', '--yes'], env);
  assert.equal(fix.code, 0, fix.stderr);
  assert.ok(calls().some((c) => c.startsWith(`pr comment ${URL1} --body @cursor Please rebase this branch onto the latest \`main\``)));
});
