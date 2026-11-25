// Usage strategies by provider, and the default environment they run in.
import fs from 'node:fs';
import os from 'node:os';
import { capture } from '#lib/capture.ts';
import { claude } from '#lib/usage/claude.ts';
import { codex } from '#lib/usage/codex.ts';
import { cursor } from '#lib/usage/cursor.ts';
import type { ProviderId, UsageEnv, UsageSnapshot, UsageStrategy } from '#lib/usage/types.ts';

export type { ProviderId, UsageEnv, UsageMetric, UsageSnapshot, UsageStrategy } from '#lib/usage/types.ts';
export { claude, codex, cursor };

export const STRATEGIES: Readonly<Record<ProviderId, UsageStrategy>> = { claude, codex, cursor };
export const PROVIDER_IDS = Object.keys(STRATEGIES) as ProviderId[];

export function defaultEnv(overrides: Partial<UsageEnv> = {}): UsageEnv {
  return {
    fetch: globalThis.fetch.bind(globalThis),
    run: capture(10_000),
    readFile: (path) => { try { return fs.readFileSync(path, 'utf8'); } catch { return undefined; } },
    exists: (path) => fs.existsSync(path),
    home: os.homedir(),
    platform: process.platform,
    env: process.env,
    now: Date.now,
    ...overrides,
  };
}

/** Every requested provider at once; one failing never hides the others (each reports its error). */
export function fetchUsage(ids: readonly ProviderId[], env: UsageEnv = defaultEnv()): Promise<UsageSnapshot[]> {
  return Promise.all(ids.map((id) => STRATEGIES[id].fetch(env)));
}
