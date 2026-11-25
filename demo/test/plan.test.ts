import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { addedScenarios, isRecorded, planScenarios } from '../lib/plan.ts';

function repo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'calliopi-plan-test-'));
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, env, encoding: 'utf8' }).trim();
  const write = (file: string, body: string) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), body);
  };
  const commit = (message: string) => { git('add', '-A'); git('commit', '-qm', message); return git('rev-parse', 'HEAD'); };
  git('init', '-q', '-b', 'main');
  write('README', 'base');
  const base = commit('base');
  return { root, base, git, write, commit };
}

test('an added scenario is planned until its GIF is committed', () => {
  const r = repo();
  r.write('demo/scenarios/a.yaml', 'turns: []');
  r.commit('add a');
  assert.deepEqual(addedScenarios(r.root, r.base), ['a']);
  assert.deepEqual(planScenarios(r.root, r.base), ['a']);

  r.write('assets/scenarios/a.gif', 'gif');
  r.commit('Record demo GIFs');
  assert.equal(isRecorded(r.root, 'a'), true);
  assert.deepEqual(planScenarios(r.root, r.base), [], 'the bot commit must not plan another recording');
});

test('editing a scenario after its GIF plans it again', () => {
  const r = repo();
  r.write('demo/scenarios/a.yaml', 'turns: []');
  r.write('assets/scenarios/a.gif', 'gif');
  r.commit('add a with its GIF');
  assert.deepEqual(planScenarios(r.root, r.base), [], 'committed together counts as recorded');

  r.write('demo/scenarios/a.yaml', 'turns: [1]');
  r.commit('edit a');
  assert.deepEqual(planScenarios(r.root, r.base), ['a']);
});

test('nested scenarios, renames and scenarios already on the base branch', () => {
  const r = repo();
  r.write('demo/scenarios/old.yaml', 'turns: []');
  const base = r.commit('scenario on main');
  r.write('demo/scenarios/review/loop.yaml', 'turns: []');
  r.git('mv', 'demo/scenarios/old.yaml', 'demo/scenarios/renamed.yaml');
  r.commit('add nested, rename old');
  assert.deepEqual(planScenarios(r.root, base), ['renamed', 'review/loop']);
});
