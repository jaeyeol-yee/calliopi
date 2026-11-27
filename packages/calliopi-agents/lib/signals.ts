// Reads subagent records on disk into the signals core computes: the role lint for a catalog and
// per-run counts for every recorded run (or one top-level session's). Used by `npm run signals`.
import fs from 'node:fs';
import path from 'node:path';
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

export const signalsReport = (roles: Iterable<AgentRole>, runs: RunSignals[]) =>
  formatSignals(summarizeSignals(runs), [...roles].flatMap(lintRole));
