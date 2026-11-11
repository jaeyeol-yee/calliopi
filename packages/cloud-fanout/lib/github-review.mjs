// GitHub metadata cache shared by authenticated scope, not by Pi session/project.
// Rendering never calls this module. Claims and rate budget are persisted before I/O.
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { load, update } from './registry.mjs';

export const REVIEW_INTERVAL = 180_000;
export const DETAIL_TTL = 30_000;
const LEASE = 60_000;

export function prTarget(url) {
  try {
    const u = new URL(url);
    const m = /^\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)\/?$/.exec(u.pathname);
    if (u.protocol !== 'https:' || u.hostname !== 'github.com' || !m) return null;
    return { key: `${m[1]}/${m[2]}#${m[3]}`.toLowerCase(), endpoint: `repos/${m[1]}/${m[2]}/pulls/${m[3]}`, url };
  } catch { return null; }
}

export function parseGhResponse(stdout, code = 0) {
  // gh --include prints HTTP headers even for 304 and most HTTP errors.
  const normalized = stdout.replace(/\r\n/g, '\n');
  const match = /^HTTP\/\S+\s+(\d+)[^\n]*\n([\s\S]*?)\n\n([\s\S]*)$/.exec(normalized);
  if (!match) return { status: 0, headers: {}, data: null, error: code ? 'GitHub 요청 실패 (gh 인증/네트워크 확인)' : 'GitHub 응답을 읽을 수 없습니다.' };
  const headers = {};
  for (const line of match[2].split('\n')) {
    const p = line.indexOf(':');
    if (p > 0) headers[line.slice(0, p).toLowerCase()] = line.slice(p + 1).trim();
  }
  let data = null;
  try { data = JSON.parse(match[3]); } catch { /* 304 has no body */ }
  return { status: Number(match[1]), headers, data };
}

export function retryTime(response, now, attempts = 0) {
  const h = response.headers || {};
  const retry = h['retry-after'];
  const after = retry == null ? 0 : /^\d+(\.\d+)?$/.test(retry) ? now + Number(retry) * 1000 : Date.parse(retry) || 0;
  const reset = h['x-ratelimit-remaining'] === '0' ? Number(h['x-ratelimit-reset']) * 1000 : 0;
  const secondary = response.status === 429 || (response.status === 403 && /secondary rate|rate limit|abuse/i.test(response.data?.message || ''));
  if (!after && !reset && !secondary) return 0;
  return Math.max(after, reset || 0, now + (secondary ? Math.min(900_000, 60_000 * 2 ** Math.min(attempts, 4)) : 1000)) + 1000;
}

