// Shared helpers. No dependencies, no knowledge of rex or any multiplexer.
import { createHash } from 'node:crypto';

/** REST Run.status — the only source of truth for state. Never the SDK's 4-value Run.status. */
export const ACTIVE = new Set(['CREATING', 'RUNNING', 'WAITING_FOR_BACKGROUND_WORK']);
export const TERMINAL = new Set(['FINISHED', 'ERROR', 'CANCELLED', 'EXPIRED']);
export const KNOWN = new Set([...ACTIVE, ...TERMINAL]);

export const isTerminal = (s) => TERMINAL.has(s);
/** Unknown/future values are treated as "still active" — never folded into ERROR. */
export const isActiveOrUnknown = (s) => !TERMINAL.has(s);

/** Exit codes used by `follow` so a multiplexer's child-exit event carries the outcome. */
export const EXIT = {
  FINISHED: 0,
  ERROR: 10,
  CANCELLED: 11,
  EXPIRED: 12,
  MISSING: 13,
  USAGE: 2,
  ALREADY_RUNNING: 3,
  AUTH: 4,
};

export const sleep = (ms, signal) =>
  new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
  });

export const sha256 = (s) => createHash('sha256').update(s).digest('hex');
export const nowIso = () => new Date().toISOString();
export const jitter = (ms, frac = 0.1) => Math.round(ms * (1 - frac + Math.random() * 2 * frac));

export const short = (id) => {
  if (!id) return '-';
  const m = /^(bc|run)-([0-9a-f]{8})/i.exec(id);
  return m ? `${m[1]}-${m[2]}` : String(id).slice(0, 11);
};

export const oneLine = (s, n = 80) => {
  if (!s) return '';
  const t = String(s).replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

export const fmtDur = (ms) => {
  if (ms == null || Number.isNaN(ms)) return '-';
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`;
};

// ---- secret redaction ---------------------------------------------------
const secrets = new Set();
export const registerSecret = (s) => { if (s && s.length >= 8) secrets.add(s); };
export const redact = (text) => {
  let out = String(text);
  for (const s of secrets) out = out.split(s).join('[REDACTED]');
  // Belt and braces: anything that looks like a bearer/basic credential.
  return out.replace(/(authorization:\s*)(bearer|basic)\s+\S+/gi, '$1$2 [REDACTED]');
};

export function makeLogger({ stream = process.stderr, file = null, quiet = false } = {}) {
  const write = (level, msg) => {
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

export function processAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

/** Automation replies open with a <calliopi_result> envelope (legacy: FANOUT_KEY=/AGENT_ID=/UNDERSTOOD= lines). */
const ENVELOPE = /<calliopi_result\b([^>]*)>([\s\S]*?)<\/calliopi_result>/;
const attr = (attrs, name) => new RegExp(`\\b${name}="([^"]*)"`).exec(attrs || '')?.[1] ?? null;
export function replyMeta(text) {
  const t = String(text || '');
  const m = ENVELOPE.exec(t);
  if (m) return { fanoutKey: attr(m[1], 'fanout_key'), agentId: attr(m[1], 'agent_id'), understood: /<understood>([\s\S]*?)<\/understood>/.exec(m[2])?.[1]?.trim() || null };
  const line = (k) => new RegExp(`^${k}=(.+)$`, 'm').exec(t)?.[1]?.trim() || null;
  return { fanoutKey: line('FANOUT_KEY'), agentId: line('AGENT_ID'), understood: line('UNDERSTOOD') };
}
export const cleanResult = (text) => (text == null ? text
  : String(text).replace(ENVELOPE, '').replace(/^(FANOUT_KEY|AGENT_ID|UNDERSTOOD)=.*(\r?\n|$)/gm, '').trim());
export const understood = (text) => replyMeta(text).understood;
export const keyVerified = (a, text) => (a?.fanoutKey ? replyMeta(text).fanoutKey === a.fanoutKey : null);
