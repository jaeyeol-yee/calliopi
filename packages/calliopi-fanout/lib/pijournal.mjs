// Optional discovery of agents that Pi (pi-cursor-sdk /cursor-runtime cloud) launched.
// The lifecycle journal holds metadata only (no live status/result), and its format is not a
// public contract — so we extract IDs by pattern and let the tracker fetch the truth.
// Nothing else from the journal is copied into the registry.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const AGENT_RE = /\bbc-[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g;
const RUN_RE = /\brun-[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g;

export function findJournals(root = path.join(os.homedir(), '.pi', 'agent', 'sessions'), maxDepth = 8) {
  const out = [];
  const walk = (dir, depth) => {
    if (depth > maxDepth) return;
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.isFile() && /^\.cursor-cloud-lifecycle-.*\.journal$/.test(e.name)) out.push(p);
    }
  };
  walk(root, 0);
  return out;
}

/** Returns [{ agentId, runId|null, journal }] — one per agent, latest runId seen on the same line. */
export function scanJournals(files) {
  const found = new Map();
  for (const f of files) {
    let text;
    try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      const agents = line.match(AGENT_RE) || [];
      const runs = line.match(RUN_RE) || [];
      for (const id of agents) {
        const prev = found.get(id);
        found.set(id, { agentId: id, runId: (agents.length === 1 && runs.at(-1)) || prev?.runId || null, journal: f });
      }
    }
  }
  return [...found.values()];
}
