import path from 'node:path';
import type { FanoutConfig } from '#lib/types.ts';

/**
 * All paths derive from one state directory so that every process
 * (launcher, daemon, follow panes, rex Lua) agrees without shared memory.
 * Pass --dir explicitly from multiplexer layers: terminal panes don't inherit env reliably.
 */
export function loadConfig(flags: { dir?: string; rpm?: string | number; tick?: string | number; max?: string | number } = {}): FanoutConfig {
  const dir = path.resolve(flags.dir || process.env.CURSOR_FANOUT_DIR || '.cursor-fanout');
  const num = (v: string | number | undefined | null, d: number) => (v == null || v === '' || Number.isNaN(Number(v)) ? d : Number(v));
  return {
    dir,
    registryPath: path.join(dir, 'registry.json'),
    lockPath: path.join(dir, 'registry.lock'),
    pidPath: path.join(dir, 'tracker.pid'),
    dashboardPath: path.join(dir, 'cursor-cloud-dashboard.txt'),
    logPath: path.join(dir, 'tracker.log'),
    reportPath: path.join(dir, 'report.md'),
    apiBase: (process.env.CURSOR_API_BASE || 'https://api.cursor.com').replace(/\/+$/, ''),
    // Cloud Agents API documents only "standard rate limiting"; the account-wide default
    // elsewhere is 20 req/min. Stay under it by default.
    rpm: num(flags.rpm ?? process.env.CURSOR_FANOUT_RPM, 15),
    tickMs: num(flags.tick ?? process.env.CURSOR_FANOUT_TICK_MS, 5000),
    // Per-status base poll intervals (ms). WAITING_FOR_BACKGROUND_WORK is slow on purpose.
    // CURSOR_FANOUT_INTERVAL_SCALE exists for tests against the mock server.
    intervals: Object.fromEntries(Object.entries({
      CREATING: 15_000,
      RUNNING: 30_000,
      WAITING_FOR_BACKGROUND_WORK: 120_000,
      UNKNOWN: 30_000,
      MAX: 300_000,
    }).map(([k, v]) => [k, Math.round(v * num(process.env.CURSOR_FANOUT_INTERVAL_SCALE, 1))])),
    runsPageLimit: 5, // listRuns limit (API max 100); newest-first so 5 covers follow-ups.
    indexThreshold: 3, // use GET /v1/agents index when >= N agents are due in one tick
    maxPerLaunch: num(flags.max ?? process.env.CURSOR_FANOUT_MAX, 20),
  };
}
