// The delegating side: the subagent tool. Each task becomes a child Pi in a pseudo-terminal this Pi
// holds (lib/fleet.ts) — no pane opens; /cl-agents shows them. Everything is checked before anything
// starts, then the children start together. By default the tool returns at once and the model is
// woken as each child ends (as /cl-run does for commands); in the foreground it waits and returns
// the results. A child that may delegate gets the same tool, one level down.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Type } from 'typebox';
import { truncateToWidth } from '@earendil-works/pi-tui';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import {
  FILES, MARK, STATUS_TEXT, budgetFor, createAgent, mayDelegate, readAgent, resolveModel, resolveTools, resultForParent, roleGuidelines, writeResult,
  type AgentRecord, type AgentRole, type ContextMode, type FullBudget,
} from '@calliopi/core/agents';
import { Fleet } from '#lib/fleet.ts';
import { loadCatalog } from '#lib/catalog.ts';
import { FINISH_TOOL, childSystemPrompt } from '#lib/contract.ts';
import { PROMPT_FILE, childSpawn, extensionArgs, piInvocation, prepareSession, type ChildLaunch } from '#lib/launch.ts';

export const SUBAGENT_TOOL = 'subagent';
/** Tasks in one call, and delegations in one session: the caps on how wide a tree grows. */
export const MAX_TASKS = 4;
export const MAX_PER_SESSION = 20;
const AGENTS_EXTENSION = fileURLToPath(new URL('../extensions/agents.ts', import.meta.url));

/** Where this Pi stands in a tree: the top Pi, or a child that may delegate in turn. */
export interface Place {
  depth: number;
  parentId: string | null;
  /** Session id of the top Pi; undefined for the top Pi itself (its own session id). */
  root?: string;
  role?: AgentRole;
  /** What this Pi has left of its own budget; undefined for the top Pi. */
  budgetLeft?: () => FullBudget;
}

/** Called once per call with the children it started (the briefing hooks in here). */
export type OnSpawned = (records: AgentRecord[], ctx: ExtensionContext) => void;

const Task = Type.Object({
  role: Type.String({ description: 'A role from the catalog.' }),
  task: Type.String({ description: 'What to do, self-contained: the child has not seen your conversation.' }),
  done: Type.Optional(Type.String({ description: 'When the task is done, as something that can be checked.' })),
  model: Type.Optional(Type.String({ description: 'provider/model; omit for the role default (or yours).' })),
  context: Type.Optional(Type.Union([Type.Literal('none'), Type.Literal('summary')], { description: 'none: the task alone; summary (role default): plus a summary of your work as background.' })),
  budget: Type.Optional(Type.Object({
    turns: Type.Optional(Type.Number()), minutes: Type.Optional(Type.Number()), tokens: Type.Optional(Type.Number()),
  }, { description: 'Limits; omit for the role default. Never more than you have left.' })),
});

export const registryRoot = (agentDir: string) => path.join(agentDir, 'calliopi-agents');

const elapsed = (ms: number) => (ms < 60_000 ? `${Math.round(ms / 1000)}초` : `${Math.floor(ms / 60_000)}분 ${Math.round((ms % 60_000) / 1000)}초`);

/** One line per child, for progress and notices. */
export function agentLine(r: AgentRecord, now = Date.now()): string {
  const state = r.result?.status ?? r.status?.state ?? 'starting';
  const took = r.result ? r.result.usage.ms : now - (r.status?.startedAt ?? r.meta.createdAt);
  const what = r.result ? STATUS_TEXT[r.result.status] : r.status?.activity || (state === 'starting' ? '시작 중' : '실행 중');
  return `${MARK[state]} ${r.meta.id} · ${what} · ${elapsed(took)}${r.status ? ` · 턴 ${r.status.turns}` : ''}`;
}

export interface ParentOptions {
  root: () => string;
  cwd: string;
  onSpawned?: OnSpawned;
  /** How children are started; tests pass their own model and scenario. */
  launch?: Partial<ChildLaunch>;
}

