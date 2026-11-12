import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { repositoryRoot, browseLog, browseLogSplit } from '../lib/git-log.ts';
import { preflight, openOverlaySession } from '../lib/overlay-session.ts';

export default function (pi: ExtensionAPI) {
  let active = false;
  let shuttingDown = false;
  let close: (() => void) | undefined;

  pi.on('session_shutdown', () => {
    shuttingDown = true;
    close?.();
  });

  pi.registerCommand('calliopi-log', {
    description: 'Pi floating terminal에서 커밋 → 변경 파일 → diff를 탐색합니다(넓으면 분할 화면). 보기 전용입니다. --steps: 단계별 화면',
    handler: async (args, ctx) => {
      const steps = args.trim() === '--steps';
      if (active) return ctx.ui.notify('이미 git 기록 창이 열려 있습니다.', 'warning');
      const problem = preflight(ctx, ['git', 'fzf', 'less']);
      if (problem) return ctx.ui.notify(`git 기록: ${problem}`, 'warning');
      let root: string;
      try { root = repositoryRoot(ctx.cwd); }
      catch { return ctx.ui.notify('git 저장소가 아닙니다.', 'warning'); }
      active = true;
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'calliopi-log-'));
      try {
        const result = await openOverlaySession<{ empty: true } | null>(ctx, {
          // Run at the repository root: diff paths are root-relative.
          cwd: root, title: ' Calliopi · git log ', footer: ' Enter: 변경 파일 · Esc: 닫기 ',
          isShuttingDown: () => shuttingDown, setClose: (fn) => { close = fn; },
          // Split view needs room for two fzf panes; narrow terminals use one step at a time.
          flow: ({ run, setFooter, cancelled, view }) => !steps && view.tui.terminal.columns >= 100
            ? browseLogSplit({ root, directory, view, setFooter, cancelled })
            : browseLog({ root, directory, run, setFooter, cancelled }),
        });
        if (shuttingDown) return;
        if (result && 'error' in result) throw new Error(result.error);
        if (result?.empty) ctx.ui.notify('아직 커밋이 없습니다.', 'info');
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        if (!shuttingDown) ctx.ui.notify(`git 기록: ${message}`, 'error');
      } finally {
        close?.(); close = undefined;
        fs.rmSync(directory, { recursive: true, force: true });
        active = false;
      }
    },
  });
}
