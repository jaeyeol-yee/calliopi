// Open a command in a pane beside the current one, through the terminal multiplexer Pi runs in.
// Pi cannot split its own screen (overlays cover the transcript), so side-by-side views live in a
// multiplexer pane. Only Rex is implemented; tmux, zellij and cmux can be added as more adapters.

/** Structural subset of pi.exec, so callers pass it straight through. */
export type Exec = (command: string, args: string[], options?: { cwd?: string; timeout?: number }) =>
  Promise<{ code: number; stdout: string; stderr: string }>;

export interface SidePaneOptions {
  /** Program and arguments, run without a shell. */
  command: string[];
  cwd: string;
  label: string;
  /** Percent of the split given to the new pane (default 50). */
  ratio?: number;
  /** Keep the pane after the program exits, e.g. to read its output (default false: the pane closes). */
  keepOpen?: boolean;
  /** Move focus to the new pane (default true). */
  focus?: boolean;
}

export interface Multiplexer {
  name: string;
  openSide(exec: Exec, options: SidePaneOptions): Promise<{ paneId: string | null }>;
}

export class NoMultiplexerError extends Error {
  constructor() { super('지원하는 터미널 멀티플렉서(Rex) 안에서 실행해주세요.'); }
}

function rex(session: string, block: string): Multiplexer {
  return {
    name: 'Rex',
    async openSide(exec, { command, cwd, label, ratio = 50, keepOpen = false, focus = true }) {
      const args = ['split', '-s', session, '-b', block, '--split=right', '--ratio', String(ratio), '--label', label, '-c', cwd,
        ...(keepOpen ? ['--keep-open'] : []), ...(focus ? [] : ['--focus=false']), '--json', '--', ...command];
      const result = await exec('rex', args, { timeout: 10_000 });
      if (result.code !== 0) throw new Error(result.stderr.trim() || 'Rex pane을 열지 못했습니다.');
      try { return { paneId: (JSON.parse(result.stdout) as { block_ids?: string[] }).block_ids?.[0] ?? null }; }
      catch { return { paneId: null }; }
    },
  };
}

/** The multiplexer this process runs inside, judged from the environment it sets; null when none. */
export function detectMultiplexer(env: NodeJS.ProcessEnv = process.env): Multiplexer | null {
  if (env.REX_SESSION && env.REX_BLOCK) return rex(env.REX_SESSION, env.REX_BLOCK);
  return null;
}

export async function openSidePane(exec: Exec, options: SidePaneOptions, env: NodeJS.ProcessEnv = process.env) {
  const mux = detectMultiplexer(env);
  if (!mux) throw new NoMultiplexerError();
  return { multiplexer: mux.name, ...(await mux.openSide(exec, options)) };
}
