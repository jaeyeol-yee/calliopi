// Optional real-time view of ONE run via SSE. Opt-in because each stream is a long-lived
// request per run. Reconnects with Last-Event-ID; on 410 stream_expired /
// stream_unavailable falls back to GET Run polling (slow, budgeted).
import { update, load, findAgent, pushHistory } from './registry.ts';
import { ApiError } from './api.ts';
import { EXIT, caught, isTerminal, nowIso, short, sleep } from './util.ts';
import type { FanoutConfig, GitSnapshot, Logger } from './types.ts';
import type { CursorApi } from './api.ts';

export async function* parseSSE(body: ReadableStream<Uint8Array> | null, signal?: AbortSignal): AsyncGenerator<{ id: string | null; event: string; data: string }> {
  const decoder = new TextDecoder();
  let buf = '';
  let ev: { id: string | null; event: string; data: string[] } = { id: null, event: 'message', data: [] };
  for await (const chunk of body as ReadableStream<Uint8Array>) {
    if (signal?.aborted) return;
    buf += decoder.decode(chunk, { stream: true });
    let i;
    while ((i = buf.search(/\r?\n/)) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(buf[i] === '\r' ? i + 2 : i + 1);
      if (line === '') {
        if (ev.data.length || ev.event !== 'message') yield { id: ev.id, event: ev.event, data: ev.data.join('\n') };
        ev = { id: null, event: 'message', data: [] };
        continue;
      }
      if (line.startsWith(':')) continue;
      const c = line.indexOf(':');
      const field = c < 0 ? line : line.slice(0, c);
      const value = c < 0 ? '' : line.slice(c + 1).replace(/^ /, '');
      if (field === 'id') ev.id = value;
      else if (field === 'event') ev.event = value;
      else if (field === 'data') ev.data.push(value);
    }
  }
}

interface SseResult {
  status?: string;
  text?: string | null;
  durationMs?: number | null;
  git?: GitSnapshot | null;
  name?: string;
  code?: string;
  message?: string;
}

async function recordResult(cfg: FanoutConfig, agentId: string, runId: string, data: SseResult): Promise<void> {
  await update(cfg, (reg) => {
    const a = reg.agents[agentId];
    if (!a) return;
    const prev = a.runs[runId] || {};
    a.runs[runId] = { ...prev, status: data.status, result: data.text ?? prev.result ?? null, durationMs: data.durationMs ?? prev.durationMs ?? null };
    if (data.git) a.git = data.git;
    if (a.runId === runId && a.status !== data.status) {
      pushHistory(a, { runId, from: a.status, to: data.status as string | null, via: 'sse' });
      a.status = data.status as string;
      a.statusChangedAt = nowIso();
    }
    // Leave `finalized` to the tracker, which also collects usage; poke it to poll soon.
    a.poll.nextAt = 0;
  });
}

export interface StreamCtx {
  cfg: FanoutConfig;
  api: CursorApi;
  log: Logger;
}

export async function stream(ctx: StreamCtx, needle: string, { out = process.stdout, showThinking = false, maxReconnects = 5 }: {
  out?: NodeJS.WritableStream; showThinking?: boolean; maxReconnects?: number;
} = {}): Promise<number> {
  const { cfg, api, log } = ctx;
  const a = findAgent(load(cfg), needle);
  if (!a?.runId) throw new Error(`no tracked run for ${needle}`);
  const agentId = a.agentId as string;
  const { runId } = a;
  let lastEventId: string | null = null;
  let reconnects = 0;
  const ac = new AbortController();
  process.once('SIGINT', () => ac.abort());

  for (;;) {
    let res: Response;
    try {
      res = await api.streamRun(agentId, runId, { lastEventId, signal: ac.signal });
    } catch (e: unknown) {
      if (e instanceof ApiError && (e.status === 410 || e.code === 'stream_expired' || e.code === 'stream_unavailable')) {
        out.write(`\n[stream ${e.code || e.status}] falling back to GET run polling\n`);
        return pollFallback(ctx, agentId, runId, out);
      }
      if (e instanceof ApiError && e.code === 'invalid_last_event_id') { lastEventId = null; continue; }
      if (ac.signal.aborted) return EXIT.USAGE;
      throw e;
    }
    const retention = res.headers.get('x-cursor-stream-retention-seconds');
    if (retention && reconnects === 0) log.debug(`stream retention ${retention}s`);

    // Heartbeat watchdog: no event for 90s → reconnect.
    const hb = new AbortController();
    let timer = setTimeout(() => hb.abort(), 90_000);
    const sig = AbortSignal.any([ac.signal, hb.signal]);
    let terminal: string | null = null;
    try {
      for await (const ev of parseSSE(res.body, sig)) {
        clearTimeout(timer); timer = setTimeout(() => hb.abort(), 90_000);
        if (ev.id) lastEventId = ev.id;
        let data: SseResult = {};
        try { data = ev.data ? JSON.parse(ev.data) as SseResult : {}; } catch { /* keep raw */ }
        switch (ev.event) {
          case 'status': out.write(`\n[status] ${data.status}\n`); break;
          case 'assistant': out.write(data.text ?? ''); break;
          case 'thinking': if (showThinking) out.write(data.text ?? ''); break;
          case 'tool_call': if (data.status !== 'running') out.write(`\n[tool] ${data.name} ${data.status}\n`); break;
          case 'error': out.write(`\n[error] ${data.code}: ${data.message}\n`); break;
          case 'result':
            terminal = data.status ?? null;
            out.write(`\n[result] ${data.status}\n`);
            await recordResult(cfg, agentId, runId, data);
            break;
          case 'done': clearTimeout(timer); return terminal && EXIT[terminal] !== undefined ? EXIT[terminal] : 0;
          default: break; // heartbeat, interaction_update
        }
      }
    } catch (e: unknown) {
      if (ac.signal.aborted) return EXIT.USAGE;
      log.debug(`stream interrupted: ${caught(e).message}`);
    } finally { clearTimeout(timer); }
    if (terminal) return EXIT[terminal] ?? 0;
    if (++reconnects > maxReconnects) {
      out.write('\n[stream] too many reconnects; falling back to polling\n');
      return pollFallback(ctx, agentId, runId, out);
    }
    await sleep(Math.min(30_000, 1000 * 2 ** reconnects), ac.signal);
  }
}

