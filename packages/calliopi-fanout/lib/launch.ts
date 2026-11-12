// Launcher: spec → N independent POST /v1/agents, fire-and-forget.
// Re-entry safety: every item gets a deterministic key; its agentId (bc-<uuid>) is minted and
// persisted *before* the POST. Re-running re-POSTs the same agentId → 201 (first time) or
// 409 agent_id_conflict (already created) → recovered via GET /v1/agents/{id}. No duplicates.
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { load, update, newAgentRecord } from './registry.ts';
import { ApiError } from './api.ts';
import { caught, nowIso, oneLine, sha256, short } from './util.ts';
import type { AgentRecord, FanoutConfig, LaunchSpec, Logger, ModelsResponse, PlannedItem } from './types.ts';
import type { CursorApi } from './api.ts';

export interface LaunchCtx {
  cfg: FanoutConfig;
  api?: CursorApi;
  log: Logger;
  blocked?: string;
}

export interface LaunchResultRow {
  label?: string | null;
  agentId?: string | null;
  runId?: string | null;
  phase?: string;
  error?: string;
  fanoutKey?: string;
}

export interface LaunchSummary {
  batch: string;
  via?: string;
  total: number;
  toCreate: number;
  skipped: { label?: string | null; agentId?: string | null; action: string }[];
  approved?: boolean;
  results: LaunchResultRow[];
  plan?: { label: string; repo?: string | null; ref?: string | null; action: string; prompt: string; model?: string; billing: string; summary?: string | null; output?: string | null }[];
  models?: Record<string, string>;
}

/**
 * Spec shape:
 * {
 *   "batch": "name",
 *   "defaults": { "repo": URL, "ref": "main", "model": {"id": "..."}, "autoCreatePR": true, "mode": "agent", "request": {...} },
 *   "agents": [ { "label": "...", "prompt": "...", "repo"?, "ref"?, "prUrl"?, "request"?: {...extra CreateAgentRequest fields} } ],
 *   "matrix": { "prompts": [...], "repos": [...], "refs": [...] }        // optional cartesian product
 * }
 */
export function expandSpec(spec: LaunchSpec): { batch: string; items: PlannedItem[] } {
  if (!spec || typeof spec !== 'object') throw new Error('spec must be a JSON object');
  const batch = spec.batch || `batch-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '')}`;
  const d = spec.defaults || {};
  const items = [];
  for (const it of spec.agents || []) items.push({ ...it });
  if (spec.matrix) {
    const prompts = spec.matrix.prompts || [];
    const repos = spec.matrix.repos?.length ? spec.matrix.repos : [d.repo ?? null];
    const refs = spec.matrix.refs?.length ? spec.matrix.refs : [d.ref ?? null];
    prompts.forEach((p, pi) => {
      const prompt = typeof p === 'string' ? { prompt: p } : p;
      for (const repo of repos) for (const ref of refs) {
        items.push({ label: prompt.label || `p${pi + 1}${repos.length > 1 ? `@${repoName(repo)}` : ''}${refs.length > 1 ? `:${ref}` : ''}`, ...prompt, repo, ref });
      }
    });
  }
  const seen = new Map();
  return {
    batch,
    items: items.map((it, i) => {
      // Factored task: summary (one-line title) / instruction (what to do) / output (deliverable).
      // Legacy `prompt` is accepted as the instruction.
      const instruction = it.instruction ?? it.prompt;
      if (!instruction || typeof instruction !== 'string') throw new Error(`item ${i}: "instruction" (or legacy "prompt") is required`);
      it.prompt = composePrompt({ summary: it.summary, instruction, output: it.output });
      const repo = it.repo === undefined ? d.repo ?? null : it.repo;
      const ref = it.ref === undefined ? d.ref ?? null : it.ref;
      const label = it.label || `${batch}#${i + 1}`;
      const base = sha256([batch, label, it.prompt, repo, ref, it.prUrl || ''].join('\u0000')).slice(0, 24);
      const n = (seen.get(base) || 0) + 1; seen.set(base, n);
      const request = { ...(d.request || {}), ...(it.request || {}) };
      return {
        key: `${base}.${n}`,
        label,
        prompt: it.prompt,
        summary: it.summary || null,
        instruction: it.instruction ?? null,
        output: it.output || null,
        repo,
        ref,
        prUrl: it.prUrl || null,
        // Explicit Auto by default: omitting `model` lets the server pick user → team → system default,
        // which is invisible from here. `"model": null` opts back into that account default.
        model: it.model !== undefined ? it.model : d.model !== undefined ? d.model : { id: 'auto' },
        mode: it.mode ?? d.mode ?? null,
        autoCreatePR: it.autoCreatePR ?? d.autoCreatePR ?? null,
        workOnCurrentBranch: it.workOnCurrentBranch ?? d.workOnCurrentBranch ?? null,
        skipReviewerRequest: it.skipReviewerRequest ?? d.skipReviewerRequest ?? null,
        request,
      };
    }),
  };
}

