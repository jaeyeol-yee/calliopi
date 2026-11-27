// A goal as one JSON document: the goal, the delegation summaries the parent made for it, and its
// subagents as a tree — each with its contract, state, result, briefing, compaction summaries and
// session file, and optionally every model request it sent. What the parent saw (each result) sits
// next to what the child did (its session), so a summary can be checked against the work.
import fs from 'node:fs';
import path from 'node:path';
import { FILES, buildTree, decodeRequests, type AgentRecord, type Goal, type TreeNode } from '@calliopi/core/agents';
import { SUMMARY_ENTRY } from '#lib/briefing.ts';

type Line = Record<string, unknown>;
const lines = (file: string): Line[] => {
  try { return fs.readFileSync(file, 'utf8').split('\n').flatMap(l => { try { return l.trim() ? [JSON.parse(l) as Line] : []; } catch { return []; } }); }
  catch { return []; }
};

function sessionFile(r: AgentRecord): string | undefined {
  try { const f = fs.readdirSync(r.dir).find(n => n.endsWith(`_${r.meta.id}.jsonl`)); return f && path.join(r.dir, f); } catch { return undefined; }
}

function node(n: TreeNode, requests: boolean): unknown {
  const r = n.record;
  const session = sessionFile(r);
  const entries = session ? lines(session) : [];
  return {
    id: r.meta.id, role: r.meta.role, depth: r.meta.depth, model: r.meta.model, modelSource: r.meta.modelSource,
    call: r.meta.call, status: r.status, result: r.result, session,
    compactions: entries.filter(e => e.type === 'compaction').map(e => ({ id: e.id, at: e.timestamp, summary: e.summary, tokensBefore: e.tokensBefore, firstKeptEntryId: e.firstKeptEntryId })),
    ...(requests ? { requests: decodeRequests(fs.existsSync(path.join(r.dir, FILES.requests)) ? fs.readFileSync(path.join(r.dir, FILES.requests), 'utf8') : '') } : {}),
    children: n.children.map(c => node(c, requests)),
  };
}

/** The export of `goal` (null: the subagents with no goal) from this tree's records. */
export function goalExport(goal: Goal | null, records: AgentRecord[], opts: { parentSession?: string; requests?: boolean } = {}) {
  const mine = records.filter(r => (r.meta.goal ?? null) === (goal?.id ?? null));
  const ids = new Set(mine.map(r => r.meta.id));
  const summaries = (opts.parentSession ? lines(opts.parentSession) : [])
    .filter(e => e.type === 'custom' && e.customType === SUMMARY_ENTRY)
    .map(e => ({ at: e.timestamp, ...(e.data as { summary?: string; agents?: string[]; upTo?: string }) }))
    .filter(s => (s.agents ?? []).some(a => ids.has(a)));
  return { exportedAt: new Date().toISOString(), goal, summaries, agents: buildTree(mine).map(n => node(n, !!opts.requests)) };
}

/** Write it under `<registry>/exports/`; returns the file. */
export function writeGoalExport(root: string, goal: Goal | null, records: AgentRecord[], opts: { parentSession?: string; requests?: boolean } = {}): string {
  const dir = path.join(root, 'exports');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `${goal?.id ?? `no-goal-${records[0]?.meta.root ?? 'session'}`}-${Date.now().toString(36)}.json`);
  fs.writeFileSync(file, JSON.stringify(goalExport(goal, records, opts), null, 2), { mode: 0o600 });
  return file;
}
