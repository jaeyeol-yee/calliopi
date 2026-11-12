#!/usr/bin/env node
// Cursor Cloud Agents fan-out tracker. Zero dependencies, multiplexer-agnostic:
// nothing here knows about rex (or tmux). Multiplexer layers only call these commands.
import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { loadConfig } from '#lib/config.ts';
import { stampArchive } from '#lib/archive.ts';
import { resolveApiKey, ensureLogin, AuthError } from '#lib/auth.ts';
import { CursorApi, Limiter, ApiError } from '#lib/api.ts';
import { load, update, ensureDir, findAgent, newAgentRecord, pushHistory } from '#lib/registry.ts';
import { tick, FatalAuth, type TickCtx } from '#lib/poller.ts';
import { render, DashboardWriter, counts } from '#lib/dashboard.ts';
import { launch, launchViaAutomation } from '#lib/launch.ts';
import type { PromptSwap } from '#lib/launch.ts';
import { readSpec } from '#lib/launch.ts';
import { follow, summaryBlock, exitCodeFor } from '#lib/follow.ts';
import { stream, waitForAck } from '#lib/stream.ts';
import { aggregate, toMarkdown } from '#lib/report.ts';
import { findJournals, scanJournals } from '#lib/pijournal.ts';
import { diffTrees, renderTree, outline, renderOutline } from '#lib/arch.ts';
import { gitRefSource, localSource, ghRefSource } from '#lib/workspace.ts';
import * as auto from '#lib/automation.ts';
import { randomUUID } from 'node:crypto';
import { execFileSync, execFile } from 'node:child_process';
import * as prs from '#lib/pr.ts';
import { EXIT, caught, makeLogger, nowIso, processAlive, short, sleep, isTerminal, redact } from '#lib/util.ts';
import type { AgentRecord, Logger, Registry } from '#lib/types.ts';

const HELP = `usage: tracker.ts [--dir DIR] <command> [options]

state dir: --dir, $CURSOR_FANOUT_DIR, or ./.cursor-fanout   (registry.json 0600)

network (needs CURSOR_API_KEY or ~/.cursor/sdk/auth.json):
  login [--force]                                          ensure credentials (Cursor.auth.login browser flow if missing)
  whoami                                                   GET /v1/me — free auth check
  launch --spec FILE [--yes] [--via automation|rest] [--retry-failed] [--max N] [--no-swap] [--ack-timeout SEC]
                                                           create N agents (plan only without --yes); default via
                                                           automation when ~/.config/calliopi/webhook.json exists.
                                                           automation: each task is staged as the automation prompt
                                                           and its first-line ack awaited (default 180s) before the next
  watch [--log FILE] [--exit-when-done] [--no-index]       polling daemon (single instance per dir)
  tick                                                     one polling pass
  stream AGENT [--thinking]                                SSE live view of current run (410 → poll)
  followup AGENT --prompt TEXT [--steer] --yes             new run / steer (paid)
  pr AGENT [--pr URL]                                      PR state via gh: mergeable, checks, head, blockers
  merge AGENT [--sha HEAD] [--pr URL] --yes                squash-merge exactly HEAD (default: head just read), delete branch
  fix AGENT (--prompt TEXT | --rebase) [--pr URL] --yes   ask Cursor on the PR: comment \"@cursor …\"
  cancel AGENT --yes | archive AGENT --yes                 lifecycle (destructive)

local only (no API calls):
  add AGENT_ID [--run RUN_ID] [--label L]                  track an existing agent
  import-pi [--root DIR] [--dry-run]                       discover agents from Pi lifecycle journals
  status [--active] [--json]    show AGENT|--block B [--json]    follow AGENT
  report [--batch B] [--json] [--out FILE]                 aggregate summaries / PRs / tokens
  dashboard                                                render dashboard once to stdout

automations (official surfaces: AutomationsService CRUD as used by cursor/terraform-provider-cursor + documented webhook):
  automation create [--name N] [--repo URL] [--branch B] [--model ID] [--issue-key]
                                                                        create enabled, webhook-triggered; saves state
  automation issue-key                                                  issue a webhook sender key → webhook.json (0600)
        --issue-key / issue-key use ONE unofficial RPC (DashboardService/CreateAutomationWebhookApiKey)
  automation show | automation delete --yes
  automation adopt                                                      record the server's current config as expected (read-only)
  automation apply [--prompt-file F] [--model ID] [--repo URL] --yes   the only writer; refused while a fan-out posts or if
                                                                        the server drifted (use --force to overwrite)
  automation post --task TEXT [--label L]                               one documented webhook POST (prints response)

source tree (git/local only):
  tree --local DIR [--base-ref REF] [--depth N]            file tree vs base ref (+ added/modified/deleted)
  tree AGENT [--base-ref main]                             same, for the agent's pushed branch (repo+branch from Run.git, read via gh)
  tree --gh OWNER/REPO --ref BRANCH                        same, explicit
  arch --local DIR [--base-ref REF] [--json]               architecture outline (packages, entrypoints, changes)
  pane AGENT --block B [--session S] | pane --role R --block B | pane --clear B
  daemon-status [--json] | stop
`;

