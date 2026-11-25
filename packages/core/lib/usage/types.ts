// Subscription usage per AI coding provider, one strategy each (modeled on OpenUsage's provider
// runtimes: https://github.com/robinebers/openusage). A strategy finds a credential the user already
// has on this machine, reads the provider's usage endpoint, and maps it to metrics a gauge can draw.
//
// Credentials are read only: a strategy never refreshes another tool's token, because rotating it
// would sign that tool out. An expired token is reported, and the tool that owns it refreshes it.
import type { Capture } from '#lib/capture.ts';

export type ProviderId = 'claude' | 'codex' | 'cursor';

export interface UsageMetric {
  label: string;
  /** Used amount, in `unit`. For `percent`, 0–100. */
  used: number;
  /** Limit in `unit`; undefined for a plain amount with no limit (e.g. a credit balance). */
  limit?: number;
  unit: 'percent' | 'usd' | 'credits';
  /** When the window resets (epoch ms). */
  resetsAt?: number;
  /** Window length (ms), to place an even-pace mark. */
  periodMs?: number;
}

export interface UsageSnapshot {
  id: ProviderId;
  label: string;
  plan?: string;
  metrics: UsageMetric[];
  /** Where the credential came from, e.g. "Pi 로그인" or "~/.codex/auth.json". */
  source?: string;
  /** Why there are no metrics; a short sentence for the user. */
  error?: string;
  fetchedAt: number;
}

/** Everything a strategy touches outside itself, so tests can fake it. */
export interface UsageEnv {
  fetch: typeof fetch;
  run: Capture;
  readFile(path: string): string | undefined;
  exists(path: string): boolean;
  home: string;
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  now(): number;
  /** Pi's own login for a provider (it refreshes its tokens itself), when running inside Pi. */
  piToken?(provider: string): Promise<string | undefined>;
}

export interface UsageStrategy {
  id: ProviderId;
  label: string;
  fetch(env: UsageEnv): Promise<UsageSnapshot>;
}

/** A credential and where it came from. */
export interface Credential {
  token: string;
  source: string;
  /** Extra values the provider needs alongside the token (e.g. ChatGPT account id). */
  extra?: Record<string, string>;
}

/** A failure the user can act on; its message is shown as is. */
export class UsageError extends Error {}
