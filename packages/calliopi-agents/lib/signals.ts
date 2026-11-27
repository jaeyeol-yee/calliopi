// Reads subagent records on disk into the signals core computes: the role lint for a catalog and
// per-run counts for every recorded run (or one top-level session's), the smells of top-level sessions,
// and the person's notes. Used by `npm run signals`.
import fs from 'node:fs';
import path from 'node:path';
import { formatDebriefs, type Debrief } from '@calliopi/core/debrief';
import { formatNotes, type Note } from '@calliopi/core/notes';
import { formatSmells, sessionInfo, sessionSmells, type SessionSmells } from '@calliopi/core/smells';
import { FILES, formatSignals, lintRole, listAgents, parseRequests, sessionFile, runSignals, summarizeSignals, type AgentRole, type RunSignals } from '@calliopi/core/agents';

const readLines = (file: string) => {
  try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap(l => { try { return [JSON.parse(l)]; } catch { return []; } }); } catch { return []; }
};

export function collectRuns(root: string, topSession?: string): RunSignals[] {
  let sessions: string[];
  try { sessions = topSession ? [topSession] : fs.readdirSync(root).filter(n => fs.statSync(path.join(root, n)).isDirectory()); } catch { return []; }
  return sessions.flatMap(s => listAgents(root, s)).map(record => {
    let requests = '';
    try { requests = fs.readFileSync(path.join(record.dir, FILES.requests), 'utf8'); } catch { /* pruned after 3 days */ }
    return runSignals(record, readLines(sessionFile(record)), parseRequests(requests));
  });
}

/**
 * Smells of every top-level Pi session under `sessionsDir` (<Pi agent dir>/sessions/<project>/*.jsonl),
 * oldest first. `sinceMs` keeps sessions started at or after it; `session` keeps one id. A file that
 * cannot be read, or has no session header, is skipped.
 */
export function collectSessions(sessionsDir: string, opts: { sinceMs?: number; session?: string } = {}): SessionSmells[] {
  let projects: string[];
  try { projects = fs.readdirSync(sessionsDir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => path.join(sessionsDir, d.name)); } catch { return []; }
  const out: SessionSmells[] = [];
  for (const dir of projects) {
    let files: string[];
    try { files = fs.readdirSync(dir).filter(n => n.endsWith('.jsonl')); } catch { continue; }
    for (const name of files) {
      if (opts.session && !name.endsWith(`_${opts.session}.jsonl`)) continue; // Pi names the file <time>_<session id>.jsonl
      const entries = readLines(path.join(dir, name));
      if (!entries.some(e => e?.type === 'session')) continue;
      try {
        const info = sessionInfo(entries);
        if (opts.sinceMs !== undefined && info.startedAt < opts.sinceMs) continue;
        out.push({ info, smells: sessionSmells(entries) });
      } catch { /* one session that cannot be read does not stop the report */ }
    }
  }
  return out.sort((a, b) => a.info.startedAt - b.info.startedAt);
}

/** After the run counts: `sessions`, the smells of top-level sessions; `debriefs`, the background reviews; `notes`, the person's /cl-note lines. Each is omitted when not given. */
export const signalsReport = (roles: Iterable<AgentRole>, runs: RunSignals[], notes?: Note[], sessions?: SessionSmells[], debriefs?: Debrief[]) =>
  [formatSignals(summarizeSignals(runs), [...roles].flatMap(lintRole)), ...(sessions ? [formatSmells(sessions)] : []), ...(debriefs ? [formatDebriefs(debriefs)] : []), ...(notes ? [formatNotes(notes)] : [])].join('\n\n');