/** One prompt text from the factored fields (REST path; the automation path sends the fields separately). */
export function composePrompt({ summary, instruction, output }: { summary?: string | null; instruction: string; output?: string | null }): string {
  if (!summary && !output) return instruction;
  return [summary && `Summary: ${summary}`, `Instruction:\n${instruction}`, output && `Expected output:\n${output}`].filter(Boolean).join('\n\n');
}

const repoName = (u: string | null | undefined) => (u ? String(u).replace(/\/+$/, '').split('/').pop() : 'norepo');

export function buildBody(item: PlannedItem, agentId: string | null): Record<string, unknown> {
  const body: Record<string, unknown> = { prompt: { text: item.prompt }, name: `${item.summary || item.label}`.slice(0, 100) };
  if (agentId) body.agentId = agentId;
  if (item.repo) {
    const repo: Record<string, unknown> = { url: item.repo };
    if (item.prUrl) repo.prUrl = item.prUrl;
    else if (item.ref) repo.startingRef = item.ref;
    body.repos = [repo];
  }
  for (const k of ['model', 'mode', 'autoCreatePR', 'workOnCurrentBranch', 'skipReviewerRequest'] as const) {
    if (item[k] != null) body[k] = item[k];
  }
  Object.assign(body, item.request);
  // The API rejects agentId combined with envVars; fall back to server-minted ids for those.
  if (body.envVars && body.agentId) delete body.agentId;
  return body;
}

export function plan(cfg: FanoutConfig, spec: LaunchSpec, { retryFailed = false }: { retryFailed?: boolean } = {}) {
  const { batch, items } = expandSpec(spec);
  const reg = load(cfg);
  const byKey = new Map(Object.values(reg.agents).filter((a) => a.key).map((a) => [a.key, a]));
  const rows = items.map((item) => {
    const rec = byKey.get(item.key);
    let action = 'create';
    if (rec?.phase === 'created') action = 'skip:created';
    else if (rec?.phase === 'create_failed' && !retryFailed) action = 'skip:failed';
    else if (rec?.phase === 'planned') action = 'resume';
    return { item, rec, action };
  });
  return { batch, rows };
}

export async function launch(ctx: LaunchCtx, spec: LaunchSpec, { yes = false, retryFailed = false, concurrency = 3 }: { yes?: boolean; retryFailed?: boolean; concurrency?: number } = {}): Promise<LaunchSummary> {
  const { cfg, log } = ctx;
  const api = ctx.api as CursorApi;
  const p = plan(cfg, spec, { retryFailed });
  const todo = p.rows.filter((r) => r.action === 'create' || r.action === 'resume');
  const summary: LaunchSummary = {
    batch: p.batch,
    total: p.rows.length,
    toCreate: todo.length,
    skipped: p.rows.filter((r) => r.action.startsWith('skip')).map((r) => ({ label: r.item.label, agentId: r.rec?.agentId, action: r.action })),
    approved: yes,
    results: [],
  };
  if (todo.length > cfg.maxPerLaunch) {
    throw new Error(`refusing to create ${todo.length} agents (> max ${cfg.maxPerLaunch}); pass --max ${todo.length} explicitly`);
  }
  if (!yes || !todo.length) {
    summary.plan = todo.map((r) => ({
      label: r.item.label, repo: r.item.repo, ref: r.item.ref, action: r.action, prompt: oneLine(r.item.prompt, 80),
      model: r.item.model?.id || '(account default)', billing: billingClass(r.item.model?.id),
    }));
    return summary;
  }

  // Free pre-flight: a typo'd model id would otherwise fail every create with 400 invalid_model.
  summary.models = await validateModels(api, todo.map((r) => r.item));

  // Phase 1 (locked, no network): persist planned records with pre-minted agentIds.
  const planned = await update(cfg, (reg) => {
    reg.batches[p.batch] ??= { createdAt: nowIso(), specSha: sha256(JSON.stringify(spec)).slice(0, 16), title: spec.title || null };
    return todo.map(({ item }) => {
      let rec = Object.values(reg.agents).find((a) => a.key === item.key);
      if (!rec || rec.phase === 'create_failed') {
        const body = buildBody(item, `bc-${randomUUID()}`);
        const agentId = (body.agentId as string | undefined) || null;
        const prev = rec;
        rec = newAgentRecord({
          agentId,
          key: item.key,
          batch: p.batch,
          label: item.label,
          source: 'launch',
          phase: 'planned',
          repo: item.repo,
          ref: item.prUrl || item.ref,
          promptPreview: oneLine(item.prompt, 120),
          promptSha: sha256(item.prompt).slice(0, 16),
          attempts: prev?.attempts || 0,
        });
        if (prev) delete reg.agents[prev.agentId || `pending:${prev.key}`];
        reg.agents[agentId || `pending:${item.key}`] = rec;
      }
      return { item, agentId: rec.agentId, regKey: rec.agentId || `pending:${item.key}` };
    });
  });

  // Phase 2: POST with a small worker pool; the shared limiter caps the actual rate.
  const queue = [...planned];
  const worker = async () => {
    for (let job = queue.shift(); job; job = queue.shift()) summary.results.push(await createOne(ctx, job));
  };
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
  const bad = summary.results.filter((r) => r.phase !== 'created');
  if (bad.length) log.warn(`${bad.length}/${summary.results.length} not created; re-run the same command to resume (idempotent)`);
  return summary;
}

