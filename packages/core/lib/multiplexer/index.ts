// The multiplexer Pi runs in, and panes beside it. Multiplexers nest (herdr inside tmux, tmux inside
// Rex) and pass their environment down, so the environment alone cannot tell which one is active.
// The active one is the nearest multiplexer among this process's ancestors: its panes' programs are
// its children. The environment then names the pane, and is the fallback when `ps` fails.
import { herdr } from '#lib/multiplexer/herdr.ts';
import { rex } from '#lib/multiplexer/rex.ts';
import { tmux } from '#lib/multiplexer/tmux.ts';
import type { Exec, Multiplexer, MultiplexerId, MultiplexerStrategy, SidePaneOptions } from '#lib/multiplexer/types.ts';

export type { BackgroundPaneOptions, Exec, Multiplexer, MultiplexerId, PaneRef, SidePaneOptions } from '#lib/multiplexer/types.ts';

/** Fallback order when the process tree does not decide. */
export const STRATEGIES: readonly MultiplexerStrategy[] = [rex, herdr, tmux];
export const MULTIPLEXER_NAMES = 'Rex, herdr, tmux';

export class NoMultiplexerError extends Error {
  constructor() { super(`지원하는 터미널 멀티플렉서(${MULTIPLEXER_NAMES}) 안에서 실행해주세요.`); }
}

/** Which multiplexer a process name is: Rex's server binary is `rex`; tmux may title itself "tmux: server". */
export function multiplexerOf(command: string): MultiplexerId | null {
  const name = command.trim().split('/').pop() ?? '';
  const id = /^(rex|herdr|tmux)\b/.exec(name)?.[1];
  return (id as MultiplexerId | undefined) ?? null;
}

/** Multiplexers among the ancestors of `pid`, nearest first, from `ps -A -o pid=,ppid=,comm=` output. */
export function ancestorMultiplexers(psOutput: string, pid: number): MultiplexerId[] {
  const parent = new Map<number, { ppid: number; command: string }>();
  for (const line of psOutput.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (m) parent.set(Number(m[1]), { ppid: Number(m[2]), command: m[3]! });
  }
  const found: MultiplexerId[] = [];
  for (let p = parent.get(pid)?.ppid, hops = 0; p && p > 1 && hops < 64; p = parent.get(p)?.ppid, hops++) {
    const id = multiplexerOf(parent.get(p)?.command ?? '');
    if (id && !found.includes(id)) found.push(id);
  }
  return found;
}

export interface DetectOptions {
  exec: Exec;
  env?: NodeJS.ProcessEnv;
  pid?: number;
}

/** The active multiplexer; null outside any (or when CALLIOPI_MULTIPLEXER names one this process is not in). */
export async function detectMultiplexer({ exec, env = process.env, pid = process.pid }: DetectOptions): Promise<Multiplexer | null> {
  const inside = (id: MultiplexerId) => STRATEGIES.find((s) => s.id === id)?.detect(env) ?? null;
  const forced = env.CALLIOPI_MULTIPLEXER as MultiplexerId | undefined;
  if (forced && STRATEGIES.some((s) => s.id === forced)) return inside(forced);
  const ps = await exec('ps', ['-A', '-o', 'pid=,ppid=,comm='], { timeout: 5000 }).catch(() => null);
  if (ps?.code === 0) {
    for (const id of ancestorMultiplexers(ps.stdout, pid)) {
      const mux = inside(id);
      if (mux) return mux;
    }
  }
  for (const strategy of STRATEGIES) {
    const mux = strategy.detect(env);
    if (mux) return mux;
  }
  return null;
}

export async function openSidePane(exec: Exec, options: SidePaneOptions, detect: Omit<DetectOptions, 'exec'> = {}) {
  const mux = await detectMultiplexer({ exec, ...detect });
  if (!mux) throw new NoMultiplexerError();
  return { multiplexer: mux.name, ...(await mux.openSide(exec, options)) };
}