const raw = process.argv.slice(2);
const gi = raw.indexOf('--dir');
const globalDir = gi >= 0 ? raw[gi + 1] : undefined;
if (gi >= 0) raw.splice(gi, 2);
const [cmd, ...rest] = raw;

const OPTS = {
  spec: { type: 'string' }, via: { type: 'string' }, yes: { type: 'boolean' }, 'retry-failed': { type: 'boolean' }, max: { type: 'string' },
  json: { type: 'boolean' }, log: { type: 'string' }, 'exit-when-done': { type: 'boolean' }, 'no-index': { type: 'boolean' },
  quiet: { type: 'boolean' }, run: { type: 'string' }, label: { type: 'string' }, root: { type: 'string' },
  'dry-run': { type: 'boolean' }, active: { type: 'boolean' }, block: { type: 'string' }, session: { type: 'string' },
  role: { type: 'string' }, clear: { type: 'string' }, batch: { type: 'string' }, out: { type: 'string' },
  prompt: { type: 'string' }, steer: { type: 'boolean' }, thinking: { type: 'boolean' }, rpm: { type: 'string' },
  force: { type: 'boolean' }, 'issue-key': { type: 'boolean' }, 'prompt-file': { type: 'string' },
  name: { type: 'string' }, repo: { type: 'string' }, branch: { type: 'string' }, model: { type: 'string' }, task: { type: 'string' },
  gh: { type: 'string' }, ref: { type: 'string' }, 'no-swap': { type: 'boolean' }, 'ack-timeout': { type: 'string' },
  pr: { type: 'string' }, sha: { type: 'string' }, rebase: { type: 'boolean' },
  'base-repo': { type: 'string' }, 'base-ref': { type: 'string' }, depth: { type: 'string' }, local: { type: 'string' },
  help: { type: 'boolean', short: 'h' },
} as const;

let args;
try { args = parseArgs({ args: rest, options: OPTS, allowPositionals: true }); } catch (e: unknown) {
  process.stderr.write(`${caught(e).message}\n\n${HELP}`); process.exit(EXIT.USAGE);
}
const { values: o, positionals: pos } = args;
const cfg = loadConfig({ dir: globalDir, max: o.max, rpm: o.rpm });
const out = (x: unknown) => process.stdout.write(typeof x === 'string' ? `${x}\n` : `${JSON.stringify(x, null, 2)}\n`);

function apiCtx(log: Logger): TickCtx {
  const { key, source } = resolveApiKey();
  log.debug(`auth source: ${source}`);
  const limiter = new Limiter(cfg.rpm);
  return { cfg, log, limiter, api: new CursorApi({ key, base: cfg.apiBase, limiter, log }) };
}

const gh: prs.GhRun = (args) => new Promise((resolve) => {
  execFile('gh', args, { maxBuffer: 16 << 20, timeout: 60_000 }, (err, stdout, stderr) => resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout, stderr }));
});

function needAgent(reg: Registry, needle: string | undefined): AgentRecord {
  const a = findAgent(reg, needle);
  if (!a) { process.stderr.write(`unknown agent: ${needle}\n`); process.exit(EXIT.MISSING); }
  return a;
}

function requireYes(what: string) {
  if (!o.yes) { process.stderr.write(`${what}\nrefusing without --yes (paid or destructive)\n`); process.exit(EXIT.USAGE); }
}

