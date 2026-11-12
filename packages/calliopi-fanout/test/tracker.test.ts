// node --test test/  — end-to-end against the mock API. No network, no paid calls.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startMock, type MockHandle } from '#test/mock-cursor.ts';

const TRACKER = fileURLToPath(new URL('../bin/tracker.ts', import.meta.url));
let mock: MockHandle;

function run(dir: string, args: string[], { env = {}, input }: { env?: NodeJS.ProcessEnv; input?: string } = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [TRACKER, '--dir', dir, ...args], {
      env: {
        ...process.env, CURSOR_API_BASE: mock.url, CURSOR_API_KEY: 'test-key', CURSOR_FANOUT_RPM: '6000',
        CURSOR_FANOUT_TICK_MS: '20', CURSOR_FANOUT_INTERVAL_SCALE: '0.001', CALLIOPI_CONFIG_DIR: path.join(os.tmpdir(), 'calliopi-no-config'), ...env,
      },
    });
    let stdout = ''; let stderr = '';
    p.stdout.on('data', (d) => { stdout += d; });
    p.stderr.on('data', (d) => { stderr += d; });
    if (input) p.stdin.end(input);
    p.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fanout-'));
const reg = (dir: string) => JSON.parse(fs.readFileSync(path.join(dir, 'registry.json'), 'utf8')) as {
  meta: { usageUnavailable?: boolean; panes?: Record<string, unknown> };
  agents: Record<string, { label?: string; status?: string; agentId?: string; runId?: string; archived?: boolean; archivedAt?: string; archivedRunId?: string; source?: string; phase?: string; fanoutKey?: string; ack?: { status: string }; history: { to?: string }[]; runs: Record<string, { result?: string; usage?: { totalTokens?: number }; usageNote?: string; gitDelta?: unknown[] }>; git?: { branches?: { prUrl?: string }[] } }>;
};
const spec = (dir: string, s: unknown) => { const f = path.join(dir, 'spec.json'); fs.writeFileSync(f, JSON.stringify(s)); return f; };

before(async () => { mock = await startMock(); });
after(async () => { await mock.close(); });

test('launch requires --yes and prints a plan only', async () => {
  const dir = tmp();
  const f = spec(dir, { batch: 'b', agents: [{ label: 'a', prompt: 'x' }] });
  const r = await run(dir, ['launch', '--spec', f]);
  assert.equal(r.code, 2);
  assert.match(r.stdout, /Re-run with --yes/);
  assert.equal(fs.existsSync(path.join(dir, 'registry.json')), false);
});

test('Cursor archive records a per-run timestamp only after explicit approval and preserves it on repeat', async t => {
  const dir = tmp();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const f = spec(dir, { batch: 'archive', agents: [{ label: 'archive-me', prompt: 'read only [script:FINISHED]' }] });
  const launched = await run(dir, ['launch', '--spec', f, '--yes', '--json']);
  assert.equal(launched.code, 0, launched.stderr);
  const id = JSON.parse(launched.stdout).results[0].agentId;
  const declined = await run(dir, ['archive', 'archive-me']);
  assert.equal(declined.code, 2);
  assert.equal(reg(dir).agents[id].archivedAt, undefined);
  const archived = await run(dir, ['archive', 'archive-me', '--yes']);
  assert.equal(archived.code, 0, archived.stderr);
  const a = reg(dir).agents[id];
  assert.equal(a.archived, true);
  assert.equal(a.archivedRunId, a.runId);
  assert.ok(Number.isFinite(Date.parse(a.archivedAt as string)));
  const repeated = await run(dir, ['archive', 'archive-me', '--yes']);
  assert.equal(repeated.code, 0, repeated.stderr);
  assert.equal(reg(dir).agents[id].archivedAt, a.archivedAt);
});

