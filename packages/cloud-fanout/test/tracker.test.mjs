// node --test test/  — end-to-end against the mock API. No network, no paid calls.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startMock } from './mock-cursor.mjs';

const TRACKER = fileURLToPath(new URL('../bin/tracker.mjs', import.meta.url));
let mock;

function run(dir, args, { env = {}, input } = {}) {
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
const reg = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'registry.json'), 'utf8'));
const spec = (dir, s) => { const f = path.join(dir, 'spec.json'); fs.writeFileSync(f, JSON.stringify(s)); return f; };

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
  assert.ok(created.every((c) => c.phase === 'created' && /^bc-/.test(c.agentId) && /^run-/.test(c.runId)));
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
  assert.ok(by.bg.history.some((h) => h.to === 'WAITING_FOR_BACKGROUND_WORK'), 'saw WAITING');
  assert.ok(!by.bg.history.some((h) => h.to === 'ERROR'), 'WAITING never mapped to ERROR');
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
  const phases = JSON.parse(l.stdout).results.map((r) => r.phase).sort();
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
  assert.ok(Object.values(r.agents).every((a) => a.status === 'FINISHED' && a.runs[a.runId].usageNote));
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
    const a = reg(dir2).agents[l.agentId];
    assert.equal(a.status, 'FINISHED');
    assert.match(a.runs[l.runId].result, /summary/);
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
  const creds = (exp) => JSON.stringify({ version: 1, backendUrl: 'https://api2.cursor.sh', apiKey: 'test-key', apiKeyExpiresAtMs: exp, createdAtMs: Date.now() });
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
  assert.ok(res.every((r) => r.phase === 'planned'));
  assert.ok((mock.stats.byRoute['POST /v1/agents'] || 0) - before <= 3, 'stopped hammering');
  const ids = Object.values(reg(dir).agents).map((a) => a.agentId).sort();
  const again = JSON.parse((await run(dir, ['launch', '--spec', f, '--yes', '--json'])).stdout);
  assert.equal(again.results.filter((r) => r.phase === 'created').length, 3);
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
  assert.ok(res.every((r) => r.phase === 'created' && /^bc-/.test(r.agentId)));
  assert.equal((mock.mockState.webhookPosts || 0) - posts0, 2);
  const w = await run(dir, ['watch', '--exit-when-done'], { env });
  assert.equal(w.code, 0, w.stdout);
  const r = reg(dir);
  for (const a of Object.values(r.agents)) {
    assert.equal(a.status, 'FINISHED');
    assert.match(a.runs[a.runId].result, new RegExp(`fanout_key="${a.fanoutKey}"`));
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
  // someone edits the automation in the UI → launch refuses, nothing posted
  mock.mockState.automation.workflow.prompts = [{ prompt: 'edited in UI' }];
  const posts = mock.mockState.webhookPosts;
  const f2 = spec(dir, { batch: 'g2', agents: [{ label: 'g2', prompt: 'y' }] });
  const drift = await run(dir, ['launch', '--spec', f2, '--yes'], { env });
  assert.equal(drift.code, 2); assert.match(drift.stderr, /changed outside the harness/);
  assert.equal(mock.mockState.webhookPosts, posts);
  // apply refuses to overwrite the foreign edit without --force
  const ap = await run(dir, ['automation', 'apply', '--yes'], { env });
  assert.equal(ap.code, 2); assert.match(ap.stderr, /server config changed/);
  assert.equal(mock.mockState.updates, 0);
  // apply refuses while a fan-out is posting (in-flight lock held by a live pid)
  fs.writeFileSync(path.join(conf, 'automation.inflight'), String(process.pid));
  const busy = await run(dir, ['automation', 'apply', '--yes', '--force'], { env });
  assert.equal(busy.code, 2); assert.match(busy.stderr, /posting webhooks/);
  fs.rmSync(path.join(conf, 'automation.inflight'));
  // explicit --force applies, records the new fingerprint, launch works again
  assert.equal((await run(dir, ['automation', 'apply', '--yes', '--force'], { env })).code, 0);
  assert.equal(mock.mockState.updates, 1);
  assert.equal((await run(dir, ['launch', '--spec', f2, '--yes', '--json'], { env })).code, 0);
});

test('reply envelope: XML parsed, legacy lines still parsed, both hidden from summaries', async () => {
  const u = await import('../lib/util.mjs');
  const xml = '<calliopi_result fanout_key="k1" agent_id="bc-1">\n<understood>check the README</understood>\n</calliopi_result>\n\nREADME title is X.';
  assert.deepEqual(u.replyMeta(xml), { fanoutKey: 'k1', agentId: 'bc-1', understood: 'check the README' });
  assert.equal(u.cleanResult(xml), 'README title is X.');
  assert.equal(u.keyVerified({ fanoutKey: 'k1' }, xml), true);
  const legacy = 'FANOUT_KEY=k2\nAGENT_ID=bc-2\nUNDERSTOOD=old style\nbody';
  assert.deepEqual(u.replyMeta(legacy), { fanoutKey: 'k2', agentId: 'bc-2', understood: 'old style' });
  assert.equal(u.cleanResult(legacy), 'body');
});
