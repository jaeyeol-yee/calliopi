// One polling pass. Network calls happen outside the registry lock; results are applied
// as per-agent patch functions inside a short locked update so concurrent writers
// (launcher, `add`, pane mapping) are never clobbered.
import { load, update, trackable, pushHistory } from './registry.ts';
import { ApiError, type CursorApi, type Limiter } from './api.ts';
import { KNOWN, caught, isTerminal, jitter, nowIso, short } from './util.ts';
import type { AgentRecord, ApiRun, FanoutConfig, GitBranch, Logger, UsageStats } from './types.ts';

export class FatalAuth extends Error {}

const branchKey = (b: GitBranch): string => `${b.repoUrl}|${b.branch || ''}|${b.prUrl || ''}`;

function nextInterval(cfg: FanoutConfig, status: string, unchanged: number): number {
  const base = cfg.intervals[status] ?? cfg.intervals.UNKNOWN;
  return Math.min(Math.round(base * 1.5 ** Math.min(unchanged, 4)), cfg.intervals.MAX);
}

export interface TickCtx {
  cfg: FanoutConfig;
  api: CursorApi;
  limiter: Limiter;
  log: Logger;
  usageUnavailable?: boolean;
  useIndex?: boolean;
}

async function fetchIndex(ctx: TickCtx, wanted: Set<string>): Promise<Map<string, { id: string; updatedAt?: string; latestRunId?: string; url?: string; name?: string; status?: string }>> {
  const { api, limiter } = ctx;
  const map = new Map<string, { id: string; updatedAt?: string; latestRunId?: string; url?: string; name?: string; status?: string }>();
  let cursor: string | null | undefined;
  for (let page = 0; page < 2; page += 1) {
    if (page > 0 && !limiter.tryTake()) break;
    const res = await api.request<{ items?: { id: string; updatedAt?: string; latestRunId?: string; url?: string; name?: string; status?: string }[]; nextCursor?: string | null }>('GET', '/v1/agents', { query: { limit: 100, cursor }, preTaken: true });
    for (const it of res?.items || []) map.set(it.id, it);
    cursor = res?.nextCursor;
    if (!cursor || [...wanted].every((id) => map.has(id))) break;
  }
  return map;
}