test('fan-out → watch → terminal with result, PR, usage; WAITING is not an error', async () => {
  const dir = tmp();
  const f = spec(dir, {
    batch: 'demo',
    defaults: { repo: 'https://github.com/org/repo', ref: 'main', autoCreatePR: true },
    agents: [
      { label: 'ok', prompt: 'do it [pr] [script:CREATING,RUNNING,FINISHED]' },
      { label: 'bg', prompt: 'long [script:RUNNING,WAITING_FOR_BACKGROUND_WORK,WAITING_FOR_BACKGROUND_WORK,FINISHED]' },
      { label: 'bad', prompt: 'boom [script:RUNNING,ERROR]' },
    ],
  });
  const l = await run(dir, ['launch', '--spec', f, '--yes', '--json']);
  assert.equal(l.code, 0, l.stderr);
  const created = JSON.parse(l.stdout).results;
  assert.equal(created.length, 3);
  assert.ok(created.every((c: { phase: string; agentId: string; runId: string }) => c.phase === 'created' && /^bc-/.test(c.agentId) && /^run-/.test(c.runId)));
  const st = fs.statSync(path.join(dir, 'registry.json')).mode & 0o777;
  assert.equal(st, 0o600);

  // Re-entry: same spec again creates nothing.
  const again = await run(dir, ['launch', '--spec', f, '--yes', '--json']);
  assert.equal(JSON.parse(again.stdout).toCreate, 0);

  const w = await run(dir, ['watch', '--exit-when-done']);
  assert.equal(w.code, 0, w.stdout + w.stderr);
  const r = reg(dir);
  const by = Object.fromEntries(Object.values(r.agents).map((a) => [a.label, a]));
  assert.equal(by.ok.status, 'FINISHED');
  assert.equal(by.bad.status, 'ERROR');
  assert.equal(by.bg.status, 'FINISHED');
  assert.ok(by.bg.history.some((h: { to?: string }) => h.to === 'WAITING_FOR_BACKGROUND_WORK'), 'saw WAITING');
  assert.ok(!by.bg.history.some((h: { to?: string }) => h.to === 'ERROR'), 'WAITING never mapped to ERROR');
  assert.match(by.ok.runs[by.ok.runId].result, /summary for ok/);
  assert.equal(by.ok.runs[by.ok.runId].usage.totalTokens, 200);
  assert.equal(by.ok.runs[by.ok.runId].gitDelta.length, 1);
  assert.match(by.ok.git.branches[0].prUrl, /pull/);

  const show = await run(dir, ['show', 'bad', '--json']);
  assert.equal(JSON.parse(show.stdout).exitCode, 10);
  const fol = await run(dir, ['follow', 'ok']);
  assert.equal(fol.code, 0);
  assert.match(fol.stdout, /summary for ok/);
  const folBad = await run(dir, ['follow', 'bad']);
  assert.equal(folBad.code, 10);

  const rep = await run(dir, ['report', '--json']);
  const agg = JSON.parse(rep.stdout);
  assert.equal(agg.tokens.totalTokens, 600);
  assert.equal(agg.prs.length, 1);
  assert.ok(fs.readFileSync(path.join(dir, 'cursor-cloud-dashboard.txt'), 'utf8').includes('FINISHED'));
  assert.ok(fs.existsSync(path.join(dir, 'report.md')));
});

test('crash after POST is recovered via client agentId (409 agent_id_conflict), no duplicate', async () => {
  const dir = tmp();
  const before = mock.agents.size;
  const f = spec(dir, { batch: 'crash', agents: [{ label: 'c', prompt: 'x [crash-after-create]' }] });
  const l = await run(dir, ['launch', '--spec', f, '--yes', '--json']);
  const res = JSON.parse(l.stdout).results[0];
  assert.equal(res.phase, 'created', l.stderr);
  assert.equal(mock.agents.size, before + 1, 'exactly one agent on the server');
  assert.ok(Object.values(reg(dir).agents)[0].runId);
});

test('partial failure: 400 marks create_failed, others proceed; re-run skips both', async () => {
  const dir = tmp();
  const f = spec(dir, { batch: 'pf', agents: [{ label: 'good', prompt: 'x' }, { label: 'nope', prompt: 'y [reject]' }] });
  const l = await run(dir, ['launch', '--spec', f, '--yes', '--json']);
  assert.equal(l.code, 1);
  const phases = JSON.parse(l.stdout).results.map((r: { phase: string }) => r.phase).sort();
  assert.deepEqual(phases, ['create_failed', 'created']);
  const again = JSON.parse((await run(dir, ['launch', '--spec', f, '--yes', '--json'])).stdout);
  assert.equal(again.toCreate, 0);
});

