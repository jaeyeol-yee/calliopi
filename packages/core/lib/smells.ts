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
//   restate       a user message that says nearly the same as the one before it
//   backtrack     a git command that throws work away (restore, revert, reset --hard, checkout -- …)
// The first four are what the agent did; the last two and `interrupted` are what the person did.
// Entries are read in file order; a session with branches (/tree, /fork) is read as one sequence.
//
// A session also gets an outcome, a rough stand-in for "did it end well", and the harness version it
// ran under (a `calliopi-harness` entry written by the harness), so smells can be compared between
// outcomes and before and after a change to the harness.

export const SMELL_KINDS = ['repeat', 'error-streak', 'interrupted', 'context-jump', 'restate', 'backtrack'] as const;
export type SmellKind = (typeof SMELL_KINDS)[number];

export const REPEAT_MIN = 3;
export const ERROR_STREAK_MIN = 3;
export const JUMP_TOKENS = 30_000;
/** Two user messages are a restatement at this similarity (Dice over character pairs), when both have RESTATE_MIN_CHARS or more. */
export const RESTATE_SIMILARITY = 0.6;
export const RESTATE_MIN_CHARS = 20;

/** The custom entry the harness writes with the version a session runs under. */
export const HARNESS_ENTRY = 'calliopi-harness';
export interface HarnessVersion { sha: string; dirty: boolean }
export const harnessLabel = (v: HarnessVersion) => `${v.sha}${v.dirty ? '-dirty' : ''}`;

/**
 * How a session ended, as far as its entries show:
 *   shipped  a `git commit` or `gh pr create` the agent ran succeeded
 *   aborted  otherwise, the last reply was aborted by the user
 *   error    otherwise, the last reply ended in an error
 *   other    none of these (answered and left, still open, or not about code)
 */
export const OUTCOMES = ['shipped', 'aborted', 'error', 'other'] as const;
export type Outcome = (typeof OUTCOMES)[number];

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
  /** A custom entry (type "custom"). */
  customType?: string; data?: unknown;
  message?: {
    role?: string; content?: unknown; isError?: boolean; toolName?: string; toolCallId?: string; stopReason?: string; provider?: string; model?: string; usage?: Usage;
    /** A command the user ran with ! (role "bashExecution"). */
    command?: string;
  };
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
  outcome: Outcome;
  /** The harness version most requests ran under (`sha` or `sha-dirty`); "unrecorded" when the session has no version entry. */
  harness: string;
}

const most = (counts: Map<string, number>): string | undefined => [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0];
const bump = (counts: Map<string, number>, key: string) => counts.set(key, (counts.get(key) ?? 0) + 1);
/** A session file may hold anything on a line (null, a number): only objects are entries. */
const objects = (entries: SessionEntry[]) => entries.filter(e => !!e && typeof e === 'object');
const promptSize = (u: Usage | null | undefined) => (u ? (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0) : 0);

// A git or gh command at the start of a command line or after a shell separator, so the words inside a
// quoted message (a commit body that mentions "git restore") are less often taken for a command.
const AT_COMMAND = String.raw`(?:^|[;&|(\n]\s*)`;
const GIT = String.raw`git\s+(?:-C\s+\S+\s+)?`;
const SHIPS = new RegExp(`${AT_COMMAND}(?:${GIT}commit\\b|gh\\s+pr\\s+create\\b)`);
const UNDOES = new RegExp(`${AT_COMMAND}${GIT}(restore|revert|reset\\s+--hard|checkout\\s+(?:--(?=\\s)|\\.(?=\\s|$)))`);
/** The undoing git subcommand in a shell command, if any: "restore", "revert", "reset --hard" or "checkout --". */
export function undoCommand(command: unknown): string | undefined {
  const m = typeof command === 'string' ? UNDOES.exec(command) : null;
  if (!m) return undefined;
  const sub = m[1]!.replace(/\s+/g, ' ');
  return sub.startsWith('checkout') ? 'checkout --' : sub;
}

const toolCalls = (content: unknown): { id?: string; name: string; arguments?: { command?: unknown } }[] =>
  (Array.isArray(content) ? content : []).filter(b => b?.type === 'toolCall').map(b => ({ id: b.id, name: String(b.name), arguments: b.arguments }));

