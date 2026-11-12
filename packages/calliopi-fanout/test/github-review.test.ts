import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createReviewService, parseGhResponse, prTarget, retryTime, reviewSummary, syncReviews } from '../lib/github-review.ts';
import { taskState, freshness, plain } from '../lib/floating-model.ts';
import { load, update } from '../lib/registry.ts';
import type { AgentRecord, AgentView, GhResponse, PrTarget } from '../lib/types.ts';

const url = 'https://github.com/test/repo/pull/1';
const response = (state = 'open', merged = false, sha = 'a') => ({ status: 200, headers: { etag: '"test"' }, data: { state, merged, merged_at: merged ? '2026-01-01' : null, head: { sha }, base: { ref: 'main' } } });
function fixture(t: TestContext, transport: (target: PrTarget, etag?: string | null) => Promise<GhResponse>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'github-review-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let time = 1_000_000, calls = 0;
  const opts = { cacheDir: dir, scope: 'test', now: () => time, random: () => 0, transport: async (target: PrTarget, etag?: string | null) => { calls++; return transport(target, etag); } };
  return { service: createReviewService(opts), opts, dir, advance: (n: number) => { time += n; }, calls: () => calls };
}

test('PR parsing rejects non-GitHub targets and reads gh HTTP headers including 304', () => {
  assert.equal(prTarget(url)!.key, 'test/repo#1');
  assert.equal(prTarget('https://evil.test/test/repo/pull/1'), null);
  assert.equal(prTarget('https://github.com/test/repo/issues/1'), null);
  assert.equal(parseGhResponse('HTTP/2.0 304 Not Modified\r\nETag: "a"\r\n\r\n').status, 304);
  assert.equal(parseGhResponse('HTTP/2.0 200 OK\nX-RateLimit-Remaining: 22\n\n{"merged":true}').headers['x-ratelimit-remaining'], '22');
  assert.equal(parseGhResponse('network failed', 1).status, 0);
});

test('3-minute polling, detail TTL, ETag 304, and shared cache across sessions', async t => {
  let first = true;
  const f = fixture(t, async (_target, etag) => {
    if (first) { first = false; return response(); }
    assert.equal(etag, '"test"'); return { status: 304, headers: {} };
  });
  await f.service.get(url);
  f.advance(40_000);
  await f.service.get(url); assert.equal(f.calls(), 1);
  const second = createReviewService(f.opts);
  const updated = await second.get(url, { detail: true });
  assert.equal(updated.state, 'pending'); assert.equal(updated.headSha, 'a'); assert.equal(f.calls(), 2);
  await second.get(url, { detail: true }); assert.equal(f.calls(), 2);
  f.advance(180_001); await second.get(url); assert.equal(f.calls(), 3);
});

test('in-flight requests are coalesced, merged PR polling stops', async t => {
  const f = fixture(t, async () => response('closed', true));
  const results = await Promise.all([f.service.get(url), f.service.get(url, { detail: true })]);
  assert.equal(f.calls(), 1); assert.equal(results[1].state, 'merged');
  f.advance(3_600_000); await f.service.get(url, { detail: true }); assert.equal(f.calls(), 1);
});

test('403 permission failure is not confused with rate limiting; stale results survive', async t => {
  let ok = true;
  const f = fixture(t, async () => ok ? response() : { status: 403, headers: {}, data: { message: 'Resource not accessible' } });
  const prev = await f.service.get(url); ok = false; f.advance(180_001);
  const stale = await f.service.get(url);
  assert.equal(stale.state, 'pending'); assert.equal(stale.checkedAt, prev.checkedAt); assert.match(stale.lastError as string, /권한/);
  assert.equal(stale.deferredUntil, null);
  await f.service.get(url, { detail: true }); assert.equal(f.calls(), 2);
});

test('rate limit cooldown is shared across PRs and manual refresh', async t => {
  const f = fixture(t, async () => ({ status: 429, headers: { 'retry-after': '180' }, data: { message: 'secondary rate limit' } }));
  await f.service.get(url);
  f.advance(2000);
  const deferred = await createReviewService(f.opts).get('https://github.com/test/repo/pull/2', { detail: true });
  assert.ok((deferred.deferredUntil as number) > 1_002_000); assert.equal(f.calls(), 1);
  assert.equal(retryTime({ status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '2000', 'retry-after': '10' } }, 1_000_000), 2_001_000);
});