async function pollFallback(ctx: StreamCtx, agentId: string, runId: string, out: NodeJS.WritableStream): Promise<number> {
  const { cfg, api } = ctx;
  let last: string | null = null;
  for (;;) {
    const run = await api.getRun(agentId, runId);
    if (run.status !== last) { out.write(`[poll] ${short(runId)} ${run.status}\n`); last = run.status; }
    if (isTerminal(run.status)) {
      await recordResult(cfg, agentId, runId, { status: run.status, text: run.result, durationMs: run.durationMs, git: run.git });
      if (run.result) out.write(`\n${run.result}\n`);
      return EXIT[run.status] ?? 0;
    }
    await sleep(run.status === 'WAITING_FOR_BACKGROUND_WORK' ? 60_000 : 15_000);
  }
}

// ---------------------------------------------------------------------------
// Launch-time round trip for automation prompt swaps: wait until the new agent's first reply line
// `<calliopi_ack body_key prompt_key/>` shows up in the run stream (or its final result).
import { parseAck } from './util.ts';
import type { AckRecord } from './types.ts';

export async function waitForAck(api: CursorApi, agentId: string, fanoutKey: string, { timeoutMs = 180_000, pollMs = 3000, signal }: {
  timeoutMs?: number; pollMs?: number; signal?: AbortSignal;
} = {}): Promise<AckRecord> {
  const deadline = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]);
  const verdict = (ack: { bodyKey: string | null; promptKey: string | null }): AckRecord => ({
    status: ack.bodyKey === fanoutKey && ack.promptKey === fanoutKey ? 'ok' : 'mismatch', bodyKey: ack.bodyKey, promptKey: ack.promptKey, at: nowIso(),
  });
  try {
    // The webhook returns only the agent id; its first run appears shortly after.
    let runId: string | undefined;
    while (!runId) {
      if (deadline.aborted) return { status: 'timeout', at: nowIso(), message: 'run did not appear' };
      runId = (await api.getAgent(agentId)).latestRunId;
      if (!runId) await sleep(pollMs, deadline);
    }
    let text = '', lastEventId: string | null = null;
    for (;;) {
      let res: Response;
      try { res = await api.streamRun(agentId, runId, { lastEventId, signal: deadline }); }
      catch (e: unknown) {
        // No stream (expired/unavailable): the ack can still be read from the finished run's result.
        if (!(e instanceof ApiError) || deadline.aborted) throw e;
        const run = await api.getRun(agentId, runId);
        const ack = parseAck(run.result);
        if (ack) return verdict(ack);
        if (isTerminal(run.status)) return { status: 'error', at: nowIso(), message: `run ${run.status} without ack` };
        await sleep(pollMs, deadline);
        continue;
      }
      for await (const ev of parseSSE(res.body, deadline)) {
        if (ev.id) lastEventId = ev.id;
        let data: SseResult = {};
        try { data = ev.data ? JSON.parse(ev.data) as SseResult : {}; } catch { /* raw */ }
        if (ev.event === 'assistant') text += data.text ?? '';
        else if (ev.event === 'result') text += `\n${data.text ?? ''}`;
        const ack = parseAck(text);
        if (ack) return verdict(ack);
        if (ev.event === 'done') return { status: 'error', at: nowIso(), message: 'run finished without ack' };
      }
      if (deadline.aborted) break;
      await sleep(pollMs, deadline); // stream closed without `done`: reconnect from lastEventId
    }
    return { status: 'timeout', at: nowIso() };
  } catch (e: unknown) {
    if (deadline.aborted) return { status: 'timeout', at: nowIso(), message: `no ack within ${Math.round(timeoutMs / 1000)}s` };
    return { status: 'error', at: nowIso(), message: caught(e).message };
  }
}