// Account-level refusals: retrying other items would fail the same way.
const ACCOUNT_BLOCKED = new Set(['usage_limit_exceeded', 'plan_required', 'integration_not_connected']);

async function createOne(ctx: LaunchCtx, { item, agentId, regKey }: { item: PlannedItem; agentId: string | null; regKey: string }): Promise<LaunchResultRow> {
  const { cfg, log } = ctx;
  const api = ctx.api as CursorApi;
  if (ctx.blocked) {
    return record(cfg, regKey, { phase: 'planned', createError: { at: nowIso(), code: ctx.blocked, message: `skipped: account blocked (${ctx.blocked})` } }, item);
  }
  const body = buildBody(item, agentId);
  // Server-minted id path (envVars): look for a previous attempt by its unique name first.
  if (!agentId) {
    const found = await findByName(api, body.name as string).catch(() => null);
    if (found) return record(cfg, regKey, { phase: 'created', agentId: found.id, runId: found.latestRunId, url: found.url, name: found.name, recovered: 'name' }, item);
  }
  try {
    const res = await api.createAgent(body);
    log.info(`created ${short(res.agent.id)} run ${short(res.run?.id)} [${item.label}]`);
    return record(cfg, regKey, {
      phase: 'created', agentId: res.agent.id, runId: res.run?.id ?? res.agent.latestRunId ?? null,
      status: res.run?.status ?? null, url: res.agent.url, name: res.agent.name,
    }, item);
  } catch (e: unknown) {
    if (e instanceof ApiError && e.status === 409 && e.code === 'agent_id_conflict' && agentId) {
      const ag = await api.getAgent(agentId);
      log.info(`recovered ${short(agentId)} (already created by an earlier attempt) [${item.label}]`);
      return record(cfg, regKey, { phase: 'created', agentId, runId: ag.latestRunId ?? null, url: ag.url, name: ag.name, recovered: 'agent_id_conflict' }, item);
    }
    if (e instanceof ApiError && e.code != null && ACCOUNT_BLOCKED.has(e.code)) {
      // Not created, nothing spent. Stay `planned` so a plain re-run (after top-up) resumes with the same agentId.
      ctx.blocked = e.code;
      log.warn(`create refused [${item.label}]: ${e.message} (request id ${e.requestId || '-'}) — skipping the rest; re-run after fixing the account`);
      return record(cfg, regKey, { phase: 'planned', createError: { at: nowIso(), status: e.status, code: e.code, message: e.message, requestId: e.requestId ?? null } }, item);
    }
    const err = caught(e);
    const ambiguous = err.ambiguous || !(e instanceof ApiError) || err.status === 0 || (err.status as number) >= 500;
    log.warn(`create failed [${item.label}]: ${err.message}${ambiguous ? ' (ambiguous; will resume on re-run)' : ''}`);
    return record(cfg, regKey, {
      phase: ambiguous ? 'planned' : 'create_failed',
      createError: { at: nowIso(), status: err.status ?? null, code: err.code ?? null, message: err.message, requestId: err.requestId ?? null },
    }, item);
  }
}

