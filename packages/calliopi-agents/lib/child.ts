// The child side: a Pi started with CALLIOPI_AGENT_DIR works on one task and reports through its
// agent directory. It submits its own task (after the parent's background, when that comes in time),
// keeps status.json current, takes the parent's messages from its inbox in order and once, records
// every model request, holds itself to its budget, and ends with result.json — its own finish, or
// what the harness saw when it stopped without one.
import fs from 'node:fs';
import path from 'node:path';
import { Type } from 'typebox';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import {
  FILES, classifyEnd, descendantTokens, encodeRequest, exceeded, listAgents, markDelivered, nearLimit, readAgent, readDelivered, readInbox, writeResult, writeStatus,
  type AgentMeta, type AgentStatus, type EndFacts, type InboxMessage,
} from '@calliopi/core/agents';
import { FINISH_REMINDER, FINISH_TOOL, briefingMessage, contractReminder, steerMessage, taskMessage, wrapUpReminder } from '#lib/contract.ts';

/** How long the task waits for the parent's background before it starts without it. */
export const BRIEFING_WAIT_MS = 10_000;
const WATCH_MS = 1000;

type Usage = { input?: number; output?: number; cacheWrite?: number };
/** Tokens a request cost the budget: what was sent fresh and what came back; cache reads are not counted. */
export const spent = (u: Usage | undefined) => (u ? (u.input ?? 0) + (u.output ?? 0) + (u.cacheWrite ?? 0) : 0);

const lastText = (messages: unknown[]): string => {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { role?: string; content?: unknown };
    if (m?.role !== 'assistant' || !Array.isArray(m.content)) continue;
    const text = m.content.flatMap((c: { type?: string; text?: string }) => (c?.type === 'text' && c.text ? [c.text] : [])).join('\n').trim();
    if (text) return text;
  }
  return '';
};

/**
 * `busy`: this child has subagents of its own still running. It then neither ends nor is reminded to
 * finish (their results are on their way) and is not idle.
 */
