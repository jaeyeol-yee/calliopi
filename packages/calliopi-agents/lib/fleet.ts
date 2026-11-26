// The children of this Pi, each in a pseudo-terminal this process holds: no pane opens. A child Pi
// draws its real screen into a headless terminal; /cl-agents shows it in a floating window and
// passes keys to it. A child lives as long as this Pi's session: when it ends (Pi quits, or /new,
// /resume, /fork, /reload replace this extension), the children still running are stopped and
// recorded as such. After a child ends, its last screen stays to be looked at.
import type { TerminalPane as Pane } from '@calliopi/ui/terminal-overlay';
import { postInbox, readAgent, writeResult, type AgentRecord } from '@calliopi/core/agents';
import type { ChildSpawn } from '#lib/launch.ts';

/** The size a child draws at while nobody looks; the viewer resizes it to the window. */
export const SCREEN = { cols: 120, rows: 36 };
/** How long a stop request may take before the child is killed. */
export const STOP_GRACE_MS = 5000;

export interface Child {
  id: string;
  dir: string;
  pane: Pane;
  /** Set once its Pi has exited. */
  exited?: { exitCode: number; signal?: number };
}

type PaneClass = typeof import('@calliopi/ui/terminal-overlay').TerminalPane;
let loading: Promise<PaneClass> | undefined;
/**
 * The pane class, loaded once (it brings the native PTY). One import shared by every caller: two
 * children starting together must not import it twice at once, since Pi's extension loader can hand
 * the second a module that is still being evaluated, with no exports yet. The loader may also give
 * the module back as a CommonJS namespace, with the exports under `default`: accept both.
 */
function paneClass(): Promise<PaneClass> {
  return loading ??= (async () => {
    const mod = (await import('@calliopi/ui/terminal-overlay')) as { TerminalPane?: PaneClass; default?: { TerminalPane?: PaneClass } };
    const found = mod.TerminalPane ?? mod.default?.TerminalPane;
    if (typeof found !== 'function') { loading = undefined; throw new Error('@calliopi/ui/terminal-overlay에서 TerminalPane을 찾지 못했습니다'); }
    return found;
  })();
}

export class Fleet {
  readonly children = new Map<string, Child>();
  /** Called when any child's screen changes; the viewer sets it while it is open. */
  onRender: () => void = () => {};
  private closed = false;

  async start(record: AgentRecord, spawn: ChildSpawn): Promise<Child> {
    if (this.closed) throw new Error('이 Pi가 종료되는 중입니다.');
    const Pane = await paneClass();
    if (this.closed) throw new Error('이 Pi가 종료되는 중입니다.'); // disposed while loading: start nothing it cannot stop
    const pane = new Pane({ getCwd: () => record.meta.cwd, requestRender: () => this.onRender() });
    pane.resize(SCREEN.cols, SCREEN.rows);
    const child: Child = { id: record.meta.id, dir: record.dir, pane };
    this.children.set(child.id, child);
    const ended = (exitCode: number, signal?: number) => {
      child.exited = { exitCode, signal };
      // A child that exits without a result (crashed, killed) is recorded, so nobody waits for it.
      if (!readAgent(record.dir)?.result) {
        writeResult(record.dir, { status: 'stopped', summary: '', reason: `Pi가 결과 없이 종료됨 (exit ${exitCode})`, usage: { turns: 0, tokens: 0, ms: Date.now() - record.meta.createdAt }, endedAt: Date.now() });
      }
      this.onRender();
    };
    pane.run(spawn.command, spawn.args, spawn.env).then(r => ended(r.exitCode, r.signal), () => ended(-1));
    return child;
  }

  get(id: string): Child | undefined { return this.children.get(id); }
  alive(id: string): boolean { const c = this.children.get(id); return !!c && !c.exited; }
  /** Children still running. */
  running(): number { let n = 0; for (const c of this.children.values()) if (!c.exited) n++; return n; }

  /** Ask the child to stop (it records `stopped` and exits); kill it if it has not after a grace period. */
  stop(id: string): void {
    const child = this.children.get(id);
    if (!child || child.exited) return;
    postInbox(child.dir, { id: `stop-${Date.now()}`, kind: 'stop', text: '', at: Date.now() });
    setTimeout(() => { if (!child.exited) child.pane.stop(); }, STOP_GRACE_MS).unref();
  }

  /** This Pi is ending: the children end with it. */
  dispose(): void {
    this.closed = true;
    for (const child of this.children.values()) {
      if (!child.exited && !readAgent(child.dir)?.result) {
        const meta = readAgent(child.dir)?.meta;
        writeResult(child.dir, { status: 'stopped', summary: '', reason: '부모 Pi가 종료됨', usage: { turns: 0, tokens: 0, ms: meta ? Date.now() - meta.createdAt : 0 }, endedAt: Date.now() });
      }
      child.pane.dispose();
    }
    this.children.clear();
  }
}