test('429 with Retry-After is honoured, usage 403 degrades gracefully', async () => {
  const m2 = await startMock({ every429: 3, usage403: true });
  const dir = tmp();
  const f = spec(dir, { batch: 'rl', agents: [1, 2, 3].map((i) => ({ label: `r${i}`, prompt: `p${i} [script:RUNNING,FINISHED]` })) });
  const env = { CURSOR_API_BASE: m2.url };
  const l = await run(dir, ['launch', '--spec', f, '--yes', '--json'], { env });
  assert.equal(l.code, 0, l.stderr);
  const t0 = Date.now();
  const w = await run(dir, ['watch', '--exit-when-done'], { env });
  assert.equal(w.code, 0, w.stdout);
  assert.ok(m2.stats.rateLimited > 0);
  assert.match(w.stdout, /429/);
  assert.ok(Date.now() - t0 >= 900, 'paused for Retry-After');
  const r = reg(dir);
  assert.equal(r.meta.usageUnavailable, true);
  assert.ok(Object.values(r.agents).every((a) => a.status === 'FINISHED' && a.runs[a.runId as string].usageNote));
  await m2.close();
});

test('add + SSE stream records result; 410 falls back to polling', async () => {
  for (const s410 of [false, true]) {
    const m = await startMock({ stream410: s410 });
    const env = { CURSOR_API_BASE: m.url };
    const dir = tmp();
    const f = spec(dir, { batch: 's', agents: [{ label: 's', prompt: 'p [script:RUNNING,RUNNING,FINISHED]' }] });
    // create through the API, then forget it locally and re-add it by id
    const l = JSON.parse((await run(dir, ['launch', '--spec', f, '--yes', '--json'], { env })).stdout).results[0];
    const dir2 = tmp();
    const add = await run(dir2, ['add', l.agentId, '--run', l.runId, '--label', 'adopted'], { env });
    assert.equal(add.code, 0);
    const s = await run(dir2, ['stream', 'adopted'], { env });
    assert.equal(s.code, 0, s.stderr);
    assert.match(s.stdout, s410 ? /falling back to GET run polling/ : /working on it/);
    const a = reg(dir2).agents[l.agentId as string];
    assert.equal(a.status, 'FINISHED');
    assert.match(a.runs[l.runId as string].result as string, /summary/);
    await m.close();
  }
});

test('follow-up run re-opens tracking; secrets never printed', async () => {
  const dir = tmp();
  const f = spec(dir, { batch: 'fu', agents: [{ label: 'f', prompt: 'p [script:RUNNING,FINISHED]' }] });
  await run(dir, ['launch', '--spec', f, '--yes']);
  await run(dir, ['watch', '--exit-when-done']);
  const no = await run(dir, ['followup', 'f', '--prompt', 'more']);
  assert.equal(no.code, 2);
  const fu = await run(dir, ['followup', 'f', '--prompt', 'more', '--yes']);
  assert.equal(fu.code, 0, fu.stderr);
  const w = await run(dir, ['watch', '--exit-when-done']);
  const a = Object.values(reg(dir).agents)[0];
  assert.equal(Object.keys(a.runs).length, 2);
  assert.equal(a.status, 'FINISHED');
  const all = fs.readdirSync(dir).map((n) => fs.readFileSync(path.join(dir, n), 'utf8')).join('') + w.stdout + fu.stdout;
  assert.ok(!all.includes('test-key'), 'api key leaked');
});

test('pi journal discovery imports ids only', async () => {
  const root = tmp();
  const sess = path.join(root, 'proj', 's1');
  fs.mkdirSync(sess, { recursive: true });
  const id = 'bc-11111111-2222-3333-4444-555555555555';
  fs.writeFileSync(path.join(sess, '.cursor-cloud-lifecycle-abc.journal'), `{"event":"created","agentId":"${id}","runId":"run-11111111-2222-3333-4444-555555555555","secretish":"zzz"}\n`, { mode: 0o600 });
  const dir = tmp();
  const r = await run(dir, ['import-pi', '--root', root, '--json']);
  assert.equal(JSON.parse(r.stdout).added, 1);
  const a = reg(dir).agents[id];
  assert.equal(a.source, 'pi-journal');
  assert.ok(!JSON.stringify(a).includes('zzz'));
});

