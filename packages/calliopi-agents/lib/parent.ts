// The delegating side: the subagent tool. Each task becomes a child Pi in a multiplexer pane, with
// its record, system prompt and session file prepared first. In the foreground the tool waits and
// returns the results; in the background it returns at once and the model is woken as each child
// ends (as /cl-run does for commands). A child that may delegate gets the same tool, one level down.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Type } from 'typebox';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import {
  FILES, MARK, STATUS_TEXT, budgetFor, createAgent, mayDelegate, postInbox, readAgent, resolveModel, resolveTools, resultForParent, roleGuidelines, setPane,
  type AgentRecord, type AgentRole, type ContextMode, type FullBudget,
} from '@calliopi/core/agents';
import { detectMultiplexer, MULTIPLEXER_NAMES, type Exec } from '@calliopi/core/multiplexer';
import { loadCatalog } from '#lib/catalog.ts';
import { FINISH_TOOL, childSystemPrompt } from '#lib/contract.ts';
import { PROMPT_FILE, childCommand, extensionArgs, piInvocation, prepareSession } from '#lib/launch.ts';

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

export function installParent(pi: ExtensionAPI, place: Place, opts: { root: () => string; cwd: string; onSpawned?: OnSpawned }) {
  const exec: Exec = (command, args, options) => pi.exec(command, args, options);
  const approved = new Set<string>();
  const watched = new Map<string, fs.FSWatcher | undefined>();
  let delegations = 0;
  let poll: NodeJS.Timeout | undefined;

  /** A background child ended: tell the model at once, as /cl-run does. */
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
    let w: fs.FSWatcher | undefined;
    try { w = fs.watch(dir, (_e, file) => { if (!file || file === FILES.result) check(); }); } catch { /* the poll covers it */ }
    watched.set(dir, w);
    poll ??= setInterval(check, 1000);
  };
  pi.on('session_shutdown', () => { for (const w of watched.values()) w?.close(); watched.clear(); clearInterval(poll); });

  const roles = loadCatalog(opts.cwd).roles;
  const offered = place.depth === 0 ? [...roles.values()] : [...roles.values()].filter(r => mayDelegate(place.depth, place.role, r.name).ok);

  pi.registerTool({
    name: SUBAGENT_TOOL,
    label: 'Subagent',
    description: [
      `Delegate tasks to subagents: each runs as its own Pi in a terminal pane, with a fresh context, and reports back through ${FINISH_TOOL}.`,
      `Up to ${MAX_TASKS} tasks per call run in parallel. background: true returns at once and you are told as each one ends; otherwise this waits for all.`,
      `Roles: ${offered.map(r => `${r.name} (${r.description})`).join('; ') || 'none'}.`,
    ].join(' '),
    promptSnippet: 'Delegate self-contained tasks to subagents (separate Pi processes) and get their results',
    promptGuidelines: roleGuidelines(SUBAGENT_TOOL, offered),
    parameters: Type.Object({
      tasks: Type.Array(Task, { minItems: 1, maxItems: MAX_TASKS }),
      background: Type.Optional(Type.Boolean({ description: 'Return at once; you are told when each ends. Default false: wait for all.' })),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const catalog = loadCatalog(ctx.cwd).roles;
      const fail = (text: string) => ({ content: [{ type: 'text' as const, text }], details: undefined, isError: true });
      if (delegations + params.tasks.length > MAX_PER_SESSION) return fail(`This session may delegate at most ${MAX_PER_SESSION} tasks; ${delegations} already were.`);
      const chosen: AgentRole[] = [];
      for (const t of params.tasks) {
        const role = catalog.get(t.role);
        if (!role) return fail(`Unknown role "${t.role}". Roles: ${[...catalog.keys()].join(', ')}.`);
        const may = mayDelegate(place.depth, place.role, role.name);
        if (!may.ok) return fail(may.why);
        chosen.push(role);
      }
      for (const [i, role] of chosen.entries()) {
        if (role.approval === 'none' || (role.approval === 'once' && approved.has(role.name))) continue;
        if (!ctx.hasUI) return fail(`Role ${role.name} needs the user's approval, and there is no UI to ask.`);
        const ok = await ctx.ui.confirm('서브에이전트에 맡길까요?', `${role.name}: ${params.tasks[i]!.task}`);
        if (!ok) return fail(`The user declined delegating to ${role.name}.`);
        approved.add(role.name);
      }
      const mux = await detectMultiplexer({ exec });
      if (!mux) return fail(`Subagents run in a terminal multiplexer pane (${MULTIPLEXER_NAMES}); this Pi is not in one.`);
      const parentModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
      const parentTools = pi.getAllTools().map(t => t.name).filter(n => n !== SUBAGENT_TOOL && n !== FINISH_TOOL);
      const root = place.root ?? ctx.sessionManager.getSessionId();
      const left = place.budgetLeft?.();

      const started: AgentRecord[] = [];
      for (const [i, t] of params.tasks.entries()) {
        const role = chosen[i]!;
        const model = resolveModel(role, t.model, parentModel ?? '');
        if (!model.model) return fail('No model to run the subagent with: pick a model, or set one on the role.');
        const record = createAgent(opts.root(), {
          root, parent: place.parentId, depth: place.depth + 1, role: role.name, model: model.model, modelSource: model.source,
          thinking: role.thinking, tools: resolveTools(role, parentTools), cwd: ctx.cwd, createdAt: Date.now(),
          call: { task: t.task, done: t.done, budget: budgetFor(t.budget, role.budget, left).budget, context: (t.context ?? role.context) as ContextMode, background: !!params.background, parentToolCallId: toolCallId },
          pane: null,
        });
        fs.writeFileSync(path.join(record.dir, PROMPT_FILE), childSystemPrompt(record.meta, role.instructions), { mode: 0o600 });
        prepareSession(record.dir, record.meta, ctx.sessionManager.getSessionFile());
        const command = childCommand(record.dir, record.meta, { pi: piInvocation(), extensions: [AGENTS_EXTENSION, ...extensionArgs()] });
        try {
          const label = `agent ${record.meta.id}`;
          const { paneId } = mux.openBackground ? await mux.openBackground(exec, { command, cwd: ctx.cwd, label })
            : await mux.openSide(exec, { command, cwd: ctx.cwd, label, ratio: 45, focus: false });
          if (paneId) setPane(record.dir, { ...mux.self, pane: paneId });
        } catch (error) {
          return fail(`Could not open a pane for ${record.meta.id}: ${error instanceof Error ? error.message : String(error)}`);
        }
        delegations++;
        started.push(readAgent(record.dir) ?? record);
      }
      opts.onSpawned?.(started, ctx);

      if (params.background) {
        for (const r of started) watch(r.dir);
        const text = `Started ${started.map(r => `${r.meta.id} (${r.meta.role})`).join(', ')} in the background. You will be told as each one ends; carry on meanwhile.`;
        return { content: [{ type: 'text', text }], details: { agents: started.map(r => r.meta.id) } };
      }

      // Foreground: wait for every child, showing progress; an abort stops them.
      const onAbort = () => { for (const r of started) if (!readAgent(r.dir)?.result) postInbox(r.dir, { id: `stop-${Date.now()}`, kind: 'stop', text: '', at: Date.now() }); };
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        for (;;) {
          const now = started.map(r => readAgent(r.dir) ?? r);
          onUpdate?.({ content: [{ type: 'text', text: now.map(r => agentLine(r)).join('\n') }], details: { agents: now.map(r => r.meta.id) } });
          if (now.every(r => r.result)) {
            const text = now.map(r => resultForParent(r.meta, r.result!)).join('\n\n---\n\n');
            return { content: [{ type: 'text', text }], details: { agents: now.map(r => r.meta.id) } };
          }
          if (signal?.aborted) {
            await new Promise(res => setTimeout(res, 300));
            const ended = started.map(r => readAgent(r.dir) ?? r);
            return { content: [{ type: 'text', text: `Stopped: ${ended.map(r => agentLine(r)).join('; ')}` }], details: { agents: ended.map(r => r.meta.id) } };
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
      return lines.map(l => truncate(l, width));
    },
    invalidate() {},
  }));
}

/** Cut a styled line to `width` cells (wide characters count two); escapes are kept. */
function truncate(line: string, width: number): string {
  let cells = 0, out = '';
  for (const part of line.split(/(\x1b\[[0-9;:]*m)/)) {
    if (part.startsWith('\x1b[')) { out += part; continue; }
    for (const ch of part) {
      const w = /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFF00-\uFF60\uFFE0-\uFFE6]/.test(ch) ? 2 : 1;
      if (cells + w > width) return `${out}\x1b[0m`;
      out += ch; cells += w;
    }
  }
  return out;
}