const commands: Record<string, () => Promise<number>> = {
  async launch() {
    if (!o.spec) throw new UsageError('--spec FILE required');
    const log = makeLogger();
    const spec = o.spec === '-' ? JSON.parse(fs.readFileSync(0, 'utf8')) : readSpec(o.spec);
    const hook = auto.readJson(auto.WEBHOOK_STATE);
    const via = o.via || (hook?.url && hook?.key ? 'automation' : 'rest');
    let res;
    if (via === 'automation') {
      if (!hook?.url || !hook?.key) throw new UsageError(`--via automation needs ${auto.WEBHOOK_STATE} (tracker automation create --issue-key)`);
      let automationRepo = null;
      let swap: PromptSwap | null = null;
      const st = auto.readJson(auto.AUTOMATION_STATE);
      if (st?.automationId) {
        try {
          // official GetAutomation (free): repo/model are fixed per automation, show them in the plan too
          const client = await auto.automationsClient(resolveApiKey().key);
          const a = (await client.get(st.automationId)).workflow?.workflow;
          if (o.yes && !a?.enabled) throw new UsageError(`automation ${st.name} is disabled`);
          if (o.yes && !auto.fingerprintMatches(st.fingerprint, a?.workflow)) {
            throw new UsageError(`automation ${st.name} changed outside the harness (fingerprint ${st.fingerprint} → ${auto.fingerprint(a?.workflow)}); review it, then run \`tracker automation adopt\` (keep server version) or \`tracker automation apply --yes\``);
          }
          if (o.yes && st.fingerprint && !st.fingerprint.startsWith('v2:')) auto.saveAutomationState({ ...st, fingerprint: auto.fingerprint(a?.workflow) }); // one-time upgrade
          automationRepo = a?.workflow?.gitConfig?.repo ?? null;
          // Stage each task as the automation prompt (first message + title), with an ack round trip.
          if (o.yes && a?.workflow && !o['no-swap']) {
            const { api } = apiCtx(log);
            swap = {
              workflow: a.workflow,
              update: (workflow) => client.update({ automationId: st.automationId, workflow }),
              waitAck: (agentId, fanoutKey) => waitForAck(api, agentId, fanoutKey, { timeoutMs: Number(o['ack-timeout'] ?? 180) * 1000 }),
            };
          }
        } catch (e) { if (o.yes || e instanceof UsageError) throw e; }
      }
      res = await launchViaAutomation({ cfg, log }, spec, { yes: o.yes, retryFailed: o['retry-failed'], webhook: hook as { url: string; key: string }, automationRepo, swap });
    } else {
      if (o.yes) await ensureLogin(); // interactive only; daemons never prompt
      const ctx = o.yes ? apiCtx(log) : { cfg, log };
      res = await launch(ctx, spec, { yes: o.yes, retryFailed: o['retry-failed'] });
    }
    if (o.json) out(res);
    else if (!o.yes) {
      out(`batch ${res.batch}: ${res.toCreate} to create, ${res.skipped.length} skipped (already tracked)`);
      out(`via ${res.via || 'rest'}`);
      for (const p of res.plan || []) out(`  + ${p.label}  ${p.repo || '(no repo)'}${p.ref ? `@${p.ref}` : ''}  model ${p.model} [${p.billing}]  ${p.prompt}`);
      if (res.toCreate) out(`\nThis would start ${res.toCreate} Cloud Agent run(s) (plan usage at each model's rate). Re-run with --yes to create.`);
    } else {
      for (const r of res.results) out(`${(r.phase as string).padEnd(13)} ${short(r.agentId)} ${short(r.runId)} ${r.label}${r.error ? `  ! ${r.error}` : ''}`);
    }
    if (res.results?.some((r) => r.error && /account blocked|usage_limit_exceeded/.test(r.error))) {
      process.stderr.write('account refused creation (nothing created or spent); re-run the same command after fixing billing — it resumes with the same agentIds\n');
    }
    const failed = (res.results || []).some((r) => r.phase !== 'created');
    return o.yes ? (failed ? 1 : 0) : res.toCreate ? EXIT.USAGE : 0;
  },

  async login() {
    // --force: log out first, e.g. to switch to the account that actually holds the plan
    const { source } = await ensureLogin({ interactive: true, force: Boolean(o.force) });
    out(`credentials ok (${source})`);
    return 0;
  },

  async whoami() {
    const { api } = apiCtx(makeLogger());
    const me = await api.me();
    // print identity only; never key material
    const { apiKey, key, ...safe } = me || {};
    out(o.json ? safe : JSON.stringify(safe));
    return 0;
  },

  async add() {
    const [agentId] = pos;
    if (!/^bc-/.test(agentId || '')) throw new UsageError('add AGENT_ID (bc-...)');
    ensureDir(cfg.dir);
    const res = await update(cfg, (reg) => {
      if (reg.agents[agentId]) {
        const a = reg.agents[agentId];
        if (o.run && o.run !== a.runId) { a.runId = o.run; a.finalized = false; a.poll.nextAt = 0; }
        if (o.label) a.label = o.label;
        return { agentId, added: false };
      }
      reg.agents[agentId] = newAgentRecord({ agentId, runId: o.run || null, label: o.label || short(agentId), source: 'add', phase: 'imported' });
      return { agentId, added: true };
    });
    if (o.json) out(res); else out(`${res.added ? 'tracking' : 'already tracked'} ${agentId}`);
    return 0;
  },

  async ['import-pi']() {
    const files = findJournals(o.root);
    const found = scanJournals(files);
    let added = 0;
    if (!o['dry-run'] && found.length) {
      ensureDir(cfg.dir);
      added = await update(cfg, (reg) => {
        let n = 0;
        for (const f of found) {
          if (reg.agents[f.agentId]) continue;
          reg.agents[f.agentId] = newAgentRecord({ agentId: f.agentId, runId: f.runId, label: `pi:${short(f.agentId)}`, source: 'pi-journal', phase: 'imported' });
          n += 1;
        }
        return n;
      });
    }
    const res = { journals: files.length, agentsFound: found.length, added, dryRun: Boolean(o['dry-run']) };
    if (o.json) out(res); else out(`journals ${res.journals} · agents found ${res.agentsFound} · added ${res.added}${res.dryRun ? ' (dry run)' : ''}`);
    return 0;
  },

  async watch() { return runDaemon({ once: false }); },
  async tick() { return runDaemon({ once: true }); },

  async status() {
    const reg = load(cfg);
    let list = Object.values(reg.agents);
    if (o.active) list = list.filter((a) => !isTerminal(a.status) && !a.missing && a.phase !== 'create_failed');
    if (o.json) {
      out({
        counts: counts(reg),
        daemon: daemonInfo(),
        panes: reg.meta.panes,
        agents: list.map((a) => ({
          agentId: a.agentId, label: a.label, batch: a.batch, phase: a.phase, status: a.status, runId: a.runId,
          finalized: a.finalized, missing: a.missing, pane: a.pane, url: a.url,
        })),
      });
    } else out(render({ ...reg, agents: Object.fromEntries(list.map((a) => [a.agentId || a.key, a])) }, reg.meta.events || []));
    return 0;
  },

  async show() {
    const reg = load(cfg);
    if (o.block) {
      const role = Object.entries(reg.meta.panes || {}).find(([, p]) => p?.blockId === o.block)?.[0];
      const a = Object.values(reg.agents).find((x) => x.pane?.blockId === o.block);
      const res = a ? view(a) : role ? { role } : {};
      out(o.json ? res : JSON.stringify(res));
      return 0;
    }
    const a = needAgent(reg, pos[0]);
    out(o.json ? view(a) : summaryBlock(a));
    return 0;
  },

  async follow() {
    if (!pos[0]) throw new UsageError('follow AGENT');
    return follow(cfg, pos[0]);
  },

  async stream() {
    if (!pos[0]) throw new UsageError('stream AGENT');
    const log = makeLogger();
    return stream(apiCtx(log), pos[0], { showThinking: o.thinking });
  },

  async report() {
    const agg = aggregate(cfg, { batch: o.batch });
    const md = toMarkdown(agg);
    if (o.out) fs.writeFileSync(o.out, md, { mode: 0o600 });
    if (o.json) out({ ...agg, reportPath: o.out || null });
    else if (!o.out) out(md);
    else out(o.out);
    return 0;
  },

  async dashboard() {
    const reg = load(cfg);
    out(render(reg, reg.meta.events || []));
    return 0;
  },

  async pane() {
    ensureDir(cfg.dir);
    const res = await update(cfg, (reg) => {
      if (o.clear) {
        for (const a of Object.values(reg.agents)) if (a.pane?.blockId === o.clear) a.pane = null;
        for (const [k, p] of Object.entries(reg.meta.panes)) if (p?.blockId === o.clear) delete reg.meta.panes[k];
        return { cleared: o.clear };
      }
      if (!o.block) throw new UsageError('--block required');
      const pane = { blockId: o.block, sessionId: o.session || null, at: nowIso() };
      if (o.role) { reg.meta.panes[o.role] = pane; return { role: o.role, ...pane }; }
      const a = findAgent(reg, pos[0]);
      if (!a) throw new UsageError(`unknown agent ${pos[0]}`);
      a.pane = pane;
      return { agentId: a.agentId, ...pane };
    });
    if (o.json) out(res);
    return 0;
  },

  async automation() {
    const sub = pos[0];
    const api = await auto.automationsClient(resolveApiKey().key);
    const state = auto.readJson(auto.AUTOMATION_STATE);
    if (sub === 'create') {
      if (state?.automationId) throw new UsageError(`automation already recorded (${state.name} ${state.automationId}); delete it first`);
      const name = o.name || 'CallioPiAutomation';
      const res = await api.create({
        name, description: 'Calliopi cloud fan-out: runs the task carried in the webhook payload.',
        scope: 'AUTOMATION_SCOPE_USER', creationSource: 'AUTOMATION_CREATION_SOURCE_CONFIG_AS_CODE', enabled: true,
        workflow: auto.workflowSpec({ repo: o.repo, branch: o.branch || 'main', modelId: o.model || 'grok-4.7' }),
      });
      const a = res.workflow?.workflow;
      auto.saveAutomationState({ automationId: a?.automationId, name: a?.name, enabled: a?.enabled, createdAt: nowIso(), fingerprint: auto.fingerprint(a?.workflow) });
      const hits = auto.findWebhookFields(res);
      let url = hits.find((h) => h.kind === 'url')?.value; let key = hits.find((h) => h.kind === 'key')?.value;
      if (!(url && key) && o['issue-key'] && a?.automationId) {
        key = (await api.issueWebhookKey(a.automationId)).apiKey; url = auto.webhookUrl(a.automationId);
      }
      if (url && key) auto.saveWebhook({ url, key, automationId: a?.automationId, savedAt: nowIso(), via: o['issue-key'] ? 'CreateAutomationWebhookApiKey (unofficial)' : 'create response' });
      out({
        automationId: a?.automationId, name: a?.name, enabled: a?.enabled,
        model: a?.workflow?.modelSelection, git: a?.workflow?.gitConfig,
        webhookFieldsInResponse: hits.map((h) => ({ path: h.path, kind: h.kind })),
        webhookSaved: Boolean(url && key),
        responseShape: auto.shape(res),
      });
      return 0;
    }
    if (sub === 'adopt') {
      // Record the server's current config as the expected one. Read-only (GetAutomation).
      if (!state?.automationId) throw new UsageError('no automation recorded');
      const a = (await api.get(state.automationId)).workflow?.workflow;
      const fp = auto.fingerprint(a?.workflow);
      auto.saveAutomationState({ ...state, fingerprint: fp, adoptedAt: nowIso() });
      out({ automationId: state.automationId, fingerprint: fp, prompt: a?.workflow?.prompts?.[0]?.prompt, model: a?.workflow?.modelSelection, git: a?.workflow?.gitConfig });
      return 0;
    }
    if (sub === 'apply') {
      // The ONLY writer. Full replacement, last-writer-wins on the server, so guard both sides.
      if (!state?.automationId) throw new UsageError('no automation recorded');
      const owner = auto.inflightOwner();
      if (owner) throw new UsageError(`a fan-out is posting webhooks (pid ${owner}); retry when it finishes`);
      const cur = (await api.get(state.automationId)).workflow?.workflow;
      const serverFp = auto.fingerprint(cur?.workflow);
      if (!auto.fingerprintMatches(state.fingerprint, cur?.workflow) && !o.force) {
        throw new UsageError(`server config changed since it was recorded (${state.fingerprint} → ${serverFp}); \`automation adopt\` to keep it, or --force to overwrite`);
      }
      const prompt = o['prompt-file'] ? fs.readFileSync(o['prompt-file'], 'utf8') : auto.DEFAULT_PROMPT;
      const next = auto.workflowSpec({ prompt, repo: o.repo || cur?.workflow?.gitConfig?.repo, branch: o.branch || cur?.workflow?.gitConfig?.branch || 'main', modelId: o.model || cur?.workflow?.modelSelection?.modelId || 'grok-4.7' });
      const nextFp = auto.fingerprint(next);
      if (nextFp === serverFp) { out({ automationId: state.automationId, fingerprint: serverFp, changed: false }); return 0; }
      requireYes(`replace automation ${state.name} config (${serverFp} → ${nextFp})`);
      if (!auto.acquireInflight()) throw new UsageError('a fan-out started meanwhile; retry');
      try {
        const res = await api.update({ automationId: state.automationId, workflow: next });
        const fp = auto.fingerprint(res.workflow?.workflow?.workflow);
        auto.saveAutomationState({ ...state, fingerprint: fp, appliedAt: nowIso() });
        out({ automationId: state.automationId, fingerprint: fp, changed: true });
      } finally { auto.releaseInflight(); }
      return 0;
    }
    if (sub === 'issue-key') {
      if (!state?.automationId) throw new UsageError('no automation recorded');
      const res = await api.issueWebhookKey(state.automationId);
      if (!res.apiKey) throw new Error('CreateAutomationWebhookApiKey returned no key');
      auto.saveWebhook({ url: auto.webhookUrl(state.automationId), key: res.apiKey, automationId: state.automationId, savedAt: nowIso(), via: 'CreateAutomationWebhookApiKey (unofficial)' });
      out({ automationId: state.automationId, webhookUrl: auto.webhookUrl(state.automationId), keySaved: auto.WEBHOOK_STATE, keyPrefix: `${res.apiKey.slice(0, 5)}…` });
      return 0;
    }
    if (sub === 'show') {
      if (!state?.automationId) throw new UsageError('no automation recorded');
      const res = await api.get(state.automationId);
      const a = res.workflow?.workflow;
      out({ automationId: a?.automationId, name: a?.name, enabled: a?.enabled, model: a?.workflow?.modelSelection, git: a?.workflow?.gitConfig,
        triggers: a?.workflow?.triggers, webhookFieldsInResponse: auto.findWebhookFields(res).map((h) => ({ path: h.path, kind: h.kind })), webhookFile: Boolean(auto.readJson(auto.WEBHOOK_STATE)) });
      return 0;
    }
    if (sub === 'delete') {
      if (!state?.automationId) throw new UsageError('no automation recorded');
      requireYes(`delete automation ${state.name} ${state.automationId}`);
      await api.delete(state.automationId);
      fs.renameSync(auto.AUTOMATION_STATE, `${auto.AUTOMATION_STATE}.deleted-${Date.now()}`);
      out(`deleted ${state.automationId}`);
      return 0;
    }
    if (sub === 'post') {
      const hook = auto.readJson(auto.WEBHOOK_STATE);
      if (!hook?.url || !hook?.key) throw new UsageError(`no webhook URL/key in ${auto.WEBHOOK_STATE}`);
      if (!o.task) throw new UsageError('--task TEXT required');
      const payload = { fanout_key: randomUUID(), label: o.label || 'webhook-probe', task: o.task };
      const res = await auto.postWebhook(hook as { url: string; key: string }, payload);
      out({ sent: { fanout_key: payload.fanout_key, label: payload.label }, status: res.status, body: res.body ?? res.text,
        headers: Object.fromEntries(Object.entries(res.headers).filter(([k]) => /request-id|location|content-type|x-cursor/i.test(k))) });
      return res.status >= 200 && res.status < 300 ? 0 : 1;
    }
    throw new UsageError('automation create|show|adopt|apply|issue-key|delete|post');
  },

  async tree() { return treeOrArch('tree'); },
  async arch() { return treeOrArch('arch'); },

  async ['daemon-status']() {
    const d = daemonInfo();
    out(o.json ? d : d.running ? `running pid ${d.pid}` : 'not running');
    return 0;
  },

  async stop() {
    const d = daemonInfo();
    if (d.running) process.kill(d.pid as number, 'SIGTERM');
    out(d.running ? `sent SIGTERM to ${d.pid}` : 'not running');
    return 0;
  },

  // ---- PR actions (A/B hybrid): inspect, merge exactly the shown head, or ask @cursor for changes.
  async pr() {
    const a = needAgent(load(cfg), pos[0]);
    const url = prs.pickPr(a, o.pr);
    const s = await prs.prState(gh, url);
    const blockers = prs.mergeBlockers(s);
    out(o.json ? { ...s, blockers } : `${prs.describePr(s)}${blockers.length ? `\nblocked: ${blockers.join('; ')}` : '\nready to merge'}`);
    return 0;
  },

  async merge() {
    const a = needAgent(load(cfg), pos[0]);
    const url = prs.pickPr(a, o.pr);
    const s = await prs.prState(gh, url);
    const blockers = prs.mergeBlockers(s);
    if (blockers.length && !o.force) throw new UsageError(`not merging ${url}: ${blockers.join('; ')}`);
    // --sha pins the head the user reviewed; without it we pin the head we just read.
    const sha = o.sha || s.headRefOid;
    if (o.sha && o.sha !== s.headRefOid) throw new UsageError(`head moved since review (${o.sha.slice(0, 7)} → ${s.headRefOid.slice(0, 7)}); review again`);
    requireYes(`squash-merge ${url} at ${sha.slice(0, 7)} and delete ${s.headRefName}`);
    await prs.mergePr(gh, url, sha);
    out(o.json ? { merged: true, url, sha } : `merged ${url} (${sha.slice(0, 7)})`);
    return 0;
  },

  async fix() {
    const a = needAgent(load(cfg), pos[0]);
    const url = prs.pickPr(a, o.pr);
    let request = o.prompt;
    if (o.rebase) request = prs.REBASE_REQUEST((await prs.prState(gh, url)).baseRefName);
    if (!request) throw new UsageError('--prompt TEXT or --rebase required');
    requireYes(`comment "@cursor ${request.slice(0, 60)}…" on ${url}`);
    await prs.askCursor(gh, url, request);
    out(`asked @cursor on ${url}`);
    return 0;
  },

  async followup() {
    const a = needAgent(load(cfg), pos[0]);
    if (!o.prompt) throw new UsageError('--prompt TEXT required');
    requireYes(`${o.steer ? 'steer' : 'follow-up run'} for ${a.agentId}`);
    const log = makeLogger();
    const { api } = apiCtx(log);
    const body = { prompt: { text: o.prompt }, ...(o.steer ? { delivery: 'steer' } : {}) };
    const res = await api.createRun(a.agentId as string, body);
    const newRun = res?.run?.id || res?.runId || null;
    await update(cfg, (reg) => {
      const r = reg.agents[a.agentId as string];
      if (newRun && newRun !== r.runId) {
        pushHistory(r, { runId: newRun, from: r.status, to: res?.run?.status || 'CREATING', via: o.steer ? 'steer' : 'followup' });
        r.runId = newRun; r.status = res?.run?.status || 'CREATING';
        r.runs[newRun] = { status: r.status, createdAt: nowIso() };
      }
      r.finalized = false; r.poll.nextAt = 0; r.poll.unchanged = 0;
    });
    out(o.json ? res : `${o.steer ? `steer: ${res?.delivery}` : 'follow-up'} ${newRun ? short(newRun) : ''}`);
    return 0;
  },

  async cancel() {
    const a = needAgent(load(cfg), pos[0]);
    requireYes(`cancel run ${a.runId} of ${a.agentId}`);
    const { api } = apiCtx(makeLogger());
    await api.cancelRun(a.agentId as string, a.runId as string);
    await update(cfg, (reg) => { reg.agents[a.agentId as string].poll.nextAt = 0; });
    out(`cancel requested for ${short(a.runId)}`);
    return 0;
  },

  async archive() {
    const a = needAgent(load(cfg), pos[0]);
    requireYes(`archive ${a.agentId}`);
    const { api } = apiCtx(makeLogger());
    await api.archiveAgent(a.agentId as string);
    await update(cfg, (reg) => {
      const current = reg.agents[a.agentId as string];
      current.archived = true;
      if (current.runId === a.runId) stampArchive(current);
    });
    out(`archived ${a.agentId}`);
    return 0;
  },
};

