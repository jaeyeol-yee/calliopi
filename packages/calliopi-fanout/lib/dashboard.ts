// Rolling plain-text dashboard. A new frame is appended only when content changes; when
// the file grows past `maxBytes` it is truncated to the latest frame. Follow it with
// `tail -F` (by name), which survives truncation.
import fs from 'node:fs';
import { fmtDur, oneLine, short, isTerminal, cleanResult } from './util.ts';
import type { AgentRecord, Registry, StatusEvent } from './types.ts';

const ICON: Record<string, string> = {
  CREATING: '…', RUNNING: '▶', WAITING_FOR_BACKGROUND_WORK: '⏳',
  FINISHED: '✓', ERROR: '✗', CANCELLED: '⊘', EXPIRED: '⌛', MISSING: '?',
};
export const icon = (s: string | null | undefined): string => ICON[s as string] || '·';

export function counts(reg: Registry): Record<string, number> {
  const c: Record<string, number> = {};
  for (const a of Object.values(reg.agents)) {
    const s = a.missing ? 'MISSING' : a.phase === 'planned' ? 'PLANNED' : a.phase === 'create_failed' ? 'CREATE_FAILED' : a.status || 'PENDING';
    c[s] = (c[s] || 0) + 1;
  }
  return c;
}

export function render(reg: Registry, recentEvents: StatusEvent[] = []): string {
  const agents = Object.values(reg.agents).sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
  const c = counts(reg);
  const head = Object.entries(c).map(([k, v]) => `${k.toLowerCase()} ${v}`).join(' · ') || 'no agents';
  const lines = [`Cursor Cloud fan-out  —  ${head}`];
  const now = Date.now();
  const W = { label: 18, st: 28 };
  lines.push(`${'LABEL'.padEnd(W.label)} ${'AGENT'.padEnd(11)} ${'STATUS'.padEnd(W.st)} ${'TIME'.padStart(7)}  PR / SUMMARY`);
  for (const a of agents) {
    const st = a.missing ? 'MISSING' : a.phase === 'planned' ? 'PLANNED' : a.phase === 'create_failed' ? 'CREATE_FAILED' : a.status || 'PENDING';
    const run = a.runs?.[a.runId as string] || {};
    // Active rows use minute granularity so frames are appended at most ~once a minute.
    const live = run.createdAt && !isTerminal(st) ? Math.floor((now - Date.parse(run.createdAt)) / 60_000) * 60_000 : null;
    const dur = run.durationMs ?? live;
    const prs = (a.git?.branches || []).map((b) => b.prUrl).filter((u): u is string => Boolean(u));
    let tail = prs.length ? prs.join(' ') : '';
    if (isTerminal(st) && run.result) tail = `${tail ? `${tail}  ` : ''}${oneLine(cleanResult(run.result), 70)}`;
    if (a.lastError && !isTerminal(st)) tail = `! ${oneLine(a.lastError.message, 60)}`;
    if (a.phase === 'create_failed') tail = `! ${oneLine(a.createError?.message, 60)}`;
    const stTxt = `${icon(st)} ${st}`;
    lines.push(
      `${oneLine(a.label || a.name || '-', W.label).padEnd(W.label)} ${short(a.agentId).padEnd(11)} ${stTxt.padEnd(W.st)} ${fmtDur(dur).padStart(7)}  ${tail}`,
    );
  }
  if (recentEvents.length) {
    lines.push('', 'recent:');
    for (const e of recentEvents.slice(-8)) lines.push(`  ${e.at.slice(11, 19)} ${oneLine(e.label || short(e.agentId), 18).padEnd(18)} ${e.from || '∅'} → ${e.to}`);
  }
  return lines.join('\n');
}

export class DashboardWriter {
  file: string;
  maxBytes: number;
  last: string | null;
  constructor(file: string, maxBytes = 256 * 1024) {
    this.file = file; this.maxBytes = maxBytes; this.last = null;
  }
  write(body: string, { force = false }: { force?: boolean } = {}): boolean {
    if (!force && body === this.last) return false;
    this.last = body;
    const frame = `\n──── ${new Date().toISOString().replace('T', ' ').slice(0, 19)} ${'─'.repeat(40)}\n${body}\n`;
    let size = 0;
    try { size = fs.statSync(this.file).size; } catch { /* new */ }
    if (size + frame.length > this.maxBytes) fs.writeFileSync(this.file, frame, { mode: 0o600 });
    else fs.appendFileSync(this.file, frame, { mode: 0o600 });
    return true;
  }
}

export type { AgentRecord };
