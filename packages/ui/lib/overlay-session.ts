// Shared lifecycle for "run a sequence of terminal programs in a Pi floating overlay".
// Used by /calliopi-edit and /calliopi-log. Pi-only (imports pi-tui); node tests use the pieces below it.
import { spawnSync } from 'node:child_process';
import { CURSOR_MARKER, renderFakeCursor, truncateToWidth, type ProgramStatus } from '@earendil-works/pi-tui';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { TerminalOverlay } from '#lib/terminal-overlay.ts';
import type { RunProgram } from '#lib/types.ts';

type PreflightContext = Pick<ExtensionContext, 'mode' | 'isIdle'>;

export function preflight(ctx: PreflightContext, commands: readonly string[]): string | null {
  if (ctx.mode !== 'tui') return 'Pi 대화형 TUI에서만 사용할 수 있습니다.';
  if (!ctx.isIdle()) return 'Pi 작업이 끝난 뒤 다시 열어주세요.';
  if (process.platform === 'win32') return '현재 macOS/Linux를 지원합니다.';
  for (const command of commands) {
    const check = spawnSync('/bin/sh', ['-c', 'command -v "$1"', 'sh', command], { encoding: 'utf8' });
    if (check.status !== 0) return `${command}를 PATH에서 찾을 수 없습니다. 먼저 설치해주세요.`;
  }
  return null;
}

// flow({ run, setFooter, cancelled, view }) runs programs in the same overlay. `view` gives
// multi-pane flows access to panes, layout, focus and the overlay key handler.
export interface OverlayFlow {
  run: RunProgram;
  setFooter: (text: string) => void;
  cancelled: () => boolean;
  view: TerminalOverlay;
}

export interface OverlaySessionOptions<T> {
  cwd: string;
  title?: string;
  footer?: string;
  blocked?: { kind: NonNullable<ProgramStatus['kind']>; message: string };
  inputLog?: string;
  isShuttingDown: () => boolean;
  setClose: (close: (() => void) | undefined) => void;
  flow: (flow: OverlayFlow) => Promise<T>;
}

// Resolves with the flow's value, null when closed externally, or { error }.
export async function openOverlaySession<T>(ctx: ExtensionContext, { cwd, title, footer, blocked, inputLog, isShuttingDown, setClose, flow }: OverlaySessionOptions<T>): Promise<T | { error: string } | null> {
  // Lazy import: other UI resources still load when native PTY dependencies are unavailable.
  const { TerminalOverlay } = await import('#lib/terminal-overlay.ts');
  let unsubscribe: (() => void) | undefined;
  try {
    return await ctx.ui.custom<T | { error: string } | null>((tui, theme, _keys, done) => {
      if (tui.terminal.columns < 40 || tui.terminal.rows < 12) throw new Error('창을 열려면 터미널 크기가 최소 40칸 × 12줄이어야 합니다.');
      const view = new TerminalOverlay({ tui, theme, cwd, inputLog, title, footer, ui: { CURSOR_MARKER, renderFakeCursor, truncateToWidth } });
      let finished = false;
      const finish = (value: T | { error: string } | null) => {
        if (finished) return;
        finished = true;
        unsubscribe?.(); unsubscribe = undefined;
        setClose(undefined);
        view.dispose();
        done(value);
      };
      setClose(() => finish(null));
      // Consume before Pi's application shortcuts: Esc/Ctrl+C/Ctrl+D/q belong to the inner program.
      // A covering dialog keeps its own input when this overlay loses focus.
      unsubscribe = ctx.ui.onTerminalInput(data => {
        if (!view.focused || finished) return;
        view.handleInput(data);
        return { consume: true };
      });
      // Start after the component is mounted and its initial PTY size has been rendered.
      queueMicrotask(() => {
        void Promise.resolve().then(() => flow({
          run: (command, args, env) => view.run(command, args, env),
          setFooter: text => { view.footer = text; tui.requestRender(); },
          cancelled: () => finished || isShuttingDown(),
          view,
        })).then(finish, (error: unknown) => finish({ error: error instanceof Error ? error.message : String(error) }));
      });
      return view;
    }, {
      overlay: true,
      overlayOptions: { anchor: 'center', width: '90%', maxHeight: '85%', margin: 1 },
      blocked,
    });
  } finally { unsubscribe?.(); }
}