test('stored SDK login (auth.json, apiKeyExpiresAtMs): valid works, expired refused, none → non-interactive error', async () => {
  const dir = tmp();
  const auth = path.join(dir, 'auth.json');
  const env = { CURSOR_API_KEY: '', CURSOR_SDK_AUTH_FILE: auth };
  const creds = (exp: number) => JSON.stringify({ version: 1, backendUrl: 'https://api2.cursor.sh', apiKey: 'test-key', apiKeyExpiresAtMs: exp, createdAtMs: Date.now() });
  fs.writeFileSync(auth, creds(Date.now() + 86_400_000), { mode: 0o600 });
  const ok = await run(dir, ['whoami', '--json'], { env });
  assert.equal(ok.code, 0, ok.stderr);
  assert.equal(JSON.parse(ok.stdout).userEmail, 'dev@example.com');
  assert.ok(!ok.stdout.includes('test-key'));
  fs.writeFileSync(auth, creds(Date.now() - 1000), { mode: 0o600 });
  const expired = await run(dir, ['whoami'], { env });
  assert.equal(expired.code, 4);
  assert.match(expired.stderr, /expired/);
  fs.rmSync(auth);
  const f = spec(dir, { batch: 'x', agents: [{ label: 'a', prompt: 'p' }] });
  const none = await run(dir, ['launch', '--spec', f, '--yes'], { env });
  assert.equal(none.code, 4);
  assert.match(none.stderr, /non-interactive/);
});

test('usage_limit_exceeded: nothing created, rest skipped, re-run after top-up resumes same agentIds', async () => {
  const dir = tmp();
  const f = spec(dir, { batch: 'broke', agents: [1, 2, 3].map((i) => ({ label: `b${i}`, prompt: `p${i}` })) });
  mock.mockState.broke = true;
  const before = mock.stats.byRoute['POST /v1/agents'] || 0;
  const l = await run(dir, ['launch', '--spec', f, '--yes', '--json']);
  mock.mockState.broke = false;
  assert.equal(l.code, 1);
  const res = JSON.parse(l.stdout).results;
  assert.ok(res.every((r: { phase: string }) => r.phase === 'planned'));
  assert.ok((mock.stats.byRoute['POST /v1/agents'] || 0) - before <= 3, 'stopped hammering');
  const ids = Object.values(reg(dir).agents).map((a) => a.agentId).sort();
  const again = JSON.parse((await run(dir, ['launch', '--spec', f, '--yes', '--json'])).stdout);
  assert.equal(again.results.filter((r: { phase: string }) => r.phase === 'created').length, 3);
  assert.deepEqual(Object.values(reg(dir).agents).map((a) => a.agentId).sort(), ids, 'same pre-minted agentIds');
});

test('model: auto by default, null → account default, unknown id fails before any create', async () => {
  const dir = tmp();
  let f = spec(dir, { batch: 'm1', agents: [{ label: 'a', prompt: 'p' }] });
  const plan = await run(dir, ['launch', '--spec', f]);
  assert.match(plan.stdout, /model auto \[Auto: weekly pool/);
  await run(dir, ['launch', '--spec', f, '--yes']);
  assert.deepEqual(mock.mockState.lastModel, { id: 'auto' });

  f = spec(dir, { batch: 'm2', defaults: { model: null }, agents: [{ label: 'b', prompt: 'p' }] });
  await run(dir, ['launch', '--spec', f, '--yes']);
  assert.equal(mock.mockState.lastModel, null, 'model omitted from request');

  const posts = mock.stats.byRoute['POST /v1/agents'] || 0;
  f = spec(dir, { batch: 'm3', defaults: { model: { id: 'grok-9000' } }, agents: [{ label: 'c', prompt: 'p' }, { label: 'd', prompt: 'q' }] });
  const bad = await run(dir, ['launch', '--spec', f, '--yes']);
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /unknown model id\(s\): grok-9000/);
  assert.equal(mock.stats.byRoute['POST /v1/agents'] || 0, posts, 'no create attempted');
});