async function findByName(api: CursorApi, name: string) {
  const res = await api.listAgents({ limit: 100 });
  return (res?.items || []).find((a) => a.name === name) || null;
}

async function record(cfg: FanoutConfig, regKey: string, fields: Partial<AgentRecord> & { phase?: string; runId?: string | null; status?: string | null; agentId?: string | null }, item: PlannedItem): Promise<LaunchResultRow> {
  return update(cfg, (reg) => {
    const rec = reg.agents[regKey];
    if (!rec) return { label: item.label, ...fields } as LaunchResultRow;
    Object.assign(rec, fields);
    rec.attempts = (rec.attempts || 0) + 1;
    if (fields.phase === 'created') {
      rec.createError = null;
      if (fields.runId) rec.runs[fields.runId] ??= { status: fields.status ?? null, createdAt: nowIso() };
      if (fields.status) rec.statusChangedAt = nowIso();
      rec.poll.nextAt = Date.now() + cfg.intervals.CREATING;
      if (regKey !== fields.agentId) { delete reg.agents[regKey]; reg.agents[fields.agentId as string] = rec; }
    }
    return { label: rec.label, agentId: rec.agentId, runId: rec.runId, phase: rec.phase, error: rec.createError?.message };
  });
}

// docs/cloud-agent.md#billing + models-and-pricing.md#auto-modes:
// - Auto (id "default", alias "auto"): individual plans = Cost mode → weekly pool whatever model serves it.
//   Teams/Enterprise Router Balance/Intelligence may route to third-party → prepaid credit.
// - Cursor models (composer/grok): weekly pool, then prepaid credit at the same rate.
// - Third-party: prepaid credit at API list price from the first request.
// Observed 2026-11: with the pool unavailable, creates are refused with usage_limit_exceeded.
const CURSOR_MODELS = /^(composer|grok)/i;
export function billingClass(modelId: string | null | undefined): string {
  if (!modelId) return 'account default (user → team → system; not visible via API)';
  if (/^(auto|default)$/i.test(modelId)) return 'Auto: weekly pool (individual plans); Teams Router may route to third-party';
  return CURSOR_MODELS.test(modelId) ? 'Cursor model: weekly pool, then prepaid' : 'third-party: prepaid credit at API list price';
}

/** Resolve spec model ids/aliases against GET /v1/models (free). Throws before any create on unknown ids. */
export async function validateModels(api: CursorApi, items: PlannedItem[]): Promise<Record<string, string>> {
  const wanted = [...new Set(items.map((i) => i.model?.id).filter((id): id is string => Boolean(id)))];
  if (!wanted.length) return {};
  const res = await api.request<ModelsResponse>('GET', '/v1/models');
  const index = new Map<string, string>();
  for (const m of res?.items || []) for (const k of [m.id, ...(m.aliases || [])]) if (!index.has(k)) index.set(k, m.id);
  const unknown = wanted.filter((w) => !index.has(w));
  if (unknown.length) {
    throw new Error(`unknown model id(s): ${unknown.join(', ')} — see GET /v1/models (e.g. auto, grok-4.7, composer-2.5)`);
  }
  return Object.fromEntries(wanted.map((w) => [w, index.get(w) as string]));
}

