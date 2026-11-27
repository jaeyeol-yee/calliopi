// Session smells: deterministic signs, read from a Pi session's entries, that a session went badly.
// They are counted, never acted on: nothing here reaches a model. Each detector is a rule over the
// entries in file order, so the same session always gives the same smells, and sessions recorded
// before a detector existed can be read too. The thresholds are provisional: they exist to measure
// how often each smell occurs and how often a hit is a real problem, and are expected to change.
//
// A "run" is what the agent does between two user messages.
//   repeat        the same tool called with the same arguments REPEAT_MIN times or more in one run
//   error-streak  ERROR_STREAK_MIN or more tool results in a row that are errors, in one run
//   interrupted   an assistant message the user aborted
//   context-jump  the prompt grew by JUMP_TOKENS or more between two requests of one run
// Entries are read in file order; a session with branches (/tree, /fork) is read as one sequence.

export const SMELL_KINDS = ['repeat', 'error-streak', 'interrupted', 'context-jump'] as const;
export type SmellKind = (typeof SMELL_KINDS)[number];

export const REPEAT_MIN = 3;
export const ERROR_STREAK_MIN = 3;
export const JUMP_TOKENS = 30_000;

export interface Smell {
  kind: SmellKind;
  /** The entry where it was seen (the last call of a repeat, the last error of a streak). */
  entry?: string;
  /** The tool involved, when there is one (for a jump: the tool whose results preceded it). */
  tool?: string;
  /** Counts and names only: never what the user or the model wrote. */
  detail: string;
}

interface Usage { input?: number; cacheRead?: number; cacheWrite?: number }
export interface SessionEntry {
  type?: string; id?: string; timestamp?: string; cwd?: string;
  message?: { role?: string; content?: unknown; isError?: boolean; toolName?: string; stopReason?: string; provider?: string; model?: string; usage?: Usage };
}

export interface SessionInfo {
  id: string;
  cwd: string;
  /** When the session started (ms); 0 when its header has no time. */
  startedAt: number;
  /** provider/model that answered most often; "unknown" when no model answered. */
  model: string;
  /** User messages, and model requests, in the session. */
  runs: number;
  requests: number;
}

const most = (counts: Map<string, number>): string | undefined => [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0];
const bump = (counts: Map<string, number>, key: string) => counts.set(key, (counts.get(key) ?? 0) + 1);
const promptSize = (u: Usage | undefined) => (u ? (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0) : 0);

export function sessionInfo(entries: SessionEntry[]): SessionInfo {
  const header = entries.find(e => e.type === 'session');
  const models = new Map<string, number>();
  let runs = 0, requests = 0;
  for (const e of entries) {
    if (e.type !== 'message' || !e.message) continue;
    if (e.message.role === 'user') runs++;
    if (e.message.role === 'assistant') { requests++; if (e.message.model) bump(models, `${e.message.provider ?? 'unknown'}/${e.message.model}`); }
  }
  const startedAt = Date.parse(header?.timestamp ?? '');
  return { id: header?.id ?? 'unknown', cwd: header?.cwd ?? '', startedAt: Number.isNaN(startedAt) ? 0 : startedAt, model: most(models) ?? 'unknown', runs, requests };
}

export function sessionSmells(entries: SessionEntry[]): Smell[] {
  const smells: Smell[] = [];
  // per run
  let calls = new Map<string, { n: number; tool: string; entry?: string }>();
  let streak: { n: number; tools: Map<string, number>; entry?: string } = { n: 0, tools: new Map() };
  let lastPrompt = 0;
  let since = new Map<string, number>(); // tool results since the last request
  const endStreak = () => {
    if (streak.n >= ERROR_STREAK_MIN) smells.push({ kind: 'error-streak', entry: streak.entry, tool: most(streak.tools), detail: `${streak.n} tool errors in a row (${[...streak.tools].map(([t, n]) => `${t} ${n}`).join(', ')})` });
    streak = { n: 0, tools: new Map() };
  };
  const endRun = () => {
    endStreak();
    for (const c of calls.values()) if (c.n >= REPEAT_MIN) smells.push({ kind: 'repeat', entry: c.entry, tool: c.tool, detail: `${c.tool} called ${c.n} times with the same arguments` });
    calls = new Map(); lastPrompt = 0; since = new Map();
  };

  for (const e of entries) {
    const m = e.message;
    if (e.type !== 'message' || !m) continue;
    if (m.role === 'user') { endRun(); continue; }
    if (m.role === 'toolResult') {
      const tool = m.toolName ?? 'unknown';
      bump(since, tool);
      if (m.isError) { streak.n++; bump(streak.tools, tool); streak.entry = e.id; } else endStreak();
      continue;
    }
    if (m.role !== 'assistant') continue;
    if (m.stopReason === 'aborted') smells.push({ kind: 'interrupted', entry: e.id, detail: 'the user aborted the reply' });
    const prompt = promptSize(m.usage);
    // An aborted or failed request may report no usage: it neither jumps nor resets the baseline.
    if (prompt > 0) {
      if (lastPrompt > 0 && prompt - lastPrompt >= JUMP_TOKENS) {
        const tool = most(since);
        smells.push({ kind: 'context-jump', entry: e.id, tool, detail: `prompt grew by ${prompt - lastPrompt} tokens after ${[...since].map(([t, n]) => `${t} ${n}`).join(', ') || 'no tool result'}` });
      }
      lastPrompt = prompt;
    }
    since = new Map();
    for (const block of Array.isArray(m.content) ? m.content : []) {
      if (block?.type !== 'toolCall') continue;
      const tool = String(block.name);
      const key = `${tool}\0${JSON.stringify(block.arguments)}`;
      const c = calls.get(key) ?? { n: 0, tool };
      calls.set(key, { n: c.n + 1, tool, entry: e.id });
    }
  }
  endRun();
  return smells;
}