test('budget 300/hour and reserve capacity apply even to manual refresh', async t => {
  const f = fixture(t, async () => response());
  const cfg = { dir: path.join(f.dir, 'test'), registryPath: path.join(f.dir, 'test', 'registry.json'), lockPath: path.join(f.dir, 'test', 'registry.lock') };
  await update(cfg, reg => { reg.meta.budget = { windowStart: 1_000_000, count: 300 }; });
  const result = await f.service.get(url, { detail: true });
  assert.ok(result.deferredUntil); assert.equal(f.calls(), 0);
  await update(cfg, reg => { reg.meta.budget = { windowStart: 1_000_000, count: 0, remaining: 5, limit: 5000, resetAt: 2_000_000 }; });
  await f.service.get(url, { detail: true }); assert.equal(f.calls(), 0);
});

test('cross-instance leases prevent duplicate network requests', async t => {
  let release: ((value?: unknown) => void) | undefined;
  const f = fixture(t, async () => { await new Promise((r) => { release = r; }); return response(); });
  const running = f.service.get(url);
  while (!release) await new Promise(r => setTimeout(r, 5));
  const other = await createReviewService(f.opts).get(url, { detail: true });
  assert.equal(other.state, 'unknown'); assert.equal(f.calls(), 1);
  release(); await running;
});

test('multi-branch work is not marked fully merged when only one PR merged', () => {
  const a: AgentView = { status: 'FINISHED', git: { branches: [{ prUrl: url }, { branch: 'no-pr' }] }, reviews: { [url]: { state: 'merged' } } };
  assert.equal(reviewSummary(a).state, 'partial'); assert.equal(taskState(a).tab, 1);
  a.git!.branches!.pop(); assert.equal(taskState(a).text, '병합됨');
  a.runId = 'followup'; a.runs = { old: { finalized: true }, followup: { gitAttribution: 'snapshot-delta-at-newest-run', gitDelta: [] } };
  assert.equal(taskState(a).tab, 1); assert.match(taskState(a).text, /실행별/);
  assert.equal(taskState({ status: 'WAITING_FOR_BACKGROUND_WORK' }).text, '작업 대기');
  assert.equal(taskState({ status: 'ERROR' }).color, 'warning');
  assert.equal(taskState({ status: 'FINISHED', runId: 'new', reviewAckRunId: 'old' }).tab, 1);
  assert.equal(taskState({ status: 'FINISHED', runId: 'new', reviewAckRunId: 'new' }).tab, 2);
  assert.equal(plain('\x1b[31mtest\n'), ' [31mtest ');
});

test('review worker exits for paused/no-PR projects and recovers a dead pid claim', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-worker-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const worker = fileURLToPath(new URL('../bin/review-watch.ts', import.meta.url));
  const reg: { version: number; meta: { reviewPaused: boolean }; agents: Record<string, { status: string; git: { branches: { prUrl: string }[] } | null }> } = { version: 1, meta: { reviewPaused: true }, agents: { a: { status: 'FINISHED', git: { branches: [{ prUrl: url }] } } } };
  fs.writeFileSync(path.join(dir, 'registry.json'), JSON.stringify(reg));
  fs.writeFileSync(path.join(dir, 'review.pid'), '99999999');
  execFileSync(process.execPath, [worker, dir], { timeout: 5000 });
  assert.equal(fs.existsSync(path.join(dir, 'review.pid')), false);
  reg.meta.reviewPaused = false; reg.agents.a.git = null;
  fs.writeFileSync(path.join(dir, 'registry.json'), JSON.stringify(reg));
  execFileSync(process.execPath, [worker, dir], { timeout: 5000 });
  assert.equal(fs.existsSync(path.join(dir, 'review.pid')), false);
});

test('sync deduplicates PR references and persists freshness without replacing run status', async t => {
  const f = fixture(t, async () => response());
  const cfg = { dir: path.join(f.dir, 'project'), registryPath: path.join(f.dir, 'project', 'registry.json'), lockPath: path.join(f.dir, 'project', 'registry.lock') };
  await update(cfg, reg => { for (const id of ['a', 'b']) reg.agents[id] = { agentId: id, runId: 'run', status: 'FINISHED', git: { branches: [{ prUrl: url }] } } as AgentRecord; });
  await syncReviews(cfg, f.service);
  const agents = Object.values(load(cfg).agents);
  assert.equal(f.calls(), 1); assert.equal(agents[0].status, 'FINISHED');
  assert.equal(agents[1]!.reviews![url]!.state, 'pending');
  assert.equal(freshness(agents[0], 1_001_000), '방금 확인');
});