/** exec: pi.exec-compatible; transport/clock/cacheDir are injectable for offline tests. */
export function createReviewService({ exec, cacheDir, scope, transport, now = Date.now, random = Math.random } = {}) {
  let configPromise;
  const inFlight = new Map();
  async function config() {
    if (!configPromise) configPromise = (async () => {
      let identity = scope;
      if (!identity) {
        const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
        const auth = token ? { code: 0, stdout: token } : await exec('gh', ['auth', 'token', '--hostname', 'github.com'], { timeout: 5000 });
        if (auth.code !== 0 || !auth.stdout.trim()) throw new Error('GitHub 인증 필요: gh auth login');
        identity = createHash('sha256').update(`github.com\0${auth.stdout.trim()}`).digest('hex');
      }
      const dir = path.join(cacheDir || path.join(os.homedir(), '.cache', 'calliopi', 'github'), identity);
      return { dir, registryPath: path.join(dir, 'registry.json'), lockPath: path.join(dir, 'registry.lock') };
    })().catch(e => { configPromise = undefined; throw e; });
    return configPromise;
  }
  async function request(target, etag) {
    if (transport) return transport(target, etag);
    const args = ['api', '--hostname', 'github.com', '--include', '--method', 'GET', target.endpoint,
      '-H', 'Accept: application/vnd.github+json', '-H', 'X-GitHub-Api-Version: 2022-11-28'];
    if (etag) args.push('-H', `If-None-Match: ${etag}`);
    const r = await exec('gh', args, { timeout: 25_000, maxBuffer: 1_000_000 });
    return parseGhResponse(r.stdout, r.code);
  }
  async function get(url, { detail = false } = {}) {
    const target = prTarget(url);
    if (!target) return { state: 'unknown', lastError: '지원하지 않는 PR 주소', checkedAt: null };
    if (inFlight.has(target.key)) return inFlight.get(target.key);
    const promise = fetchOne(target, detail).finally(() => inFlight.delete(target.key));
    inFlight.set(target.key, promise);
    return promise;
  }
  async function fetchOne(target, detail) {
    const cfg = await config();
    const time = now();
    const claim = await update(cfg, reg => {
      const records = reg.meta.reviews ||= {};
      const prev = records[target.key] || { state: 'unknown', checkedAt: null };
      const budget = reg.meta.budget ||= { windowStart: time, count: 0, cooldownUntil: 0, nextRequestAt: 0, failures: 0 };
      if (time - budget.windowStart >= 3_600_000) { budget.windowStart = time; budget.count = 0; }
      const stamp = detail ? prev.attemptedAt ?? prev.checkedAt : prev.checkedAt;
      const fresh = stamp != null && time - stamp < (detail ? DETAIL_TTL : REVIEW_INTERVAL);
      if (prev.state === 'merged' || fresh || prev.leaseUntil > time || (!detail && prev.nextAt > time)) return { cached: prev };
      let blocked = Math.max(budget.cooldownUntil || 0, budget.nextRequestAt || 0, budget.count >= 300 ? budget.windowStart + 3_600_000 : 0);
      // Reserve capacity for other tools. Recheck only after the server's reset time.
      if (budget.remaining != null && budget.remaining < Math.max(100, (budget.limit || 5000) * 0.1) && budget.resetAt > time) blocked = Math.max(blocked, budget.resetAt + 1000);
      if (blocked > time || budget.leaseUntil > time) return { cached: { ...prev, deferredUntil: Math.max(blocked, budget.leaseUntil || 0), nextAt: Math.max(blocked, budget.leaseUntil || 0) } };
      budget.count++; budget.nextRequestAt = time + 1000; budget.leaseUntil = time + LEASE;
      records[target.key] = { ...prev, leaseUntil: time + LEASE };
      return { prev };
    });
    if (claim.cached) return claim.cached;
    let response;
    try { response = await request(target, claim.prev.etag); }
    catch { response = { status: 0, headers: {}, data: null, error: 'GitHub 네트워크/인증 확인 필요' }; }
    return update(cfg, reg => {
      const budget = reg.meta.budget;
      budget.leaseUntil = 0;
      const h = response.headers || {};
      if (h['x-ratelimit-resource'] === 'core' || !h['x-ratelimit-resource']) {
        if (h['x-ratelimit-remaining'] != null) budget.remaining = Number(h['x-ratelimit-remaining']);
        if (h['x-ratelimit-limit'] != null) budget.limit = Number(h['x-ratelimit-limit']);
        if (h['x-ratelimit-reset'] != null) budget.resetAt = Number(h['x-ratelimit-reset']) * 1000;
      }
      const at = now();
      const pause = retryTime(response, at, budget.failures);
      if (pause) { budget.cooldownUntil = pause; budget.failures++; }
      const prev = claim.prev;
      let record;
      if (response.status === 304 && prev.checkedAt != null) {
        record = { ...prev, checkedAt: at, lastError: null };
        budget.failures = 0;
      } else if (response.status === 200 && typeof response.data?.merged === 'boolean' && response.data?.head?.sha) {
        const pr = response.data;
        record = { state: pr.merged ? 'merged' : pr.state === 'closed' ? 'closed_unmerged' : 'pending', checkedAt: at,
          mergedAt: pr.merged_at, headSha: pr.head.sha, baseRef: pr.base?.ref, url: target.url, etag: h.etag || null, lastError: null };
        budget.failures = 0;
      } else {
        record = { ...prev, lastError: pause ? 'GitHub 요청 제한 · 갱신 대기' : response.status === 404 ? 'PR을 확인할 수 없음 (주소/권한 확인)' : response.status === 401 || response.status === 403 ? 'GitHub 인증/권한 확인 필요' : response.error || `GitHub 응답 오류 (${response.status})` };
      }
      record.attemptedAt = at;
      record.leaseUntil = 0;
      record.deferredUntil = pause || null;
      record.nextAt = Math.max(pause, at + REVIEW_INTERVAL + Math.floor(random() * 15_000));
      reg.meta.reviews[target.key] = record;
      return record;
    });
  }
  return { get, async peek(url) { const t = prTarget(url); return t ? load(await config()).meta.reviews?.[t.key] || null : null; } };
}