test('launch --via automation: webhook POST per item, agent id from response, tracked to FINISHED; lost response is not reposted', async () => {
  const dir = tmp();
  const conf = tmp();
  fs.writeFileSync(path.join(conf, 'webhook.json'), JSON.stringify({ url: `${mock.url}/automations/webhook/auto-1`, key: 'hook-key' }), { mode: 0o600 });
  const env = { CALLIOPI_CONFIG_DIR: conf };
  const f = spec(dir, { batch: 'wh', agents: [{ label: 'w1', prompt: 'a [script:RUNNING,FINISHED]' }, { label: 'w2', prompt: 'b [script:RUNNING,RUNNING,FINISHED]' }] });
  const planOut = await run(dir, ['launch', '--spec', f], { env });
  assert.match(planOut.stdout, /via automation/);
  const posts0 = mock.mockState.webhookPosts || 0;
  const l = await run(dir, ['launch', '--spec', f, '--yes', '--json'], { env });
  assert.equal(l.code, 0, l.stderr + l.stdout);
  const res = JSON.parse(l.stdout).results;
  assert.ok(res.every((r: { phase: string; agentId: string }) => r.phase === 'created' && /^bc-/.test(r.agentId)));
  assert.equal((mock.mockState.webhookPosts || 0) - posts0, 2);
  const w = await run(dir, ['watch', '--exit-when-done'], { env });
  assert.equal(w.code, 0, w.stdout);
  const r = reg(dir);
  for (const a of Object.values(r.agents)) {
    assert.equal(a.status, 'FINISHED');
    assert.match(a.runs[a.runId as string].result as string, new RegExp(`fanout_key="${a.fanoutKey}"`));
  }
  // re-run: nothing new
  assert.equal(JSON.parse((await run(dir, ['launch', '--spec', f, '--yes', '--json'], { env })).stdout).toCreate, 0);
  // lost response → post_ambiguous, and NOT reposted on the next launch
  mock.mockState.webhookFail = true;
  const f2 = spec(dir, { batch: 'wh2', agents: [{ label: 'lost', prompt: 'x' }] });
  const l2 = JSON.parse((await run(dir, ['launch', '--spec', f2, '--yes', '--json'], { env })).stdout);
  mock.mockState.webhookFail = false;
  assert.equal(l2.results[0].phase, 'post_ambiguous');
  const before = mock.mockState.webhookPosts;
  const l3 = JSON.parse((await run(dir, ['launch', '--spec', f2, '--yes', '--json'], { env })).stdout);
  assert.equal(l3.toCreate, 0);
  assert.equal(mock.mockState.webhookPosts, before, 'ambiguous item not reposted');
});

test('automation guards: launch refuses on config drift; apply refuses while posting or when the server drifted', async () => {
  const dir = tmp(); const conf = tmp();
  fs.writeFileSync(path.join(conf, 'webhook.json'), JSON.stringify({ url: `${mock.url}/automations/webhook/auto-1`, key: 'hook-key' }), { mode: 0o600 });
  const env = { CALLIOPI_CONFIG_DIR: conf, CURSOR_ENDPOINT: mock.url };
  mock.mockState.automation = null; mock.mockState.updates = 0;
  // adopt: records the server config as expected (read-only)
  fs.writeFileSync(path.join(conf, 'automation.json'), JSON.stringify({ automationId: 'auto-1', name: 'CallioPiAutomation' }), { mode: 0o600 });
  const ad = await run(dir, ['automation', 'adopt'], { env });
  assert.equal(ad.code, 0, ad.stderr);
  assert.equal(mock.mockState.updates, 0, 'adopt never writes');
  const f = spec(dir, { batch: 'g', agents: [{ label: 'g1', prompt: 'x [script:RUNNING,FINISHED]' }] });
  assert.equal((await run(dir, ['launch', '--spec', f, '--yes', '--json'], { env })).code, 0);
  const swaps = mock.mockState.updates!; // launch stages/restores the prompt; apply must not add writes below
  // someone edits the automation in the UI (model/repo/triggers; the prompt belongs to launch) → launch refuses, nothing posted
  mock.mockState.automation!.workflow.modelSelection = { modelId: 'edited-in-ui' };
  const posts = mock.mockState.webhookPosts;
  const f2 = spec(dir, { batch: 'g2', agents: [{ label: 'g2', prompt: 'y' }] });
  const drift = await run(dir, ['launch', '--spec', f2, '--yes'], { env });
  assert.equal(drift.code, 2); assert.match(drift.stderr, /changed outside the harness/);
  assert.equal(mock.mockState.webhookPosts, posts);
  // apply refuses to overwrite the foreign edit without --force
  const ap = await run(dir, ['automation', 'apply', '--yes'], { env });
  assert.equal(ap.code, 2); assert.match(ap.stderr, /server config changed/);
  assert.equal(mock.mockState.updates, swaps);
  // apply refuses while a fan-out is posting (in-flight lock held by a live pid)
  fs.writeFileSync(path.join(conf, 'automation.inflight'), String(process.pid));
  const busy = await run(dir, ['automation', 'apply', '--yes', '--force'], { env });
  assert.equal(busy.code, 2); assert.match(busy.stderr, /posting webhooks/);
  fs.rmSync(path.join(conf, 'automation.inflight'));
  // explicit --force applies, records the new fingerprint, launch works again
  assert.equal((await run(dir, ['automation', 'apply', '--yes', '--force'], { env })).code, 0);
  assert.equal(mock.mockState.updates, swaps + 1);
  assert.equal((await run(dir, ['launch', '--spec', f2, '--yes', '--json'], { env })).code, 0);
});

