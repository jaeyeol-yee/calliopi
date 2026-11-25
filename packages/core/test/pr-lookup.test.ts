import { test } from 'node:test';
import assert from 'node:assert/strict';
import { capture, type Capture } from '#lib/capture.ts';
import { githubRepo, lookupPulls, parsePulls, parseRemotes, pullState, sortPulls } from '#lib/pr-lookup.ts';

test('githubRepo reads https, scp-style and ssh:// github.com URLs only', () => {
  assert.equal(githubRepo('https://github.com/o/r.git'), 'o/r');
  assert.equal(githubRepo('https://token@github.com/o/r'), 'o/r');
  assert.equal(githubRepo('git@github.com:o/r.git'), 'o/r');
  assert.equal(githubRepo('ssh://git@github.com/o/r.git'), 'o/r');
  assert.equal(githubRepo('git@gitlab.com:o/r.git'), undefined);
  assert.equal(githubRepo('https://github.com/o'), undefined);
});

test('parseRemotes keeps GitHub fetch URLs by remote name', () => {
  const remotes = parseRemotes([
    'origin\tgit@github.com:me/r.git (fetch)', 'origin\tgit@github.com:me/r.git (push)',
    'upstream\thttps://github.com/them/r (fetch)', 'gl\tgit@gitlab.com:x/y.git (fetch)',
  ].join('\n'));
  assert.deepEqual([...remotes], [['origin', 'me/r'], ['upstream', 'them/r']]);
});

test('pullState tells draft from open and merged from closed', () => {
  assert.equal(pullState({ state: 'open' }), 'open');
  assert.equal(pullState({ state: 'open', draft: true }), 'draft');
  assert.equal(pullState({ state: 'closed', merged_at: '2026-01-01T00:00:00Z' }), 'merged');
  assert.equal(pullState({ state: 'closed', merged_at: null }), 'closed');
});

const pr = (n: number, extra: Record<string, unknown> = {}) => ({
  number: n, html_url: `https://github.com/them/r/pull/${n}`, state: 'open', draft: false, merged_at: null,
  updated_at: `2026-01-0${n}T00:00:00Z`, base: { ref: 'main', repo: { full_name: 'them/r' } },
  head: { ref: 'feat/x', sha: 'h1', repo: { full_name: 'me/r' } }, ...extra,
});

test('parsePulls and sortPulls: open before draft before merged before closed, then newest', () => {
  const pulls = parsePulls(JSON.stringify([
    pr(1, { state: 'closed', merged_at: 'x' }), pr(2, { draft: true }), pr(3), pr(4), pr(5, { state: 'closed' }), { bogus: true },
  ]));
  assert.deepEqual(sortPulls(pulls).map((p) => `${p.number}:${p.state}`), ['4:open', '3:open', '2:draft', '1:merged', '5:closed']);
  assert.equal(pulls[0]!.url, 'https://github.com/them/r/pull/1');
});

/** A fake git/gh: answers by joined argv; unknown commands fail. Records gh calls. */
function fake(answers: Record<string, string | number>) {
  const calls: string[] = [];
  const run: Capture = async (command, args) => {
    const key = [command, ...args].join(' ');
    if (command === 'gh') calls.push(args.join(' '));
    const a = answers[key];
    if (a === undefined || typeof a === 'number') return { code: typeof a === 'number' ? a : 1, stdout: '', stderr: '' };
    return { code: 0, stdout: a, stderr: '' };
  };
  return { run, calls };
}

const GIT = {
  'git rev-parse HEAD': 'h2\n',
  'git symbolic-ref --short -q HEAD': 'feat/x\n',
  'git rev-parse --verify --quiet @{push}': 'h1\n',
  'git rev-parse --abbrev-ref @{push}': 'origin/feat/x\n',
  'git rev-list --count @{push}..HEAD': '1\n',
  'git remote -v': 'origin\tgit@github.com:me/r.git (fetch)\n',
};

test('lookupPulls finds a fork PR in the parent repository by the pushed commit', async () => {
  const { run, calls } = fake({
    ...GIT,
    'gh api repos/me/r --jq .parent.full_name // ""': 'them/r\n',
    'gh api repos/me/r/commits/h1/pulls': '[]',
    'gh api repos/them/r/commits/h1/pulls': JSON.stringify([pr(7)]),
    'gh api repos/me/r/commits/h2/pulls': 422, // not pushed
    'gh api repos/them/r/commits/h2/pulls': 422,
  });
  const parents = new Map<string, string>();
  const result = await lookupPulls({ cwd: '/w', run, parents });
  assert.equal(result?.branch, 'feat/x');
  assert.equal(result?.ahead, 1);
  assert.deepEqual(result?.pulls.map((p) => `${p.repo}#${p.number} ${p.state}`), ['them/r#7 open']);
  assert.equal(parents.get('me/r'), 'them/r');
  await lookupPulls({ cwd: '/w', run, parents });
  assert.equal(calls.filter((c) => c.includes('--jq')).length, 1, 'the fork parent is cached');
});

test("a merge commit on main does not make main look like the merged PR's branch", async () => {
  const { run } = fake({
    'git rev-parse HEAD': 'm1\n', 'git symbolic-ref --short -q HEAD': 'main\n',
    'git rev-parse --verify --quiet @{push}': 'm1\n', 'git rev-parse --abbrev-ref @{push}': 'origin/main\n',
    'git rev-list --count @{push}..HEAD': '0\n', 'git remote -v': 'origin\tgit@github.com:me/r.git (fetch)\n',
    'gh api repos/me/r --jq .parent.full_name // ""': '\n',
    'gh api repos/me/r/commits/m1/pulls': JSON.stringify([pr(4, { state: 'closed', merged_at: 'x', head: { ref: 'feat/x', sha: 'h9', repo: { full_name: 'me/r' } } })]),
  });
  assert.deepEqual((await lookupPulls({ cwd: '/w', run }))?.pulls, []);
});

test('a renamed or deleted branch still finds its PR by head commit; outside a repository is undefined', async () => {
  const { run } = fake({
    'git rev-parse HEAD': 'h1\n', 'git remote -v': 'origin\tgit@github.com:me/r.git (fetch)\n',
    'gh api repos/me/r --jq .parent.full_name // ""': '\n',
    'gh api repos/me/r/commits/h1/pulls': JSON.stringify([pr(4, { state: 'closed', merged_at: 'x', head: { ref: 'gone', sha: 'h1', repo: { full_name: 'me/r' } } })]),
  });
  const result = await lookupPulls({ cwd: '/w', run });
  assert.equal(result?.branch, undefined, 'detached HEAD');
  assert.deepEqual(result?.pulls.map((p) => `#${p.number} ${p.state}`), ['#4 merged']);
  assert.equal(await lookupPulls({ cwd: '/w', run: fake({}).run }), undefined);
});

test('capture returns exit code and output; a missing program is -1', async () => {
  const run = capture();
  assert.deepEqual(await run('/bin/sh', ['-c', 'echo out; echo err >&2; exit 3']), { code: 3, stdout: 'out\n', stderr: 'err\n' });
  assert.equal((await run('/nonexistent/program', [])).code, -1);
  assert.equal((await run('/bin/sh', ['-c', 'pwd'], { cwd: '/' })).stdout, '/\n');
});
