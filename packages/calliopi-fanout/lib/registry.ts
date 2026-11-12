// The registry is the single source of truth for what is tracked.
// One JSON file (0600) in a 0700 dir, written atomically (tmp + rename) under an O_EXCL lock,
// so the launcher, daemon, follow panes and rex Lua can all read it without coordination.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { caught, nowIso, processAlive, sleep } from './util.ts';
import type { AgentRecord, HistoryEntry, Registry, StoreConfig } from './types.ts';

const EMPTY = (): Registry => ({ version: 1, updatedAt: null, meta: { panes: {} }, batches: {}, agents: {} });

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch { /* not owner */ }
}

export function load(cfg: { registryPath: string }): Registry {
  let text: string;
  try { text = fs.readFileSync(cfg.registryPath, 'utf8'); } catch (e: unknown) {
    if (caught(e).code === 'ENOENT') return EMPTY();
    throw e;
  }
  // Never silently replace a corrupt registry: it holds the only record of paid agents.
  const reg = JSON.parse(text) as Registry;
  reg.meta ??= { panes: {} };
  reg.meta.panes ??= {};
  reg.batches ??= {};
  reg.agents ??= {};
  return reg;
}

async function acquire(cfg: StoreConfig, timeoutMs = 15_000): Promise<void> {
  ensureDir(cfg.dir);
  const start = Date.now();
  for (;;) {
    try {
      const fh = await fsp.open(cfg.lockPath, 'wx', 0o600);
      await fh.writeFile(`${process.pid} ${Date.now()}`);
      await fh.close();
      return;
    } catch (e: unknown) {
      if (caught(e).code !== 'EEXIST') throw e;
      // Steal locks left by dead processes or held absurdly long.
      try {
        const [pid, t] = fs.readFileSync(cfg.lockPath, 'utf8').split(' ').map(Number);
        if (!processAlive(pid) || Date.now() - t > 30_000) { fs.rmSync(cfg.lockPath, { force: true }); continue; }
      } catch { /* raced with release */ }
      if (Date.now() - start > timeoutMs) throw new Error(`registry lock busy: ${cfg.lockPath}`);
      await sleep(25 + Math.random() * 50);
    }
  }
}

function writeAtomic(file: string, text: string): void {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch { /* ignore */ }
}

/** Read-modify-write under the lock. `mutator(reg)` may return a value, passed through. */
export async function update<T>(cfg: StoreConfig, mutator: (reg: Registry) => T | Promise<T>): Promise<T> {
  await acquire(cfg);
  try {
    const reg = load(cfg);
    const out = await mutator(reg);
    reg.updatedAt = nowIso();
    writeAtomic(cfg.registryPath, JSON.stringify(reg, null, 2));
    return out;
  } finally {
    fs.rmSync(cfg.lockPath, { force: true });
  }
}

export function newAgentRecord(fields: Partial<AgentRecord>): AgentRecord {
  return {
    agentId: null,
    key: null,
    batch: null,
    label: null,
    source: 'launch', // launch | add | pi-journal
    phase: 'planned', // planned | created | create_failed | imported
    name: null,
    url: null,
    repo: null,
    ref: null,
    promptPreview: null,
    promptSha: null,
    runId: null, // current (newest) run
    status: null, // raw REST status of current run
    statusChangedAt: null,
    runs: {}, // runId -> { status, createdAt, updatedAt, durationMs, result, finalized, usage }
    history: [],
    git: null,
    gitPrev: null,
    finalized: false,
    missing: false,
    poll: { nextAt: 0, interval: 0, unchanged: 0, lastAt: null, lastAgentUpdatedAt: null },
    lastError: null,
    pane: null,
    createdAt: nowIso(),
    ...fields,
  };
}

/** Lookup by agentId, unique prefix, label, or pane block id. */
export function findAgent(reg: Registry, needle: string | null | undefined): AgentRecord | null {
  if (!needle) return null;
  const all = Object.values(reg.agents);
  return (
    reg.agents[needle] ||
    all.find((a) => a.pane?.blockId === needle) ||
    all.find((a) => a.label === needle) ||
    (() => {
      const hits = all.filter((a) => a.agentId?.startsWith(needle));
      return hits.length === 1 ? hits[0] : null;
    })()
  ) ?? null;
}

export const trackable = (a: AgentRecord): boolean | string | null | undefined =>
  (a.phase === 'created' || a.phase === 'imported') && a.agentId && !a.missing && !a.finalized;

export function pushHistory(a: { history: HistoryEntry[] }, entry: Omit<HistoryEntry, 'at'>): void {
  a.history.push({ at: nowIso(), ...entry });
  if (a.history.length > 50) a.history.splice(0, a.history.length - 50);
}

export { path };