test('automation prompt swap: each task is staged before its POST, acked, and the idle prompt restored', async () => {
  const dir = tmp(); const conf = tmp();
  fs.writeFileSync(path.join(conf, 'webhook.json'), JSON.stringify({ url: `${mock.url}/automations/webhook/auto-1`, key: 'hook-key' }), { mode: 0o600 });
  const env = { CALLIOPI_CONFIG_DIR: conf, CURSOR_ENDPOINT: mock.url };
  Object.assign(mock.mockState, { automation: null, updates: 0, promptsAtPost: [], forcePromptKey: undefined, noAck: false, updateFail: false });
  // A pre-swap install: fingerprint recorded with the legacy algorithm (prompt text included) still matches once.
  fs.writeFileSync(path.join(conf, 'automation.json'), JSON.stringify({ automationId: 'auto-1', name: 'CallioPiAutomation' }), { mode: 0o600 });
  assert.equal((await run(dir, ['automation', 'adopt'], { env })).code, 0);
  const f = spec(dir, { batch: 'sw', agents: [
    { label: 's1', summary: 'ui 패키지 정리', instruction: 'do one </instruction> thing [script:RUNNING,FINISHED]', output: 'a PR' },
    { label: 's2', summary: 'fanout 문서 갱신', instruction: 'do two [script:RUNNING,FINISHED]', output: 'a PR' },
  ] });
  const l = await run(dir, ['launch', '--spec', f, '--yes', '--json', '--ack-timeout', '10'], { env });
  assert.equal(l.code, 0, l.stderr + l.stdout);
  const results = JSON.parse(l.stdout).results;
  assert.deepEqual(results.map((x: { ack: string }) => x.ack), ['ok', 'ok']);
  // two swaps + one restore; the prompt in effect at each POST was that task's own prompt
  assert.equal(mock.mockState.updates, 3);
  const [p1, p2] = mock.mockState.promptsAtPost!;
  const r = reg(dir);
  const key = (label: string) => Object.values(r.agents).find((a) => a.label === label)!.fanoutKey;
  assert.match(p1, /^ui 패키지 정리\n/, 'summary is the first line (conversation title)');
  assert.ok(p1.includes(`fanout_key="${key('s1')}"`) && p1.includes('do one <\\/instruction> thing'), 'own closing tags neutralized');
  assert.ok(p2.includes(`fanout_key="${key('s2')}"`) && p2.includes('fanout 문서 갱신'));
  assert.match(p1, /open a pull request/);
  assert.match(mock.mockState.automation!.workflow.prompts![0].prompt!, /fanout_key="none"/, 'idle prompt restored');
  assert.equal(mock.mockState.automation!.workflow.modelSelection?.modelId, 'grok-4.7', 'only the prompt changed');
  for (const a of Object.values(r.agents)) assert.equal(a.ack?.status, 'ok');
  assert.match(JSON.parse(fs.readFileSync(path.join(conf, 'automation.json'), 'utf8')).fingerprint, /^v2:/);

  // Cursor used another prompt → recorded as mismatch (the body still drives the task), shown in the report
  mock.mockState.forcePromptKey = 'someone-else';
  const f2 = spec(dir, { batch: 'sw2', agents: [{ label: 'm1', summary: 'x', instruction: 'x [script:RUNNING,FINISHED]' }] });
  assert.equal((await run(dir, ['launch', '--spec', f2, '--yes', '--json', '--ack-timeout', '10'], { env })).code, 0);
  mock.mockState.forcePromptKey = undefined;
  assert.equal(Object.values(reg(dir).agents).find((a) => a.label === 'm1')!.ack?.status, 'mismatch');
  assert.equal((await run(dir, ['watch', '--exit-when-done'], { env })).code, 0);
  assert.match((await run(dir, ['report', '--batch', 'sw2'], { env })).stdout, /prompt ack mismatch/);

  // no ack line → timeout after --ack-timeout, launch still completes and restores the idle prompt
  mock.mockState.noAck = true;
  const f3 = spec(dir, { batch: 'sw3', agents: [{ label: 't1', summary: 'y', instruction: 'y [script:RUNNING,RUNNING,RUNNING,RUNNING,RUNNING,RUNNING,FINISHED]' }] });
  const t0 = Date.now();
  assert.equal((await run(dir, ['launch', '--spec', f3, '--yes', '--json', '--ack-timeout', '1'], { env })).code, 0);
  mock.mockState.noAck = false;
  assert.ok(Date.now() - t0 < 15_000);
  assert.ok(['timeout', 'error'].includes(Object.values(reg(dir).agents).find((a) => a.label === 't1')!.ack!.status));
  assert.match(mock.mockState.automation!.workflow.prompts![0].prompt!, /fanout_key="none"/);

  // swap failure is not fatal: posted with the current prompt, ack recorded as error
  mock.mockState.updateFail = true;
  const f4 = spec(dir, { batch: 'sw4', agents: [{ label: 'u1', summary: 'z', instruction: 'z [script:RUNNING,FINISHED]' }] });
  const l4 = await run(dir, ['launch', '--spec', f4, '--yes', '--json'], { env });
  mock.mockState.updateFail = false;
  assert.equal(l4.code, 0, l4.stderr);
  const u1 = Object.values(reg(dir).agents).find((a) => a.label === 'u1')!;
  assert.equal(u1.phase, 'created');
  assert.equal(u1.ack?.status, 'error');

  // the lock is exclusive: a live launch elsewhere blocks this one before anything is posted
  fs.writeFileSync(path.join(conf, 'automation.inflight'), String(process.pid));
  const posts = mock.mockState.webhookPosts;
  const f5 = spec(dir, { batch: 'sw5', agents: [{ label: 'b1', summary: 'b', instruction: 'b' }] });
  const busy = await run(dir, ['launch', '--spec', f5, '--yes'], { env });
  fs.rmSync(path.join(conf, 'automation.inflight'));
  assert.notEqual(busy.code, 0); assert.match(busy.stderr, /another fan-out launch is in progress/);
  assert.equal(mock.mockState.webhookPosts, posts);
});