export async function tick(ctx: TickCtx): Promise<{ events: { agentId: string; label: string | null; runId: string | null; from: string | null; to: string }[]; polled: number }> {
  const { cfg, api, limiter, log } = ctx;
  const reg = load(cfg);
  ctx.usageUnavailable ||= Boolean(reg.meta.usageUnavailable);
  const now = Date.now();
  const due = Object.values(reg.agents)
    .filter((a): a is AgentRecord & { agentId: string } => Boolean(trackable(a) && now >= (a.poll?.nextAt || 0)))
    .sort((a, b) => (a.poll?.nextAt || 0) - (b.poll?.nextAt || 0));
  if (!due.length) return { events: [], polled: 0 };

  const patches = new Map<string, ((r: AgentRecord) => void)[]>();
  const events: { agentId: string; label: string | null; runId: string | null; from: string | null; to: string }[] = [];
  const patch = (id: string, fn: (r: AgentRecord) => void) => patches.set(id, [...(patches.get(id) || []), fn]);
  let polled = 0;

  // 1) Cheap batch index: one GET /v1/agents returns updatedAt + latestRunId for up to 100 agents.
  //    Used only to *skip* agents that look unchanged, bounded by a staleness guard, because
  //    whether AgentSummary.updatedAt moves on every run status change is not documented.
  let index: Awaited<ReturnType<typeof fetchIndex>> | null = null;
  if (ctx.useIndex !== false && due.length >= cfg.indexThreshold && limiter.tryTake()) {
    try { index = await fetchIndex(ctx, new Set(due.map((a) => a.agentId))); } catch (e: unknown) {
      if (e instanceof ApiError && e.status === 401) throw new FatalAuth(e.message);
      log.warn(`agent index unavailable: ${caught(e).message}`);
    }
  }

  for (const a of due) {
    const id = a.agentId;
    const idx = index?.get(id);
    if (idx) {
      const lastAt = a.poll?.lastAt ? Date.parse(a.poll.lastAt) : 0;
      const guard = Math.max(2 * (a.poll?.interval || 0), 60_000);
      if (a.status && idx.updatedAt === a.poll?.lastAgentUpdatedAt && idx.latestRunId === a.runId && now - lastAt < guard) {
        patch(id, (r) => { r.poll.nextAt = now + jitter(r.poll.interval || cfg.intervals.UNKNOWN); });
        continue;
      }
    }
    if (!limiter.tryTake()) break; // budget spent: the rest stays due for the next tick

    polled += 1;
    try {
      const page = await api.listRuns(id, { limit: cfg.runsPageLimit }, { preTaken: true });
      const items = page?.items || [];
      if (!items.length) {
        patch(id, (r) => {
          r.poll = { ...r.poll, lastAt: nowIso(), nextAt: now + jitter(cfg.intervals.CREATING) };
        });
        continue;
      }
      const newest = items[0];
      // Tracked run fell off the first page (many follow-ups): one targeted GET, rare.
      let older: ApiRun | null = null;
      if (a.runId && !items.some((r) => r.id === a.runId) && !a.runs?.[a.runId]?.finalized) {
        try { older = await api.getRun(id, a.runId); } catch (e: unknown) { log.warn(`getRun ${short(a.runId)}: ${caught(e).message}`); }
      }
      if (!KNOWN.has(newest.status)) log.warn(`${short(id)}: unknown status ${newest.status} (treated as active)`);

      const changed = newest.status !== a.status || newest.id !== a.runId;
      const unchanged = changed ? 0 : (a.poll?.unchanged || 0) + 1;
      const interval = nextInterval(cfg, newest.status, unchanged);

      let usage: UsageStats | null = null;
      let usageNote: string | null = null;
      let full: ApiRun | null = null;
      const needsFinal = isTerminal(newest.status) && !a.runs?.[newest.id]?.finalized;
      if (needsFinal) {
        // Observed on the real API: listRuns items omit `result`; GET run carries it.
        // One targeted getRun per terminal transition — not per poll.
        if (!newest.result) {
          try { full = await api.getRun(id, newest.id); } catch (e: unknown) {
            if (e instanceof ApiError && e.status === 401) throw new FatalAuth(e.message);
            log.warn(`${short(id)}: getRun for result failed (${caught(e).message}); will retry`);
            patch(id, (r) => { r.poll.nextAt = now + jitter(cfg.intervals.CREATING); });
            continue; // not finalized: next tick tries again
          }
        }
        if (ctx.usageUnavailable) usageNote = 'feature_unavailable';
        else {
          try {
            const u = await api.usage(id, newest.id);
            usage = u?.runs?.find((r) => r.id === newest.id)?.usage ?? u?.totalUsage ?? null;
          } catch (e: unknown) {
            if (e instanceof ApiError && e.status === 403) {
              ctx.usageUnavailable = true; usageNote = e.code || 'forbidden';
              log.warn(`usage endpoint unavailable (${e.code}); tokens will not be collected`);
            } else usageNote = `error: ${caught(e).message}`;
          }
        }
      }

      if (changed) {
        events.push({ agentId: id, label: a.label, runId: newest.id, from: a.status, to: newest.status });
      }

      patch(id, (r) => {
        for (const run of [...items, ...(older ? [older] : []), ...(full ? [full] : [])]) {
          const prev = r.runs[run.id] || {};
          r.runs[run.id] = {
            ...prev,
            status: run.status,
            createdAt: run.createdAt,
            updatedAt: run.updatedAt,
            durationMs: run.durationMs ?? prev.durationMs ?? null,
            result: run.result ?? prev.result ?? null,
            finalized: prev.finalized || (isTerminal(run.status) && run.id !== newest.id),
          };
        }
        if (changed) {
          pushHistory(r, { runId: newest.id, from: r.status, to: newest.status });
          r.statusChangedAt = nowIso();
        }
        r.runId = newest.id;
        r.status = newest.status;
        if (needsFinal) {
          // git is a per-agent snapshot. Attribute to this run only the delta since the
          // previous snapshot; keep the full snapshot separately.
          const prevKeys = new Set((r.git?.branches || []).map(branchKey));
          const snap = full?.git || newest.git || r.git || null;
          const delta = (snap?.branches || []).filter((b) => !prevKeys.has(branchKey(b)));
          r.gitPrev = r.git;
          r.git = snap;
          Object.assign(r.runs[newest.id], {
            finalized: true,
            finalizedAt: nowIso(),
            usage,
            usageNote,
            gitDelta: delta,
            gitAttribution: 'snapshot-delta-at-newest-run',
          });
          r.finalized = true;
        } else if (newest.git) {
          r.git = newest.git;
        }
        r.lastError = null;
        r.poll = {
          ...r.poll,
          interval,
          unchanged,
          lastAt: nowIso(),
          nextAt: now + jitter(interval),
          lastAgentUpdatedAt: idx?.updatedAt ?? r.poll?.lastAgentUpdatedAt ?? null,
        };
        if (idx?.url) r.url = idx.url;
        if (idx?.name && !r.name) r.name = idx.name;
        if (idx?.status === 'ARCHIVED') r.archived = true;
      });
    } catch (e: unknown) {
      if (e instanceof ApiError && e.status === 401) throw new FatalAuth(e.message);
      if (e instanceof ApiError && e.status === 404) {
        events.push({ agentId: id, label: a.label, runId: a.runId, from: a.status, to: 'MISSING' });
        patch(id, (r) => { r.missing = true; r.lastError = { at: nowIso(), status: 404, code: e.code, message: e.message }; });
        continue;
      }
      const err = caught(e);
      const backoff = e instanceof ApiError && e.status === 403
        ? cfg.intervals.MAX
        : Math.min(Math.max(a.poll?.interval || 15_000, 15_000) * 2, cfg.intervals.MAX);
      log.warn(`${short(id)}: ${err.message}; retry in ${Math.round(backoff / 1000)}s`);
      patch(id, (r) => {
        r.lastError = { at: nowIso(), status: err.status ?? null, code: err.code ?? null, message: err.message };
        r.poll = { ...r.poll, interval: backoff, nextAt: now + jitter(backoff) };
      });
    }
  }

  if (patches.size || ctx.usageUnavailable) {
    await update(cfg, (r) => {
      if (ctx.usageUnavailable) r.meta.usageUnavailable = true;
      for (const [id, fns] of patches) {
        const rec = r.agents[id];
        if (rec) for (const fn of fns) fn(rec);
      }
    });
  }
  return { events, polled };
}