export interface SessionSmells { info: SessionInfo; smells: Smell[] }

export interface SmellRow {
  kind: SmellKind;
  /** Sessions with at least one hit, and hits in all. */
  sessions: number;
  hits: number;
  /** The tool named by most hits. */
  tool?: string;
}

export function summarizeSmells(sessions: SessionSmells[]): SmellRow[] {
  return SMELL_KINDS.map(kind => {
    const tools = new Map<string, number>();
    let hits = 0, withHit = 0;
    for (const s of sessions) {
      const mine = s.smells.filter(x => x.kind === kind);
      if (mine.length) withHit++;
      hits += mine.length;
      for (const x of mine) if (x.tool) bump(tools, x.tool);
    }
    return { kind, sessions: withHit, hits, tool: most(tools) };
  });
}

const pct = (n: number, of: number) => (of ? `${Math.round((n / of) * 100)}%` : '0%');
const day = (at: number) => (at ? new Date(at).toISOString().slice(0, 10) : 'unknown date');

/**
 * The smells section of the signals report: how many sessions show each smell, the same by model, and
 * the latest hits with the session and entry to open when judging whether a hit is a real problem.
 */
export function formatSmells(sessions: SessionSmells[], examples = 10): string {
  const lines = ['## Session smells', ''];
  if (!sessions.length) return [...lines, 'No top-level sessions to read.'].join('\n');
  const total = sessions.length;
  lines.push(
    `${total} top-level ${total === 1 ? 'session' : 'sessions'}. Provisional thresholds: repeat ≥ ${REPEAT_MIN} identical calls in a run, error-streak ≥ ${ERROR_STREAK_MIN} errors in a row, context-jump ≥ ${JUMP_TOKENS} tokens between requests.`,
    '', '| smell | sessions | rate | hits | most common tool |', '|---|---|---|---|---|');
  for (const r of summarizeSmells(sessions)) lines.push(`| ${r.kind} | ${r.sessions} | ${pct(r.sessions, total)} | ${r.hits} | ${r.tool ?? ''} |`);

  const byModel = new Map<string, SessionSmells[]>();
  for (const s of sessions) byModel.set(s.info.model, [...byModel.get(s.info.model) ?? [], s]);
  lines.push('', 'Sessions with at least one hit, by model:', '', `| model | sessions | ${SMELL_KINDS.join(' | ')} |`, `|---|---|${SMELL_KINDS.map(() => '---').join('|')}|`);
  for (const [model, group] of [...byModel].sort((a, b) => a[0].localeCompare(b[0])))
    lines.push(`| ${model} | ${group.length} | ${summarizeSmells(group).map(r => r.sessions).join(' | ')} |`);

  const hits = sessions.flatMap(s => s.smells.map(smell => ({ s, smell }))).sort((a, b) => b.s.info.startedAt - a.s.info.startedAt);
  if (hits.length) {
    lines.push('', `Latest hits (${Math.min(examples, hits.length)} of ${hits.length}):`, '');
    for (const { s, smell } of hits.slice(0, examples)) lines.push(`- ${smell.kind} · ${day(s.info.startedAt)} · session ${s.info.id}${smell.entry ? ` · entry ${smell.entry}` : ''} · ${smell.detail}`);
  }
  return lines.join('\n');
}
