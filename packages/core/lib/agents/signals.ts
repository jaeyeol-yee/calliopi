// Feedback for whoever improves the text a model sees (roles, contracts, tool descriptions): checks
// that are deterministic on the text itself (lintRole), and counts that are deterministic on what
// subagents actually did (runSignals over a child's session and request records). The behavior is
// stochastic; these numbers are not. They point at what to read, they do not grade a change.
import type { AgentRecord, AgentRole } from '#lib/agents/types.ts';
import type { RequestRecord } from '#lib/agents/requests.ts';

export interface LintFinding { role: string; rule: string; detail: string }

/** Tool names a role body may mention; a mention of one the role cannot use is a contradiction. */
export const KNOWN_TOOLS = ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls', 'web_fetch', 'subagent'];
const FINISH = ['done', 'blocked', 'partial'];
const NEGATION = /\b(do not|don't|never|not|no|without|instead of)\b/i;
const SHOUT = /\b(ALWAYS|NEVER|MUST|IMPORTANT|CRITICAL|REQUIRED)\b/g;
export const LIMITS = { descriptionChars: 140, bodyWords: 350, shouts: 2 };

const sentences = (text: string) => text.split(/(?<=[.!?])\s+|\n+/).map(s => s.trim()).filter(Boolean);

export function lintRole(role: AgentRole): LintFinding[] {
  const out: LintFinding[] = [];
  const add = (rule: string, detail: string) => out.push({ role: role.name, rule, detail });
  if (role.description.length > LIMITS.descriptionChars) add('description-length', `${role.description.length} chars > ${LIMITS.descriptionChars}`);
  if (!role.when) add('missing-when', 'no "when": the parent model has no rule for when to delegate');
  const words = role.instructions.split(/\s+/).filter(Boolean).length;
  if (words > LIMITS.bodyWords) add('body-length', `${words} words > ${LIMITS.bodyWords}`);
  const shouts = role.instructions.match(SHOUT) ?? [];
  if (shouts.length > LIMITS.shouts) add('emphasis', `${shouts.length} all-caps imperatives (${[...new Set(shouts)].join(', ')})`);
  const usable = (tool: string) => !role.disallowedTools.includes(tool) && (role.tools === undefined || role.tools.includes(tool));
  const seen = new Set<string>();
  for (const s of sentences(role.instructions)) {
    const key = s.toLowerCase();
    if (seen.has(key)) add('duplicate', s);
    seen.add(key);
    if (NEGATION.test(s)) continue;
    for (const tool of KNOWN_TOOLS)
      if (new RegExp(`\\b${tool}\\b`).test(s) && !usable(tool)) add('unusable-tool', `"${tool}" is not available to this role: ${s}`);
  }
  for (const s of sentences(role.instructions).filter(s => /\bfinish\b/.test(s)))
    for (const [, word] of s.matchAll(/"([a-z_]+)"/g))
      if (!FINISH.includes(word!)) add('finish-status', `"${word}" is not a finish status (${FINISH.join(', ')}): ${s}`);
  return out;
}

export interface RunSignals {
  id: string;
  role: string;
  model: string;
  end: string;
  /** The child reported through finish (rather than the parent classifying an end it saw). */
  finished: boolean;
  turns: number;
  tokens: number;
  toolCalls: Record<string, number>;
  toolErrors: number;
  /** Calls to a tool the run was not given. */
  offContract: number;
  /** A tool called again with the same arguments right after itself. */
  repeats: number;
  /** Requests after the first that changed system or tools, or dropped or changed an item of the previous messages. */
  prefixRewrites: number;
  cacheRead: number;
  cacheWrite: number;
  input: number;
}

interface SessionEntry { type?: string; message?: { role?: string; content?: unknown; isError?: boolean; usage?: { input?: number; cacheRead?: number; cacheWrite?: number } } }

export function runSignals(record: AgentRecord, session: SessionEntry[], requests: RequestRecord[]): RunSignals {
  const s: RunSignals = {
    id: record.meta.id, role: record.meta.role, model: record.meta.model,
    end: record.result?.status ?? record.status?.state ?? 'starting', finished: false,
    turns: record.result?.usage?.turns ?? record.status?.turns ?? 0, tokens: record.result?.usage?.tokens ?? record.status?.tokens ?? 0,
    toolCalls: {}, toolErrors: 0, offContract: 0, repeats: 0, prefixRewrites: 0, cacheRead: 0, cacheWrite: 0, input: 0,
  };
  const allowed = new Set([...record.meta.tools, 'finish']);
  let last = '';
  for (const entry of session) {
    const m = entry.message;
    if (entry.type !== 'message' || !m) continue;
    if (m.role === 'toolResult' && m.isError) s.toolErrors++;
    if (m.role !== 'assistant') continue;
    s.cacheRead += m.usage?.cacheRead ?? 0; s.cacheWrite += m.usage?.cacheWrite ?? 0; s.input += m.usage?.input ?? 0;
    for (const block of Array.isArray(m.content) ? m.content : []) {
      if (block?.type !== 'toolCall') continue;
      const name = String(block.name);
      s.toolCalls[name] = (s.toolCalls[name] ?? 0) + 1;
      if (name === 'finish') s.finished = true;
      if (!allowed.has(name)) s.offContract++;
      const key = `${name}\0${JSON.stringify(block.arguments)}`;
      if (key === last) s.repeats++;
      last = key;
    }
  }
  // An array (messages …) must keep every item of the previous request and only add to its end.
  const lengths: Record<string, number> = {};
  requests.forEach((r, i) => {
    const arrays = Object.keys(r.set).filter(k => Array.isArray(r.set[k]));
    if (i > 0 && ('system' in r.set || 'tools' in r.set || r.drop?.length || arrays.some(k => (r.prefix?.[k] ?? 0) < (lengths[k] ?? 0)))) s.prefixRewrites++;
    for (const k of arrays) lengths[k] = (r.prefix?.[k] ?? 0) + (r.set[k] as unknown[]).length;
  });
  return s;
}

export interface SignalRow {
  role: string; model: string; runs: number;
  ends: Record<string, number>;
  /** Runs that ended without the child calling finish. */
  noFinish: number;
  turns: number; tokens: number;
  toolErrorRate: number; offContract: number; repeats: number; prefixRewrites: number;
  /** cacheRead / (cacheRead + cacheWrite + input) over all requests. */
  cacheHit: number;
}

export function summarizeSignals(runs: RunSignals[]): SignalRow[] {
  const groups = new Map<string, RunSignals[]>();
  for (const r of runs) groups.set(`${r.role}\0${r.model}`, [...groups.get(`${r.role}\0${r.model}`) ?? [], r]);
  return [...groups.values()].map(g => {
    const sum = (f: (r: RunSignals) => number) => g.reduce((a, r) => a + f(r), 0);
    const calls = sum(r => Object.values(r.toolCalls).reduce((a, n) => a + n, 0));
    const prompt = sum(r => r.cacheRead + r.cacheWrite + r.input);
    const ends: Record<string, number> = {};
    for (const r of g) ends[r.end] = (ends[r.end] ?? 0) + 1;
    return {
      role: g[0]!.role, model: g[0]!.model, runs: g.length, ends,
      noFinish: g.filter(r => !r.finished).length,
      turns: sum(r => r.turns) / g.length, tokens: sum(r => r.tokens) / g.length,
      toolErrorRate: calls ? sum(r => r.toolErrors) / calls : 0,
      offContract: sum(r => r.offContract), repeats: sum(r => r.repeats), prefixRewrites: sum(r => r.prefixRewrites),
      cacheHit: prompt ? sum(r => r.cacheRead) / prompt : 0,
    };
  }).sort((a, b) => a.role.localeCompare(b.role) || a.model.localeCompare(b.model));
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

export function formatSignals(rows: SignalRow[], findings: LintFinding[]): string {
  const lines = ['## Role lint', ''];
  if (!findings.length) lines.push('No findings.');
  for (const f of findings) lines.push(`- ${f.role}: ${f.rule}: ${f.detail}`);
  lines.push('', '## Runs by role and model', '',
    '| role | model | runs | ends | no finish | turns | tokens | tool errors | off-contract | repeats | prefix rewrites | cache hit |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const r of rows)
    lines.push(`| ${r.role} | ${r.model} | ${r.runs} | ${Object.entries(r.ends).map(([k, n]) => `${k} ${n}`).join(', ')} | ${r.noFinish} | ${r.turns.toFixed(1)} | ${Math.round(r.tokens)} | ${pct(r.toolErrorRate)} | ${r.offContract} | ${r.repeats} | ${r.prefixRewrites} | ${pct(r.cacheHit)} |`);
  if (!rows.length) lines.push('', 'No subagent records.');
  return lines.join('\n');
}

export const parseRequests = (jsonl: string): RequestRecord[] =>
  jsonl.split('\n').filter(Boolean).flatMap(line => { try { return [JSON.parse(line) as RequestRecord]; } catch { return []; } });
