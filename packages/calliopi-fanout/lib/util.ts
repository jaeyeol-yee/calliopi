// Shared helpers. No dependencies, no knowledge of rex or any multiplexer.
import { createHash } from 'node:crypto';
import type { WriteStream } from 'node:fs';
import type { AgentView, Logger, ReplyMeta } from '#lib/types.ts';

/** REST Run.status — the only source of truth for state. Never the SDK's 4-value Run.status. */
export const ACTIVE = new Set(['CREATING', 'RUNNING', 'WAITING_FOR_BACKGROUND_WORK']);
export const TERMINAL = new Set(['FINISHED', 'ERROR', 'CANCELLED', 'EXPIRED']);
export const KNOWN = new Set([...ACTIVE, ...TERMINAL]);

export const isTerminal = (s: string | null | undefined): boolean => TERMINAL.has(s as string);
/** Unknown/future values are treated as "still active" — never folded into ERROR. */
export const isActiveOrUnknown = (s: string | null | undefined): boolean => !TERMINAL.has(s as string);

/** Exit codes used by `follow` so a multiplexer's child-exit event carries the outcome. */
export const EXIT: Record<string, number> = {
  FINISHED: 0,
  ERROR: 10,
  CANCELLED: 11,
  EXPIRED: 12,
  MISSING: 13,
  USAGE: 2,
  ALREADY_RUNNING: 3,
  AUTH: 4,
};

export const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
  });

export const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');
export const nowIso = (): string => new Date().toISOString();
export const jitter = (ms: number, frac = 0.1): number => Math.round(ms * (1 - frac + Math.random() * 2 * frac));

export const short = (id: string | null | undefined): string => {
  if (!id) return '-';
  const m = /^(bc|run)-([0-9a-f]{8})/i.exec(id);
  return m ? `${m[1]}-${m[2]}` : String(id).slice(0, 11);
};

export const oneLine = (s: string | null | undefined, n = 80): string => {
  if (!s) return '';
  const t = String(s).replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

export const fmtDur = (ms: number | null | undefined): string => {
  if (ms == null || Number.isNaN(ms)) return '-';
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`;
};

// ---- secret redaction ---------------------------------------------------
const secrets = new Set<string>();
export const registerSecret = (s: string | null | undefined): void => { if (s && s.length >= 8) secrets.add(s); };
export const redact = (text: unknown): string => {
  let out = String(text);
  for (const s of secrets) out = out.split(s).join('[REDACTED]');
  // Belt and braces: anything that looks like a bearer/basic credential.
  return out.replace(/(authorization:\s*)(bearer|basic)\s+\S+/gi, '$1$2 [REDACTED]');
};

export function makeLogger({ stream = process.stderr, file = null, quiet = false }: {
  stream?: NodeJS.WritableStream;
  file?: WriteStream | null;
  quiet?: boolean;
} = {}): Logger {
  const write = (level: string, msg: string) => {
    const line = `${new Date().toISOString()} ${level.padEnd(5)} ${redact(msg)}\n`;
    if (file) file.write(line);
    if (!quiet || level === 'error') stream.write(line);
  };
  return {
    info: (m) => write('info', m),
    warn: (m) => write('warn', m),
    error: (m) => write('error', m),
    debug: (m) => { if (process.env.CURSOR_FANOUT_DEBUG) write('debug', m); },
  };
}

/** Thrown values are untyped. Call sites keep the original object and read fields through this cast. */
export type Caught = Error & {
  code?: string;
  status?: number;
  stdout?: string;
  stderr?: string;
  ambiguous?: boolean;
  requestId?: string | null;
};

export const caught = (e: unknown): Caught => e as Caught;

export function processAlive(pid: number | null | undefined): boolean {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e: unknown) { return caught(e).code === 'EPERM'; }
}

/** Automation replies open with a <calliopi_result> envelope (legacy: FANOUT_KEY=/AGENT_ID=/UNDERSTOOD= lines). */
const ENVELOPE = /<calliopi_result\b([^>]*)>([\s\S]*?)<\/calliopi_result>/;
const attr = (attrs: string | undefined, name: string): string | null => new RegExp(`\\b${name}="([^"]*)"`).exec(attrs || '')?.[1] ?? null;
export function replyMeta(text: string | null | undefined): ReplyMeta {
  const t = String(text || '');
  const m = ENVELOPE.exec(t);
  if (m) return { fanoutKey: attr(m[1], 'fanout_key'), agentId: attr(m[1], 'agent_id'), understood: /<understood>([\s\S]*?)<\/understood>/.exec(m[2])?.[1]?.trim() || null };
  const line = (k: string) => new RegExp(`^${k}=(.+)$`, 'm').exec(t)?.[1]?.trim() || null;
  return { fanoutKey: line('FANOUT_KEY'), agentId: line('AGENT_ID'), understood: line('UNDERSTOOD') };
}
/** First line of an automation reply: `<calliopi_ack body_key="…" prompt_key="…"/>`. */
const ACK = /<calliopi_ack\b([^>]*?)\/?>/;
export function parseAck(text: string | null | undefined): { bodyKey: string | null; promptKey: string | null } | null {
  const m = ACK.exec(String(text || ''));
  return m ? { bodyKey: attr(m[1], 'body_key'), promptKey: attr(m[1], 'prompt_key') } : null;
}
export const cleanResult = (text: string | null | undefined): string | null | undefined => (text == null ? text
  : String(text).replace(new RegExp(ACK.source, 'g'), '').replace(ENVELOPE, '').replace(/^(FANOUT_KEY|AGENT_ID|UNDERSTOOD)=.*(\r?\n|$)/gm, '').trim());
export const understood = (text: string | null | undefined): string | null => replyMeta(text).understood;
export const keyVerified = (a: Pick<AgentView, 'fanoutKey'> | null | undefined, text: string | null | undefined): boolean | null => (a?.fanoutKey ? replyMeta(text).fanoutKey === a.fanoutKey : null);

/**
 * Key check across ALL runs of an agent. Only the webhook-started run carries the envelope; follow-up
 * runs (e.g. "now open a PR") don't, so checking just the latest run reports false mismatches.
 * true: some run echoed this key · false: a run echoed another key, or no finished run echoed any key.
 */
export function keyVerifiedRuns(a: Pick<AgentView, 'fanoutKey' | 'runs'> | null | undefined): boolean | null {
  if (!a?.fanoutKey) return null;
  const keys = Object.values(a.runs || {}).map((r) => (r?.result ? replyMeta(r.result).fanoutKey : null)).filter(Boolean);
  if (keys.includes(a.fanoutKey)) return true;
  return keys.length || Object.values(a.runs || {}).some((r) => r?.result) ? false : null;
}
/** `understood` from whichever run carried the envelope. */
export function understoodRuns(a: Pick<AgentView, 'runs'>, fallback: string | null | undefined): string | null {
  for (const r of Object.values(a.runs || {})) { const u = r?.result ? understood(r.result) : null; if (u) return u; }
  return understood(fallback);
}
