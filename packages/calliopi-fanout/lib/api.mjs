// Minimal Cursor Cloud Agents v1 REST client (fetch only). Spec: cursor.com/docs-static/cloud-agents-openapi.yaml
import { sleep, jitter, redact } from './util.mjs';

export class ApiError extends Error {
  constructor(status, code, message, extra = {}) {
    super(`HTTP ${status}${code ? ` ${code}` : ''}: ${redact(message || '')}`);
    this.status = status;
    this.code = code;
    Object.assign(this, extra);
  }
}

/**
 * Token bucket shared by every request in this process. `pause(ms)` is a global
 * stop used for 429 — limits are per user/team, so one 429 means everyone waits.
 */
export class Limiter {
  constructor(rpm, burst = Math.min(5, Math.max(1, Math.floor(rpm / 3)))) {
    this.rate = rpm / 60_000; // tokens per ms
    this.cap = burst;
    this.tokens = burst;
    this.last = Date.now();
    this.pausedUntil = 0;
    this.count = 0;
  }
  #refill() {
    const now = Date.now();
    this.tokens = Math.min(this.cap, this.tokens + (now - this.last) * this.rate);
    this.last = now;
  }
  available() { this.#refill(); return Date.now() >= this.pausedUntil ? Math.floor(this.tokens) : 0; }
  tryTake() {
    if (this.available() < 1) return false;
    this.tokens -= 1; this.count += 1; return true;
  }
  async take(signal) {
    for (;;) {
      if (signal?.aborted) throw new Error('aborted');
      const waitPause = this.pausedUntil - Date.now();
      if (waitPause > 0) { await sleep(waitPause, signal); continue; }
      this.#refill();
      if (this.tokens >= 1) { this.tokens -= 1; this.count += 1; return; }
      await sleep(Math.ceil((1 - this.tokens) / this.rate), signal);
    }
  }
  pause(ms) { this.pausedUntil = Math.max(this.pausedUntil, Date.now() + ms); }
}

export function parseRetryAfter(h) {
  if (!h) return null;
  const n = Number(h);
  if (Number.isFinite(n)) return Math.max(0, n * 1000);
  const t = Date.parse(h);
  return Number.isFinite(t) ? Math.max(0, t - Date.now()) : null;
}

export class CursorApi {
  constructor({ key, base, limiter, log, timeoutMs = 30_000 }) {
    this.key = key; this.base = base; this.limiter = limiter; this.log = log; this.timeoutMs = timeoutMs;
  }

  /**
   * @param {object} o
   * @param {boolean} o.idempotent  safe to retry after 5xx/network errors (GETs, creates with client agentId)
   * @param {boolean} o.preTaken    caller already consumed a limiter token for the first attempt
   */
  async request(method, p, { query, body, headers = {}, idempotent = method === 'GET', raw = false, signal, preTaken = false, maxAttempts = 5 } = {}) {
    const url = new URL(this.base + p);
    for (const [k, v] of Object.entries(query || {})) if (v != null) url.searchParams.set(k, String(v));
    let attempt = 0;
    for (;;) {
      attempt += 1;
      if (!(preTaken && attempt === 1)) await this.limiter.take(signal);
      let res;
      try {
        res = await fetch(url, {
          method,
          headers: {
            authorization: `Bearer ${this.key}`,
            accept: raw ? 'text/event-stream' : 'application/json',
            ...(body ? { 'content-type': 'application/json' } : {}),
            ...headers,
          },
          body: body ? JSON.stringify(body) : undefined,
          signal: raw ? signal : AbortSignal.any([AbortSignal.timeout(this.timeoutMs), ...(signal ? [signal] : [])]),
        });
      } catch (e) {
        if (signal?.aborted) throw e;
        if (!idempotent || attempt >= maxAttempts) throw new ApiError(0, 'network', e.message, { ambiguous: !idempotent });
        await sleep(jitter(1000 * 2 ** attempt));
        continue;
      }

      if (res.status === 429) {
        const ra = parseRetryAfter(res.headers.get('retry-after')) ?? Math.min(120_000, 1000 * 2 ** attempt);
        this.limiter.pause(jitter(ra, 0.05));
        this.log?.warn(`429 on ${method} ${url.pathname}; pausing all requests ${Math.round(ra / 1000)}s (attempt ${attempt})`);
        await res.body?.cancel();
        // A 429 means the request was not processed, so a retry is safe even for POST.
        if (attempt >= maxAttempts) throw new ApiError(429, 'rate_limit_exceeded', 'retries exhausted', { retryAfterMs: ra });
        continue;
      }
      if (res.status >= 500 && idempotent && attempt < maxAttempts) {
        await res.body?.cancel();
        await sleep(jitter(1000 * 2 ** attempt));
        continue;
      }
      if (raw && res.ok) return res;
      const text = await res.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
      if (!res.ok) {
        const err = data?.error || data || {};
        throw new ApiError(res.status, err.code, err.message || text.slice(0, 200), {
          ambiguous: res.status >= 500 && !idempotent,
          requestId: res.headers.get('x-request-id') || null, // quote this to Cursor support
        });
      }
      return data;
    }
  }

  me() { return this.request('GET', '/v1/me'); }
  createAgent(body, opts = {}) {
    // With a client-supplied agentId a re-POST yields 409 agent_id_conflict, never a duplicate.
    return this.request('POST', '/v1/agents', { body, idempotent: Boolean(body.agentId), ...opts });
  }
  getAgent(id) { return this.request('GET', `/v1/agents/${enc(id)}`); }
  listAgents({ limit = 100, cursor, includeArchived } = {}) {
    return this.request('GET', '/v1/agents', { query: { limit, cursor, includeArchived } });
  }
  listRuns(id, { limit = 5, cursor } = {}, opts = {}) {
    return this.request('GET', `/v1/agents/${enc(id)}/runs`, { query: { limit, cursor }, ...opts });
  }
  getRun(id, runId, opts = {}) { return this.request('GET', `/v1/agents/${enc(id)}/runs/${enc(runId)}`, opts); }
  usage(id, runId) { return this.request('GET', `/v1/agents/${enc(id)}/usage`, { query: { runId } }); }
  streamRun(id, runId, { lastEventId, signal } = {}) {
    return this.request('GET', `/v1/agents/${enc(id)}/runs/${enc(runId)}/stream`, {
      raw: true, signal, headers: lastEventId ? { 'last-event-id': lastEventId } : {}, maxAttempts: 3,
    });
  }
  createRun(id, body) { return this.request('POST', `/v1/agents/${enc(id)}/runs`, { body, idempotent: false }); }
  cancelRun(id, runId) { return this.request('POST', `/v1/agents/${enc(id)}/runs/${enc(runId)}/cancel`, { idempotent: false }); }
  archiveAgent(id) { return this.request('POST', `/v1/agents/${enc(id)}/archive`, { idempotent: false }); }
}

const enc = encodeURIComponent;
