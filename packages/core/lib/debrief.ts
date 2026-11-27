// A debrief: after a top-level session ends, a separate model reads short excerpts around the points
// the smell detectors flagged and writes down whether each was a real problem and where it likely came
// from. This file is the part without a process: what the reviewing model is given (an excerpt and the
// instructions), the record kept on disk, and how records are read back and listed.
//
//   <root>/<session id>.json       the record: which session, which smells, the model, when it started
//   <root>/<session id>.prompt.md  what the model was sent
//   <root>/<session id>.md         its answer (stdout of the run)
//   <root>/<session id>.exit       how the run ended, written last: its exit status, or "timeout"; absent while it runs
//   <root>/<session id>.md.log     its stderr
import fs from 'node:fs';
import path from 'node:path';
import type { SessionEntry, Smell } from '#lib/smells.ts';

/** Entries shown before and after a flagged one, and characters kept of each piece of text. */
export const AROUND = 3;
export const TEXT_CHARS = 400;
/** Characters kept of a tool call's arguments or a command, and tool calls shown of one reply. */
export const CALL_CHARS = 200;
export const MAX_CALLS = 4;
/** At most this many flagged points go into one debrief (the first ones). */
export const MAX_POINTS = 8;

// Control characters go too: session text can hold anything a tool printed.
const clip = (text: string, n = TEXT_CHARS) => { const t = text.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n)}… (+${t.length - n} chars)` : t; };
const textOf = (content: unknown): string =>
  typeof content === 'string' ? content : Array.isArray(content) ? content.map(b => (typeof b?.text === 'string' ? b.text : '')).filter(Boolean).join(' ') : '';

/** One entry as a line or two: who spoke, and the start of what was said, called or returned. */
function entryLines(e: SessionEntry): string[] {
  const m = e.message;
  if (!m) return [];
  const id = typeof e.id === 'string' ? e.id : '?';
  if (m.role === 'user') return [`[${id}] user: ${clip(textOf(m.content))}`];
  if (m.role === 'bashExecution') return [`[${id}] user ran: ${clip(String(m.command ?? ''), CALL_CHARS)}`];
  if (m.role === 'toolResult') return [`[${id}] result of ${clip(String(m.toolName ?? 'tool'), 64)}${m.isError ? ' (error)' : ''}: ${clip(textOf(m.content))}`];
  if (m.role !== 'assistant') return [];
  const lines: string[] = [];
  const said = clip(textOf(m.content));
  if (said) lines.push(`[${id}] assistant: ${said}`);
  const calls = (Array.isArray(m.content) ? m.content : []).filter(b => b?.type === 'toolCall');
  for (const b of calls.slice(0, MAX_CALLS)) lines.push(`[${id}] assistant calls ${clip(String(b.name), 64)}: ${clip(JSON.stringify(b.arguments ?? {}), CALL_CHARS)}`);
  if (calls.length > MAX_CALLS) lines.push(`[${id}] (+${calls.length - MAX_CALLS} more calls)`);
  if (m.stopReason === 'aborted' || m.stopReason === 'error') lines.push(`[${id}] (the reply ended: ${m.stopReason})`);
  return lines;
}

/**
 * The flagged points with a few entries around each, cut short. A smell without an entry, or whose
 * entry is not in the session, is left out; at most MAX_POINTS are shown.
 */
export function excerpt(entries: SessionEntry[], smells: Smell[]): { text: string; points: Smell[] } {
  const messages = entries.filter(e => !!e && typeof e === 'object' && e.type === 'message' && !!e.message);
  const points: Smell[] = [];
  const blocks: string[] = [];
  for (const smell of smells) {
    if (points.length >= MAX_POINTS) break;
    const at = smell.entry ? messages.findIndex(e => e.id === smell.entry) : -1;
    if (at < 0) continue;
    points.push(smell);
    const lines = messages.slice(Math.max(0, at - AROUND), at + AROUND + 1).flatMap(e => entryLines(e).map(l => (e.id === smell.entry ? `>> ${l}` : `   ${l}`)));
    blocks.push([`## ${smell.kind} at entry ${smell.entry}`, `Detector: ${smell.detail}`, '', ...lines].join('\n'));
  }
  return { text: blocks.join('\n\n'), points };
}

/** The instructions the reviewing model gets, before the excerpts. Text a model reads: see docs/model-guidance-history.md. */
export const DEBRIEF_INSTRUCTIONS = `You are reviewing parts of a finished coding-agent session. Deterministic detectors flagged the points below. A flag is not proof of a problem: decide from the excerpt whether something actually went wrong at each point.

For each flagged point write:

### <kind> at entry <id>
- Verdict: problem | not a problem | cannot tell
- What happened: one sentence
- Likely cause: harness (a tool's behavior, a tool description, an instruction the agent was given) | model | task (hard or underspecified) | user (changed their mind, mistyped, sent it twice) | unknown
- Evidence: the entry ids you rely on

Then end with one line, \`Summary: <n> problems of <m> flagged\`, and, only if a harness cause appears, one more sentence naming what to look at.

The excerpts show a few entries around each point, each cut short; the line marked >> is the flagged entry. Say "cannot tell" when that is not enough to judge. Do not propose rewrites of prompts, and do not address the user: this is a note for the person who maintains the harness.`;