async function treeOrArch(mode: string): Promise<number> {
  let cur; let base = null; let label;
  if (o.local) {
    cur = localSource(o.local);
    label = o.local;
    base = gitRefSource(o.local, o['base-ref'] || 'HEAD');
  } else if (o.gh || pos[0]) {
    // Agent work on GitHub, located from the public REST run snapshot (Run.git.branches[] → repoUrl + branch).
    let repo: string | undefined = o.gh; let ref: string | null | undefined = o.ref;
    if (pos[0]) {
      const a = needAgent(load(cfg), pos[0]);
      const b = (a.git?.branches || []).find((x) => !repo || x.repoUrl?.endsWith(repo)) || null;
      if (b) { repo ??= (b.repoUrl as string).replace(/^(https?:\/\/)?github\.com\//, '').replace(/\.git$/, ''); ref ??= b.branch; }
      label = `${a.label} (${a.agentId})`;
    }
    if (!repo || !ref) throw new UsageError('no pushed branch known for this agent yet (Run.git.branches is empty); pass --gh OWNER/REPO --ref BRANCH');
    try { execFileSync('gh', ['api', `repos/${repo}/branches/${encodeURIComponent(ref)}`, '--silent']); } catch {
      throw new UsageError(`branch ${ref} is not on GitHub yet (Cursor assigns the name before the first push)`);
    }
    cur = ghRefSource(repo, ref);
    label = `${label ? `${label} → ` : ''}${repo}@${ref}`;
    base = ghRefSource(repo, o['base-ref'] || 'main');
  } else {
    throw new UsageError('tree/arch need --local DIR or --gh OWNER/REPO (agent work is read from its pushed branch)');
  }
  const [curList, baseList, changes] = await Promise.all([cur.list(), base ? base.list() : null, cur.modified ? cur.modified(o['base-ref'] || (o.gh ? 'main' : 'HEAD')) : new Map()]);
  const files = diffTrees({ base: baseList, current: curList, changes });
  const head = `${mode} · ${label}\nsource: ${cur.kind}${base ? `  vs  base: ${base.kind}` : '  (no base: change status unknown)'}`;
  if (mode === 'tree') {
    out(`${head}\n\n${renderTree(files, { maxDepth: Number(o.depth) || 4, color: process.stdout.isTTY })}`);
  } else {
    const ol = await outline(files, { readFile: cur.readFile });
    out(o.json ? { source: cur.kind, base: base?.kind ?? null, ...ol } : `${head}\n\n${renderOutline(ol)}`);
  }
  return 0;
}

function view(a: AgentRecord) {
  const run = a.runs?.[a.runId as string] || {};
  return {
    agentId: a.agentId, label: a.label, batch: a.batch, phase: a.phase, status: a.status, runId: a.runId,
    finalized: a.finalized, missing: a.missing, url: a.url, pane: a.pane, result: run.result ?? null,
    durationMs: run.durationMs ?? null, usage: run.usage ?? null, usageNote: run.usageNote ?? null,
    branches: a.git?.branches || [], gitDelta: run.gitDelta ?? null, exitCode: exitCodeFor(a),
    lastError: a.lastError, createError: a.createError ?? null,
  };
}

function daemonInfo() {
  let pid = null;
  try { pid = Number(fs.readFileSync(cfg.pidPath, 'utf8').trim()) || null; } catch { /* none */ }
  return { running: processAlive(pid), pid };
}

async function claimPidfile() {
  ensureDir(cfg.dir);
  for (let i = 0; i < 2; i += 1) {
    try {
      fs.writeFileSync(cfg.pidPath, String(process.pid), { flag: 'wx', mode: 0o600 });
      return true;
    } catch (e: unknown) {
      if (caught(e).code !== 'EEXIST') throw e;
      if (daemonInfo().running) return false;
      fs.rmSync(cfg.pidPath, { force: true }); // stale
    }
  }
  return false;
}

async function runDaemon({ once }: { once: boolean }): Promise<number> {
  const logFile = o.log ? fs.createWriteStream(o.log, { flags: 'a', mode: 0o600 }) : null;
  const log = makeLogger({ stream: process.stdout, file: logFile, quiet: Boolean(o.quiet) });
  let ctx;
  try { ctx = apiCtx(log); } catch (e: unknown) {
    log.error(caught(e).message); return EXIT.AUTH;
  }
  ctx.useIndex = !o['no-index'];
  if (!once && !(await claimPidfile())) {
    log.info(`tracker already running for ${cfg.dir} (pid ${daemonInfo().pid}); not starting another`);
    return EXIT.ALREADY_RUNNING;
  }
  const ac = new AbortController();
  const stop = () => ac.abort();
  process.once('SIGINT', stop); process.once('SIGTERM', stop); process.once('SIGHUP', stop); // pane closed
  const dash = new DashboardWriter(cfg.dashboardPath);
  log.info(`tracker ${once ? 'tick' : 'watch'} · dir ${cfg.dir} · budget ${cfg.rpm} req/min`);
  let code = 0;
  try {
    for (;;) {
      try {
        const { events, polled } = await tick(ctx);
        if (events.length) {
          await update(cfg, (reg) => {
            reg.meta.events = [...(reg.meta.events || []), ...events.map((e) => ({ at: nowIso(), ...e }))].slice(-30);
          });
          for (const e of events) log.info(`${short(e.agentId)} ${e.label || ''}: ${e.from || '∅'} → ${e.to}`);
        }
        if (polled) log.debug(`polled ${polled}, requests so far ${ctx.limiter.count}`);
      } catch (e) {
        if (e instanceof FatalAuth || (e instanceof ApiError && e.status === 401)) { log.error(`authentication failed: ${e.message}`); code = EXIT.AUTH; break; }
        log.error(`tick failed: ${redact(caught(e).stack || caught(e).message)}`);
      }
      const reg = load(cfg);
      dash.write(render(reg, reg.meta.events || []));
      if (once) break;
      if (o['exit-when-done']) {
        const agg = aggregate(cfg);
        if (agg.allDone) {
          fs.writeFileSync(cfg.reportPath, toMarkdown(agg), { mode: 0o600 });
          log.info(`all ${agg.agents} agent(s) terminal; report → ${cfg.reportPath}`);
          break;
        }
      }
      await sleep(cfg.tickMs, ac.signal);
      if (ac.signal.aborted) { log.info('stopping'); break; }
    }
  } finally {
    if (!once) {
      try { if (fs.readFileSync(cfg.pidPath, 'utf8').trim() === String(process.pid)) fs.rmSync(cfg.pidPath); } catch { /* */ }
    }
    logFile?.end();
  }
  return code;
}

class UsageError extends Error {}

const fn = commands[cmd];
if (!fn || o.help) { process.stdout.write(HELP); process.exit(cmd && !fn ? EXIT.USAGE : 0); }
try {
  const code = await fn();
  process.exitCode = code ?? 0;
} catch (e: unknown) {
  if (e instanceof UsageError) { process.stderr.write(`${e.message}\n`); process.exitCode = EXIT.USAGE; }
  else if (e instanceof AuthError || (e instanceof ApiError && e.status === 401)) { process.stderr.write(`${redact(e.message)}\n`); process.exitCode = EXIT.AUTH; }
  else { process.stderr.write(`error: ${redact(caught(e).message)}\n`); process.exitCode = 1; }
}
