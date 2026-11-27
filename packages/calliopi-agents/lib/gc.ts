// Cleaning up the registry: request logs, then whole agent records, age out after their goal closes
// (or after they end, without a goal); closed goals with nothing left go too, then empty trees. The
// rules are in @calliopi/core/agents (planPrune); this applies them across every session's tree.
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_RETENTION, FILES, planPrune, readAgent, readJson, staleGoals, type AgentRecord, type Goal, type Retention } from '@calliopi/core/agents';

export const CONFIG_FILE = 'calliopi-agents.json';

/** `<Pi agent dir>/calliopi-agents.json`: `{ "retention": { "requestsDays": 3, "recordsDays": 14 } }`. */
export function retention(agentDir: string): Retention {
  const config = readJson<{ retention?: Partial<Retention> }>(path.join(agentDir, CONFIG_FILE))?.retention ?? {};
  const days = (v: unknown, d: number, min: number) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.max(min, v) : d);
  // Records stay at least a day: a background result must still be there to be announced.
  return { requestsDays: days(config.requestsDays, DEFAULT_RETENTION.requestsDays, 0), recordsDays: days(config.recordsDays, DEFAULT_RETENTION.recordsDays, 1) };
}

/** A tree directory read by path (its name may already be a hash of the session id). */
function readTree(dir: string): { records: AgentRecord[]; goals: Goal[] } {
  const names = fs.readdirSync(dir);
  const records = names.filter(n => n !== 'goals').flatMap(n => readAgent(path.join(dir, n)) ?? []);
  let goalNames: string[] = [];
  try { goalNames = fs.readdirSync(path.join(dir, 'goals')).filter(n => n.endsWith('.json')); } catch { /* none */ }
  const goals = goalNames.flatMap(n => readJson<Goal>(path.join(dir, 'goals', n)) ?? []);
  return { records, goals };
}

/** Apply the retention to every tree under `root`; returns what was removed. Never throws. */
export function collect(root: string, policy: Retention, now = Date.now()): { requests: number; records: number; goals: number } {
  const done = { requests: 0, records: 0, goals: 0 };
  let trees: string[];
  // every session's tree; exports (lib/export.ts) are the user's, not a tree
  try { trees = fs.readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory() && d.name !== 'exports').map(d => path.join(root, d.name)); } catch { return done; }
  for (const dir of trees) {
    try {
      const { records, goals } = readTree(dir);
      for (const action of planPrune(records, goals, policy, now, d => fs.existsSync(path.join(d, FILES.requests)))) {
        if (action.what === 'requests') { fs.rmSync(path.join(action.dir, FILES.requests), { force: true }); done.requests++; }
        else { fs.rmSync(action.dir, { recursive: true, force: true }); done.records++; }
      }
      const left = readTree(dir);
      for (const goal of staleGoals(goals, left.records, policy, now)) { fs.rmSync(path.join(dir, 'goals', `${goal.id}.json`), { force: true }); done.goals++; }
      const after = readTree(dir);
      // A directory without meta.json may be a record being created (mkdir comes first): never remove a
      // tree that has one, or a tree touched in the last hour.
      const creating = fs.readdirSync(dir).some(n => n !== 'goals' && !fs.existsSync(path.join(dir, n, FILES.meta)));
      const recent = now - fs.statSync(dir).mtimeMs < 60 * 60 * 1000;
      if (!after.records.length && !after.goals.length && !creating && !recent) fs.rmSync(dir, { recursive: true, force: true });
    } catch { /* one broken tree does not stop the others */ }
  }
  return done;
}