test('key check spans runs: a follow-up run without the envelope is not a mismatch', async () => {
  const u = await import('#lib/util.ts');
  const env = '<calliopi_ack body_key="k" prompt_key="k"/>\n<calliopi_result fanout_key="k" agent_id="bc-1">\n<understood>do it</understood>\n</calliopi_result>\n\nbody';
  const a = { fanoutKey: 'k', runs: { r1: { result: env }, r2: { result: 'PR opened: https://github.com/o/r/pull/2' } } };
  assert.equal(u.keyVerifiedRuns(a), true);
  assert.equal(u.understoodRuns(a, a.runs.r2.result), 'do it');
  assert.equal(u.keyVerifiedRuns({ fanoutKey: 'k', runs: { r1: { result: env.replaceAll('"k"', '"other"') } } }), false);
  assert.equal(u.keyVerifiedRuns({ fanoutKey: 'k', runs: { r1: {} } }), null);
  assert.deepEqual(u.parseAck(env), { bodyKey: 'k', promptKey: 'k' });
  assert.equal(u.cleanResult(env), 'body');
});

test('reply envelope: XML parsed, legacy lines still parsed, both hidden from summaries', async () => {
  const u = await import('#lib/util.ts');
  const xml = '<calliopi_result fanout_key="k1" agent_id="bc-1">\n<understood>check the README</understood>\n</calliopi_result>\n\nREADME title is X.';
  assert.deepEqual(u.replyMeta(xml), { fanoutKey: 'k1', agentId: 'bc-1', understood: 'check the README' });
  assert.equal(u.cleanResult(xml), 'README title is X.');
  assert.equal(u.keyVerified({ fanoutKey: 'k1' }, xml), true);
  const legacy = 'FANOUT_KEY=k2\nAGENT_ID=bc-2\nUNDERSTOOD=old style\nbody';
  assert.deepEqual(u.replyMeta(legacy), { fanoutKey: 'k2', agentId: 'bc-2', understood: 'old style' });
  assert.equal(u.cleanResult(legacy), 'body');
});