export const debriefPrompt = (excerptText: string) => `${DEBRIEF_INSTRUCTIONS}\n\n# Flagged points\n\n${excerptText}\n`;

export interface DebriefRecord {
  session: string;
  sessionFile: string;
  cwd: string;
  /** provider/model that reviews. */
  model: string;
  startedAt: number;
  /** How long the run may take before it is stopped. */
  timeoutMs: number;
  /** Entries the session had when it was reviewed: a session that grew since may be reviewed again. */
  entries: number;
  points: { kind: string; entry?: string; detail: string }[];
  /** Set when a person has seen it in /cl-debrief. */
  readAt?: number;
}

export type DebriefStatus = 'running' | 'done' | 'timeout' | 'error' | 'lost';
export interface Debrief { record: DebriefRecord; status: DebriefStatus; text: string }

const SAFE_ID = /^[\w-]{1,80}$/;
/** The files of one session's debrief; undefined for an id that could not name a file. */
export function debriefFiles(root: string, session: string) {
  if (!SAFE_ID.test(session)) return undefined;
  const base = path.join(root, session);
  return { record: `${base}.json`, prompt: `${base}.prompt.md`, answer: `${base}.md`, exit: `${base}.exit`, log: `${base}.md.log` };
}

/** Grace after the timeout before a run with no exit status is taken for lost (the machine slept, the process was killed). */
export const LOST_GRACE_MS = 60_000;

export function readDebrief(root: string, session: string, now = Date.now()): Debrief | undefined {
  const files = debriefFiles(root, session);
  if (!files) return undefined;
  let record: DebriefRecord;
  try { record = JSON.parse(fs.readFileSync(files.record, 'utf8')) as DebriefRecord; } catch { return undefined; }
  if (!record || typeof record !== 'object' || record.session !== session || typeof record.startedAt !== 'number' || !Array.isArray(record.points)) return undefined;
  let text = '';
  try { text = fs.readFileSync(files.answer, 'utf8').trim(); } catch { /* not written yet */ }
  let exit: string | undefined;
  try { exit = fs.readFileSync(files.exit, 'utf8').trim(); } catch { /* still running, or lost */ }
  const status: DebriefStatus = exit === undefined ? (now - record.startedAt > (record.timeoutMs || 0) + LOST_GRACE_MS ? 'lost' : 'running')
    : exit === '0' && text ? 'done' : exit === 'timeout' || exit === '143' || exit === '137' ? 'timeout' : 'error';
  return { record, status, text };
}

/** Every debrief under `root`, oldest first. */
export function listDebriefs(root: string, now = Date.now()): Debrief[] {
  let names: string[];
  try { names = fs.readdirSync(root).filter(n => n.endsWith('.json')); } catch { return []; }
  return names.flatMap(n => readDebrief(root, n.slice(0, -5), now) ?? []).sort((a, b) => a.record.startedAt - b.record.startedAt);
}

/** The model's own closing line, if it wrote one. */
export const debriefSummary = (text: string): string | undefined => /^Summary:.*$/m.exec(text)?.[0].trim();

const day = (at: number) => new Date(at).toISOString().slice(0, 10);

/** The debriefs section of the signals report: counts by status, and the latest finished ones with their closing line. */
export function formatDebriefs(debriefs: Debrief[], limit = 10): string {
  const lines = ['## Debriefs', ''];
  if (!debriefs.length) return [...lines, 'No debriefs. Turn them on with /cl-debrief on; a session that ends with a smell is then reviewed in the background.'].join('\n');
  const counts = new Map<string, number>();
  for (const d of debriefs) counts.set(d.status, (counts.get(d.status) ?? 0) + 1);
  lines.push(`${debriefs.length} ${debriefs.length === 1 ? 'debrief' : 'debriefs'}: ${[...counts].map(([s, n]) => `${s} ${n}`).join(', ')}. A debrief is a model's reading of short excerpts, not a measurement.`, '');
  const done = debriefs.filter(d => d.status === 'done').reverse();
  for (const d of done.slice(0, limit)) lines.push(`- ${day(d.record.startedAt)} · session ${d.record.session} · ${d.record.model} · ${d.record.points.length} flagged · ${debriefSummary(d.text) ?? 'no summary line'}`);
  if (done.length > limit) lines.push(`- … and ${done.length - limit} older`);
  return lines.join('\n');
}