export function installParent(pi: ExtensionAPI, place: Place, opts: ParentOptions): Fleet {
  const fleet = new Fleet();
  const approved = new Set<string>();
  const watched = new Map<string, fs.FSWatcher | undefined>();
  let delegations = 0;
  let poll: NodeJS.Timeout | undefined;

  /** A child ended after the tool returned: tell the model at once, as /cl-run does. */
  const announce = (r: AgentRecord) => pi.sendMessage(
    { customType: 'calliopi-agent', content: resultForParent(r.meta, r.result!), display: true, details: { id: r.meta.id, line: agentLine(r) } },
    { deliverAs: 'steer', triggerTurn: true },
  );
  const check = () => {
    for (const dir of [...watched.keys()]) {
      const r = readAgent(dir);
      if (r && !r.result) continue;
      watched.get(dir)?.close(); watched.delete(dir);
      if (r) announce(r);
    }
    if (!watched.size) { clearInterval(poll); poll = undefined; }
  };
  const watch = (dir: string) => {
    if (watched.has(dir)) return;
    let w: fs.FSWatcher | undefined;
    try { w = fs.watch(dir, (_e, file) => { if (!file || file === FILES.result) check(); }); } catch { /* the poll covers it */ }
    watched.set(dir, w);
    poll ??= setInterval(check, 1000);
  };
  // Children live as long as this session of this extension: Pi quitting, and /new, /resume, /fork,
  // /reload (which replace this instance) end them; nothing would be left to hear from them.
  pi.on('session_shutdown', () => {
    for (const w of watched.values()) w?.close();
    watched.clear(); clearInterval(poll);
    fleet.dispose();
  });

  const roles = loadCatalog(opts.cwd).roles;
  const offered = place.depth === 0 ? [...roles.values()] : [...roles.values()].filter(r => mayDelegate(place.depth, place.role, r.name).ok);

  pi.registerTool({
    name: SUBAGENT_TOOL,
    label: 'Subagent',
    description: [
      `Delegate tasks to subagents: each runs as its own Pi with a fresh context and reports back through ${FINISH_TOOL}.`,
      `Up to ${MAX_TASKS} tasks per call run in parallel. By default this returns at once and you are told as each one ends, so you can carry on; background: false waits for all.`,
      `Roles: ${offered.map(r => `${r.name} (${r.description})`).join('; ') || 'none'}.`,
    ].join(' '),
    promptSnippet: 'Delegate self-contained tasks to subagents (separate Pi processes) and get their results',
    promptGuidelines: [
      ...roleGuidelines(SUBAGENT_TOOL, offered),
      `Use ${SUBAGENT_TOOL} in the background (the default) and carry on; set background: false only when your very next step needs the results.`,
    ],
    parameters: Type.Object({
      tasks: Type.Array(Task, { minItems: 1, maxItems: MAX_TASKS }),
      background: Type.Optional(Type.Boolean({ description: 'Default true: return at once; you are told when each ends. false: wait for all.' })),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const fail = (text: string) => ({ content: [{ type: 'text' as const, text }], details: undefined, isError: true });
      const background = params.background !== false;

      // 1. Check everything before anything starts: no child is left behind by a refusal.
      if (delegations + params.tasks.length > MAX_PER_SESSION) return fail(`This session may delegate at most ${MAX_PER_SESSION} tasks; ${delegations} already were.`);
      const catalog = loadCatalog(ctx.cwd).roles;
      const parentModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : '';
      const parentTools = pi.getAllTools().map(t => t.name).filter(n => n !== SUBAGENT_TOOL && n !== FINISH_TOOL);
      const left = place.budgetLeft?.();
      const plans = [];
      for (const t of params.tasks) {
        const role = catalog.get(t.role);
        if (!role) return fail(`Unknown role "${t.role}". Roles: ${[...catalog.keys()].join(', ')}.`);
        const may = mayDelegate(place.depth, place.role, role.name);
        if (!may.ok) return fail(may.why);
        const model = resolveModel(role, t.model, parentModel);
        if (!model.model) return fail('No model to run the subagent with: pick a model, or set one on the role.');
        const budget = budgetFor(t.budget, role.budget, left);
        if (budget.exhausted.length) return fail(`Not enough budget left to delegate (${budget.exhausted.join(', ')}); finish with what you have.`);
        plans.push({ t, role, model, budget: budget.budget });
      }
      for (const { t, role } of plans) {
        if (role.approval === 'none' || (role.approval === 'once' && approved.has(role.name))) continue;
        if (!ctx.hasUI) return fail(`Role ${role.name} needs the user's approval, and there is no UI to ask.`);
        if (!(await ctx.ui.confirm('서브에이전트에 맡길까요?', `${role.name}: ${t.task}`))) return fail(`The user declined delegating to ${role.name}.`);
        approved.add(role.name);
      }
      if (signal?.aborted) return fail('Cancelled before any subagent started.');

      // 2. Start them together.
      const root = place.root ?? ctx.sessionManager.getSessionId();
      const launch: ChildLaunch = { pi: piInvocation(), extensions: [AGENTS_EXTENSION, ...extensionArgs()], ...opts.launch };
      const records = plans.map(({ t, role, model, budget }) => {
        const record = createAgent(opts.root(), {
          root, parent: place.parentId, depth: place.depth + 1, role: role.name, model: model.model, modelSource: model.source,
          thinking: role.thinking, tools: resolveTools(role, parentTools), cwd: ctx.cwd, createdAt: Date.now(),
          call: { task: t.task, done: t.done, budget, context: (t.context ?? role.context) as ContextMode, background, parentToolCallId: toolCallId },
          pane: null,
        });
        fs.writeFileSync(path.join(record.dir, PROMPT_FILE), childSystemPrompt(record.meta, role.instructions), { mode: 0o600 });
        prepareSession(record.dir, record.meta, ctx.sessionManager.getSessionFile());
        return record;
      });
      const started = await Promise.allSettled(records.map(r => fleet.start(r, childSpawn(r.dir, r.meta, launch))));
      const failed = started.flatMap((s, i) => (s.status === 'rejected' ? [`${records[i]!.meta.id}: ${s.reason instanceof Error ? s.reason.message : String(s.reason)}`] : []));
      if (failed.length) {
        for (const r of records) {
          // The error first (the first result stands), so a child that did start and takes the stop
          // cannot record "stopped" instead; then stop it: all or none.
          writeResult(r.dir, { status: 'error', summary: '', reason: `시작하지 못함: ${failed.join('; ')}`, usage: { turns: 0, tokens: 0, ms: 0 }, endedAt: Date.now() });
          fleet.stop(r.meta.id);
        }
        return fail(`Could not start the subagents (${failed.join('; ')}); none is running.`);
      }
      delegations += records.length;
      opts.onSpawned?.(records, ctx);

      if (background) {
        for (const r of records) watch(r.dir);
        const text = `Started ${records.map(r => `${r.meta.id} (${r.meta.role})`).join(', ')}. You will be told as each one ends; carry on meanwhile. The user can watch them with /cl-agents.`;
        return { content: [{ type: 'text', text }], details: { agents: records.map(r => r.meta.id) } };
      }

      // 3. Foreground: wait for every child, showing progress. An abort stops them; whatever still
      // ends afterwards is announced like a background result.
      const onAbort = () => { for (const r of records) fleet.stop(r.meta.id); };
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort(); // aborted while starting: the listener would never fire
      try {
        for (;;) {
          const now = records.map(r => readAgent(r.dir) ?? r);
          onUpdate?.({ content: [{ type: 'text', text: now.map(r => agentLine(r)).join('\n') }], details: { agents: now.map(r => r.meta.id) } });
          if (now.every(r => r.result)) {
            const text = now.map(r => resultForParent(r.meta, r.result!)).join('\n\n---\n\n');
            return { content: [{ type: 'text', text }], details: { agents: now.map(r => r.meta.id) } };
          }
          if (signal?.aborted) {
            for (const r of now) if (!r.result) watch(r.dir);
            return { content: [{ type: 'text', text: `Stopping: ${now.map(r => agentLine(r)).join('; ')}. Any that still ends will be reported.` }], details: { agents: now.map(r => r.meta.id) } };
          }
          await new Promise(res => setTimeout(res, 500));
        }
      } finally {
        signal?.removeEventListener('abort', onAbort);
      }
    },
  });

  pi.registerMessageRenderer<{ id: string; line: string }>('calliopi-agent', (message, { expanded }, theme) => ({
    render(width: number) {
      const d = message.details;
      if (!d) return [];
      const text = typeof message.content === 'string' ? message.content : message.content.flatMap(c => (c.type === 'text' ? [c.text] : [])).join('\n');
      const lines = [theme.fg('accent', d.line), ...(expanded ? text.split('\n').map(l => theme.fg('dim', l)) : [])];
      return lines.map(l => truncateToWidth(l.replace(/\t/g, '  '), width));
    },
    invalidate() {},
  }));
  return fleet;
}