export function readSpec(file: string): LaunchSpec {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// ---------------------------------------------------------------------------
// Automation path: one documented webhook POST per item. The response carries the agent id
// ({success, backgroundComposerId}); from then on everything is public REST.
// Webhooks have no client-supplied id, so a lost response is AMBIGUOUS: we never auto-repost it
// (phase post_ambiguous); the agent's reply line FANOUT_KEY=<key> lets you reconcile afterwards.
import { randomUUID as uuid } from 'node:crypto';
import { postWebhook, acquireInflight, releaseInflight } from './automation.ts';

export async function launchViaAutomation(ctx: LaunchCtx, spec: LaunchSpec, { yes = false, retryFailed = false, webhook, automationRepo = null, gapMs = 800 }: {
  yes?: boolean; retryFailed?: boolean; webhook: { url: string; key: string }; automationRepo?: string | null; gapMs?: number;
}): Promise<LaunchSummary> {
  const { cfg, log } = ctx;
  const p = plan(cfg, spec, { retryFailed });
  const rows = p.rows.map((r) => ({ ...r, action: r.rec?.phase === 'post_ambiguous' ? 'skip:ambiguous' : r.action }));
  const todo = rows.filter((r) => r.action === 'create' || r.action === 'resume');
  const mismatch = automationRepo ? todo.filter((r) => r.item.repo && norm(r.item.repo) !== norm(automationRepo)) : [];
  const summary: LaunchSummary = {
    batch: p.batch, via: 'automation', total: rows.length, toCreate: todo.length, approved: yes,
    skipped: rows.filter((r) => r.action.startsWith('skip')).map((r) => ({ label: r.item.label, agentId: r.rec?.agentId, action: r.action })),
    results: [],
  };
  if (mismatch.length) throw new Error(`automation is bound to ${automationRepo}; items target other repos: ${mismatch.map((r) => r.item.label).join(', ')}`);
  if (todo.length > cfg.maxPerLaunch) throw new Error(`refusing to create ${todo.length} agents (> max ${cfg.maxPerLaunch}); pass --max ${todo.length}`);
  if (!yes || !todo.length) {
    summary.plan = todo.map((r) => ({ label: r.item.label, summary: r.item.summary, output: r.item.output, repo: automationRepo || r.item.repo, action: r.action, prompt: oneLine(r.item.instruction ?? r.item.prompt, 80), model: '(automation)', billing: 'automation run: plan usage (weekly pool)' }));
    return summary;
  }
  acquireInflight(); // marks "posting" so `automation apply` refuses to mutate the automation meanwhile
  try {
  for (const { item } of todo) {
    const fanoutKey = uuid();
    const regKey = `pending:${item.key}`;
    await update(cfg, (reg) => {
      reg.batches[p.batch] ??= { createdAt: nowIso(), via: 'automation', title: spec.title || null };
      const prev = Object.entries(reg.agents).find(([, a]) => a.key === item.key);
      if (prev) delete reg.agents[prev[0]];
      reg.agents[regKey] = newAgentRecord({
        key: item.key, batch: p.batch, label: item.label, source: 'automation', phase: 'posting', fanoutKey,
        summary: item.summary, output: item.output,
        repo: automationRepo || item.repo, promptPreview: oneLine(item.prompt, 120), promptSha: sha256(item.prompt).slice(0, 16),
      });
    });
    let res: { status: number; headers: Record<string, string>; body: { backgroundComposerId?: string } | null; text: string } | undefined; let err: ReturnType<typeof caught> | null = null;
    const payload = { fanout_key: fanoutKey, label: item.label, summary: item.summary, instruction: item.instruction ?? item.prompt, output: item.output };
    try { res = await postWebhook(webhook, payload); } catch (e: unknown) { err = caught(e); }
    const agentId = res?.body?.backgroundComposerId;
    const fields = agentId
      ? { phase: 'created', agentId, requestId: res!.headers['x-request-id'] ?? null }
      : err || !res || res.status >= 500
        ? { phase: 'post_ambiguous', createError: { at: nowIso(), status: res?.status ?? 0, message: err?.message || `HTTP ${res?.status}`, requestId: res?.headers?.['x-request-id'] ?? null } }
        : { phase: 'create_failed', createError: { at: nowIso(), status: res.status, message: res.text?.slice(0, 200), requestId: res.headers['x-request-id'] ?? null } };
    const out = await update(cfg, (reg) => {
      const rec = reg.agents[regKey];
      Object.assign(rec, fields);
      if (agentId) { rec.poll.nextAt = Date.now() + cfg.intervals.CREATING; delete reg.agents[regKey]; reg.agents[agentId] = rec; }
      return { label: rec.label, agentId: rec.agentId, phase: rec.phase, fanoutKey, error: rec.createError?.message };
    });
    log.info(`${out.phase.padEnd(14)} ${short(out.agentId)} [${item.label}]${out.error ? `  ! ${out.error}` : ''}`);
    summary.results.push(out);
    await new Promise((r) => setTimeout(r, gapMs)); // webhook rate limits are undocumented: be gentle
  }
  } finally { releaseInflight(); }
  return summary;
}

const norm = (u: string) => String(u).replace(/^(https?:\/\/)?(www\.)?github\.com\//, '').replace(/\.git$/, '').replace(/\/+$/, '').toLowerCase();