export function installChild(pi: ExtensionAPI, dir: string, busy: () => boolean = () => false): void {
  const record = readAgent(dir);
  if (!record) throw new Error(`${dir}: 에이전트 기록(meta.json)이 없습니다.`);
  const meta: AgentMeta = record.meta;
  const startedAt = Date.now();
  let status: AgentStatus = { state: 'running', turns: 0, tokens: 0, startedAt, updatedAt: startedAt, pid: process.pid };
  let lastEventAt = startedAt;
  let ended = false, taskSent = false, reminded = false, wrapUpSent = false;
  let lastPayload: unknown, requestSeq = 0;
  let ctxRef: ExtensionContext | undefined;
  let poll: NodeJS.Timeout | undefined, watcher: fs.FSWatcher | undefined;
  let lastAnswer = '';
  let runningTools = 0; // a tool at work (a long command, a delegation waiting on its children) is not idleness
  const registry = path.dirname(path.dirname(dir));
  let below = { at: 0, tokens: 0 }; // what its own subagents spent, read at most every 2s
  const belowTokens = () => {
    if (Date.now() - below.at > 2000) below = { at: Date.now(), tokens: descendantTokens(listAgents(registry, meta.root), meta.id) };
    return below.tokens;
  };
  let briefingWait: NodeJS.Timeout | undefined;

  const save = (patch: Partial<AgentStatus>) => {
    status = { ...status, ...patch, updatedAt: Date.now() };
    if (!ended) writeStatus(dir, status);
  };
  const touch = (activity?: string) => { lastEventAt = Date.now(); if (activity !== undefined && activity !== status.activity) save({ activity }); };
  /** Its own use, plus the tokens its own subagents spent: what it delegates counts against its budget. */
  const usage = () => ({
    turns: status.turns, ms: Date.now() - startedAt, tokens: status.tokens + belowTokens(),
    idleMs: runningTools > 0 || busy() ? 0 : Date.now() - lastEventAt,
  });

  const end = (facts: EndFacts) => {
    if (ended) return;
    ended = true; // before writing: a failed write must not end it again on every tick
    const { status: end, reason } = classifyEnd(facts);
    const u = usage();
    let written = false;
    try {
      written = writeResult(dir, {
        status: end, reason, summary: facts.finish?.summary ?? facts.lastText ?? lastAnswer,
        evidence: facts.finish?.evidence, artifacts: facts.finish?.artifacts,
        usage: { turns: u.turns, tokens: u.tokens, ms: u.ms }, endedAt: Date.now(),
      });
    } catch (error) {
      // Not written: exiting anyway lets the parent record what it saw (lib/fleet.ts).
      ctxRef?.ui.notify(`결과를 쓰지 못했습니다: ${error instanceof Error ? error.message : String(error)}`, 'error');
    } finally {
      clearInterval(poll); clearInterval(briefingWait); watcher?.close();
      // Its work is over: the Pi exits (its last screen stays with the parent, in /cl-agents).
      setTimeout(() => ctxRef?.shutdown?.(), 500).unref?.();
    }
    if (written) ctxRef?.ui.notify(`부모에게 결과를 보냈습니다: ${end}${reason ? ` (${reason})` : ''}`, end === 'done' ? 'info' : 'warning');
  };

  // Handed over first, then marked: a failure in between leaves it to be delivered again (at least once;
  // `delivered` ids keep it from going twice once marked).
  const deliver = (message: InboxMessage) => {
    if (message.kind === 'stop') {
      markDelivered(dir, message);
      end({ stopped: true });
      ctxRef?.abort();
      return;
    }
    if (message.kind === 'briefing' && !message.text.trim()) { save({ briefing: { at: Date.now(), how: 'failed' } }); markDelivered(dir, message); return; } // no background: stop waiting
    const text = message.kind === 'briefing' ? briefingMessage(message.text, taskSent) : steerMessage(message.text);
    if (message.kind === 'briefing') save({ briefing: { at: Date.now(), how: taskSent ? 'steer' : 'first' } });
    if (!taskSent) pi.sendMessage({ customType: 'calliopi-briefing', content: text, display: true });
    else if (ctxRef?.isIdle()) pi.sendUserMessage(text);
    else pi.sendUserMessage(text, { deliverAs: 'steer' });
    markDelivered(dir, message);
  };

  /** New inbox messages in seq order, each once; a briefing waits for the task unless it is late. */
  const drain = () => {
    if (ended) return;
    // By id, not by the last seq: a steer that came before the task is passed over until the task has
    // gone (a briefing behind it still goes first), and is then delivered in its turn.
    const delivered = readDelivered(dir).ids;
    for (const m of readInbox(dir)) {
      if (delivered.includes(m.id) || (m.kind === 'steer' && !taskSent)) continue;
      deliver(m);
      if (ended) return;
    }
  };

  const sendTask = () => {
    if (taskSent || ended) return;
    if (!status.briefing && meta.call.context === 'summary') save({ briefing: { at: Date.now(), how: 'missed' } });
    taskSent = true;
    pi.sendUserMessage(taskMessage(meta));
  };

  const watchdog = () => {
    if (ended) return;
    drain();
    const u = usage();
    const over = exceeded(meta.call.budget, u);
    if (over === 'idleMinutes' && ctxRef?.isIdle() && !taskSent) return; // still waiting for its task to be sent
    if (over) { end(over === 'idleMinutes' ? { idle: true, lastText: lastAnswer } : { exceeded: over, lastText: lastAnswer }); ctxRef?.abort(); }
  };

  pi.registerTool({
    name: FINISH_TOOL,
    label: 'Finish',
    description: 'Report the result of your task to the agent that delegated it, and end your work. Call it once, when the task is done or cannot be done.',
    parameters: Type.Object({
      status: Type.Union([Type.Literal('done'), Type.Literal('partial'), Type.Literal('blocked')], { description: 'done: the task is complete; partial: some of it; blocked: it cannot be done as asked.' }),
      summary: Type.String({ description: 'What you found or did, written for the delegator, who has not seen your transcript.' }),
      evidence: Type.Optional(Type.String({ description: 'How to check it: paths, commands and their results, sources.' })),
      artifacts: Type.Optional(Type.Array(Type.String(), { description: 'Files or branches you produced.' })),
    }),
    async execute(_id, params) {
      end({ finish: { status: params.status, summary: params.summary, evidence: params.evidence, artifacts: params.artifacts } });
      return { content: [{ type: 'text', text: 'Reported. Your work on this task is over; stop here.' }], details: undefined, terminate: true };
    },
  });

  pi.on('session_start', async (_event, ctx) => {
    ctxRef = ctx;
    pi.setSessionName(`${meta.role} · ${meta.call.task.slice(0, 60)}`);
    save({});
    try { watcher = fs.watch(path.join(dir, FILES.inbox), () => drain()); } catch { /* the poll covers it */ }
    poll = setInterval(watchdog, WATCH_MS);
    drain(); // a briefing may already be there
    if (meta.call.context !== 'summary' || status.briefing) return sendTask();
    ctx.ui.setStatus('calliopi-agent', '배경 대기 중…');
    const deadline = Date.now() + BRIEFING_WAIT_MS;
    briefingWait = setInterval(() => {
      if (status.briefing || Date.now() >= deadline || ended) {
        clearInterval(briefingWait);
        ctx.ui.setStatus('calliopi-agent', undefined);
        sendTask();
      }
    }, 100);
  });

  pi.on('message_update', (event) => {
    const type = (event as { assistantMessageEvent?: { type?: string } }).assistantMessageEvent?.type ?? '';
    touch(type.startsWith('thinking') ? 'thinking' : type.startsWith('text') ? 'writing' : undefined);
  });
  pi.on('tool_execution_start', (event) => { runningTools++; touch(event.toolName); });
  pi.on('tool_execution_update', () => touch());
  pi.on('tool_execution_end', () => { runningTools = Math.max(0, runningTools - 1); touch(); });
  pi.on('message_end', (event) => {
    const m = event.message as { role?: string; usage?: Usage };
    if (m.role === 'assistant') { touch(); save({ tokens: status.tokens + spent(m.usage) }); }
  });
  pi.on('turn_end', () => {
    touch();
    save({ turns: status.turns + 1 });
    const near = nearLimit(meta.call.budget, usage());
    if (near.length && !wrapUpSent && !ended) { wrapUpSent = true; pi.sendUserMessage(wrapUpReminder(near), { deliverAs: 'steer' }); }
    watchdog();
  });
  // The contract at the end of every request, not stored: the purpose stays in view however long the
  // context grows and whatever compaction makes of the start; only the tail changes, so the cache holds.
  pi.on('context', (event) => {
    if (!taskSent || ended) return;
    return { messages: [...event.messages, { role: 'user', content: [{ type: 'text', text: contractReminder(meta, usage()) }], timestamp: Date.now() }] };
  });
  pi.on('before_provider_request', (event) => {
    const record = encodeRequest(lastPayload, event.payload, ++requestSeq, Date.now());
    lastPayload = event.payload;
    fs.appendFileSync(path.join(dir, FILES.requests), `${JSON.stringify(record)}\n`, { mode: 0o600 });
  });
  pi.on('agent_end', (event) => {
    touch('');
    lastAnswer = lastText(event.messages) || lastAnswer;
    if (ended || busy()) return; // its own subagents are still working: their results will wake it
    // Ended without finish: remind once, then report it as unanswered.
    if (!reminded) { reminded = true; pi.sendUserMessage(FINISH_REMINDER, { deliverAs: 'followUp' }); return; }
    end({ lastText: lastAnswer });
  });
  pi.on('session_shutdown', () => { clearInterval(briefingWait); if (!ended) end({ stopped: true, lastText: lastAnswer }); });
}
