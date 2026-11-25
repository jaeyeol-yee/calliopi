// Panes beside Pi, through the terminal multiplexer Pi runs in: one strategy per multiplexer.
// Pi cannot split its own screen (overlays cover the transcript), so side-by-side views live in a
// multiplexer pane. A strategy recognises its multiplexer from the environment it sets in its
// panes, and drives it through its CLI.

export type MultiplexerId = 'rex' | 'herdr' | 'tmux';

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

/** A pane in a window (tab) of its own, opened without leaving the current one. */
export type BackgroundPaneOptions = Pick<SidePaneOptions, 'command' | 'cwd' | 'label'>;

/** A pane, as stored to find it again from another Pi process. */
export interface PaneRef {
  multiplexer: MultiplexerId;
  /** The multiplexer session (or server) the pane id is unique in. */
  session: string;
  pane: string;
}

export interface Multiplexer {
  id: MultiplexerId;
  name: string;
  /** The pane this process runs in. */
  self: PaneRef;
  /** Open `command` in a new pane to the right of this one. */
  openSide(exec: Exec, options: SidePaneOptions): Promise<{ paneId: string | null }>;
  /** Move an existing pane of the same session to the right of this one, `ratio` percent wide. */
  moveBeside(exec: Exec, pane: string, ratio: number): Promise<void>;
  /** Open `command` in a new window behind the current one. Absent where the multiplexer has no such thing (yet). */
  openBackground?(exec: Exec, options: BackgroundPaneOptions): Promise<{ paneId: string | null }>;
  /** Bring a pane of the same session to the front and focus it. */
  focus?(exec: Exec, pane: string): Promise<void>;
  /** The pane's visible screen as text. */
  capture?(exec: Exec, pane: string): Promise<string>;
}

export interface MultiplexerStrategy {
  id: MultiplexerId;
  /** The multiplexer this process runs inside, judged from the environment; null when not inside it. */
  detect(env: NodeJS.ProcessEnv): Multiplexer | null;
}

export const TIMEOUT_MS = 10_000;

/** Run a multiplexer CLI command; a failure throws with its stderr. */
export async function run(exec: Exec, command: string, args: string[], what: string) {
  const result = await exec(command, args, { timeout: TIMEOUT_MS });
  if (result.code !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || `${what}에 실패했습니다.`);
  return result.stdout;
}