export function sessionInfo(entries: SessionEntry[]): SessionInfo {
  entries = objects(entries);
  const header = entries.find(e => e.type === 'session');
  const models = new Map<string, number>();
  const versions = new Map<string, number>();
  const shipping = new Set<string>(); // ids of calls that would ship
  let runs = 0, requests = 0, shipped = false, lastStop: string | undefined, version: string | undefined;
  for (const e of entries) {
    if (e.type === 'custom' && e.customType === HARNESS_ENTRY) {
      const v = e.data as Partial<HarnessVersion> | null | undefined;
      if (v && typeof v.sha === 'string') version = harnessLabel({ sha: v.sha, dirty: v.dirty === true });
      continue;
    }
    const m = e.message;
    if (e.type !== 'message' || !m) continue;
    if (m.role === 'user') runs++;
    if (m.role === 'toolResult' && m.toolCallId && shipping.has(m.toolCallId) && !m.isError) shipped = true;
    if (m.role !== 'assistant') continue;
    requests++; lastStop = m.stopReason;
    if (m.model) bump(models, `${m.provider ?? 'unknown'}/${m.model}`);
    if (version) bump(versions, version);
    for (const c of toolCalls(m.content)) if (c.id && c.name === 'bash' && typeof c.arguments?.command === 'string' && SHIPS.test(c.arguments.command)) shipping.add(c.id);
  }
  const startedAt = Date.parse(header?.timestamp ?? '');
  const outcome: Outcome = shipped ? 'shipped' : lastStop === 'aborted' ? 'aborted' : lastStop === 'error' ? 'error' : 'other';
  return {
    id: header?.id ?? 'unknown', cwd: header?.cwd ?? '', startedAt: Number.isNaN(startedAt) ? 0 : startedAt, model: most(models) ?? 'unknown', runs, requests,
    outcome, harness: most(versions) ?? version ?? 'unrecorded',
  };
}

const userText = (content: unknown): string =>
  (typeof content === 'string' ? content : Array.isArray(content) ? content.map(b => (typeof b?.text === 'string' ? b.text : '')).join(' ') : '').replace(/\s+/g, ' ').trim().toLowerCase();
const pairs = (text: string) => { const out = new Map<string, number>(); for (let i = 0; i < text.length - 1; i++) bump(out, text.slice(i, i + 2)); return out; };
/** Dice similarity of two texts over character pairs, 0 to 1: works without knowing the language's words. */
export function similarity(a: string, b: string): number {
  const pa = pairs(a), pb = pairs(b);
  let shared = 0;
  for (const [pair, n] of pa) shared += Math.min(n, pb.get(pair) ?? 0);
  const total = Math.max(0, a.length - 1) + Math.max(0, b.length - 1);
  return total ? (2 * shared) / total : 0;
}