export function reviewSummary(agent) {
  const entries = (agent.git?.branches || []).filter(b => b.prUrl);
  if (!entries.length) return { state: agent.reviewAckRunId && agent.reviewAckRunId === agent.runId ? 'acknowledged' : 'pending', text: '검토 대기' };
  const run = agent.runs?.[agent.runId];
  const hasPreviousRun = Object.entries(agent.runs || {}).some(([id, r]) => id !== agent.runId && r.finalized);
  if (hasPreviousRun && run?.gitAttribution === 'snapshot-delta-at-newest-run' && !run.gitDelta?.length) {
    return { state: 'pending', text: '실행별 산출물 확인 필요' }; // Per-agent snapshots cannot prove this follow-up was merged.
  }
  const records = entries.map(b => agent.reviews?.[b.prUrl]);
  if ((agent.git?.branches || []).every(b => b.prUrl && agent.reviews?.[b.prUrl]?.state === 'merged')) return { state: 'merged', text: '병합됨' };
  if (records.some(r => r?.state === 'merged')) return { state: 'partial', text: '부분 병합' };
  if (records.every(r => r?.state === 'closed_unmerged')) return { state: 'closed_unmerged', text: '병합 없이 닫힘' };
  return { state: 'pending', text: '검토 대기' };
}

/** Persist only the reviews of branches/runs that still match the snapshot. */
export async function syncReviews(cfg, service, { agentId, detail = false, limit = 10, now = Date.now() } = {}) {
  const snapshot = Object.values(load(cfg).agents).filter(a => (!agentId || (a.agentId || a.key) === agentId) && a.status === 'FINISHED');
  const targets = new Map();
  for (const a of snapshot) for (const b of a.git?.branches || []) if (prTarget(b.prUrl) && (detail || !a.reviews?.[b.prUrl]?.nextAt || a.reviews[b.prUrl].nextAt <= now)) targets.set(b.prUrl, a.reviews?.[b.prUrl]?.nextAt || 0);
  const results = new Map();
  let calls = 0;
  for (const [url] of [...targets].sort((a, b) => a[1] - b[1])) {
    if (calls++ >= limit) break;
    try { results.set(url, await service.get(url, { detail })); }
    catch (e) { results.set(url, { state: 'unknown', lastError: e.message, checkedAt: null, nextAt: now + REVIEW_INTERVAL }); }
  }
  if (!results.size) return;
  await update(cfg, reg => {
    for (const a of snapshot) {
      const current = reg.agents[a.agentId || a.key];
      if (!current || current.runId !== a.runId) continue;
      current.reviews ||= {};
      for (const b of current.git?.branches || []) {
        const record = results.get(b.prUrl);
        if (record) current.reviews[b.prUrl] = record.checkedAt == null && current.reviews[b.prUrl] ? { ...current.reviews[b.prUrl], lastError: record.lastError, nextAt: record.nextAt } : record;
      }
    }
  });
}