export function sessionSmells(entries: SessionEntry[]): Smell[] {
  const smells: Smell[] = [];
  // per run
  let calls = new Map<string, { n: number; tool: string; entry?: string }>();
  let streak: { n: number; tools: Map<string, number>; entry?: string } = { n: 0, tools: new Map() };
  let lastPrompt = 0;
  let since = new Map<string, number>(); // tool results since the last request
  let lastUser = ''; // the previous user message, across runs
  const endStreak = () => {
    if (streak.n >= ERROR_STREAK_MIN) smells.push({ kind: 'error-streak', entry: streak.entry, tool: most(streak.tools), detail: `${streak.n} tool errors in a row (${[...streak.tools].map(([t, n]) => `${t} ${n}`).join(', ')})` });
    streak = { n: 0, tools: new Map() };
  };
  const endRun = () => {
    endStreak();
    for (const c of calls.values()) if (c.n >= REPEAT_MIN) smells.push({ kind: 'repeat', entry: c.entry, tool: c.tool, detail: `${c.tool} called ${c.n} times with the same arguments` });
    calls = new Map(); lastPrompt = 0; since = new Map();
  };

  for (const e of objects(entries)) {
    const m = e.message;
    if (e.type !== 'message' || !m) continue;
    if (m.role === 'user') {
      endRun();
      const text = userText(m.content);
      if (text.length >= RESTATE_MIN_CHARS && lastUser.length >= RESTATE_MIN_CHARS) {
        const sim = similarity(text, lastUser);
        if (sim >= RESTATE_SIMILARITY) smells.push({ kind: 'restate', entry: e.id, detail: `user message ${Math.round(sim * 100)}% similar to the previous one` });
      }
      lastUser = text;
      continue;
    }
    if (m.role === 'bashExecution') {
      const undo = undoCommand(m.command);
      if (undo) smells.push({ kind: 'backtrack', entry: e.id, detail: `git ${undo} run by the user` });
      continue;
    }
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
    for (const call of toolCalls(m.content)) {
      const tool = call.name;
      const key = `${tool}\0${JSON.stringify(call.arguments)}`;
      const c = calls.get(key) ?? { n: 0, tool };
      calls.set(key, { n: c.n + 1, tool, entry: e.id });
      const undo = tool === 'bash' ? undoCommand(call.arguments?.command) : undefined;
      if (undo) smells.push({ kind: 'backtrack', entry: e.id, tool, detail: `git ${undo} run by the agent` });
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
 * The smells section of the signals report: how many sessions show each smell; the same by outcome, by
 * harness version and by model; and the latest hits with the session and entry to open when judging
 * whether a hit is a real problem.
 */
export function formatSmells(sessions: SessionSmells[], examples = 10): string {
  const lines = ['## Session smells', ''];
  if (!sessions.length) return [...lines, 'No top-level sessions to read.'].join('\n');
  const total = sessions.length;
  lines.push(
    `${total} top-level ${total === 1 ? 'session' : 'sessions'}. Provisional thresholds: repeat ≥ ${REPEAT_MIN} identical calls in a run, error-streak ≥ ${ERROR_STREAK_MIN} errors in a row, context-jump ≥ ${JUMP_TOKENS} tokens between requests, restate ≥ ${Math.round(RESTATE_SIMILARITY * 100)}% similar to the previous user message.`,
    '', '| smell | sessions | rate | hits | most common tool |', '|---|---|---|---|---|');
  for (const r of summarizeSmells(sessions)) lines.push(`| ${r.kind} | ${r.sessions} | ${pct(r.sessions, total)} | ${r.hits} | ${r.tool ?? ''} |`);

  /** Sessions with at least one hit of each smell, for the sessions sharing a value (a model, a version, an outcome). */
  const grouped = (label: string, key: (s: SessionSmells) => string, order?: readonly string[]) => {
    const groups = new Map<string, SessionSmells[]>();
    for (const s of sessions) groups.set(key(s), [...groups.get(key(s)) ?? [], s]);
    const names = order ? order.filter(n => groups.has(n)) : [...groups.keys()].sort((a, b) => a.localeCompare(b));
    lines.push('', `Sessions with at least one hit, by ${label}:`, '', `| ${label} | sessions | ${SMELL_KINDS.join(' | ')} |`, `|---|---|${SMELL_KINDS.map(() => '---').join('|')}|`);
    for (const name of names) lines.push(`| ${name} | ${groups.get(name)!.length} | ${summarizeSmells(groups.get(name)!).map(r => r.sessions).join(' | ')} |`);
  };
  grouped('outcome', s => s.info.outcome, OUTCOMES);
  grouped('harness version', s => s.info.harness);
  grouped('model', s => s.info.model);

  const hits = sessions.flatMap(s => s.smells.map(smell => ({ s, smell }))).sort((a, b) => b.s.info.startedAt - a.s.info.startedAt);
  if (hits.length) {
    lines.push('', `Latest hits (${Math.min(examples, hits.length)} of ${hits.length}):`, '');
    for (const { s, smell } of hits.slice(0, examples)) lines.push(`- ${smell.kind} · ${day(s.info.startedAt)} · session ${s.info.id}${smell.entry ? ` · entry ${smell.entry}` : ''} · ${smell.detail}`);
  }
  return lines.join('\n');
}
