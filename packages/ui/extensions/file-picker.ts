import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { CURSOR_MARKER, renderFakeCursor, truncateToWidth } from '@earendil-works/pi-tui';
import { listFiles } from '../lib/file-edit.ts';
import { editOneFile } from '../lib/editor-flow.ts';

export default function (pi: ExtensionAPI) {
  let active = false;
  let shuttingDown = false;
  let close: (() => void) | undefined;

  pi.on('session_shutdown', () => {
    shuttingDown = true;
    close?.();
  });

  pi.registerCommand('calliopi-edit', {
    description: 'Pi floating terminal에서 fzf로 파일 하나를 선택해 Vim으로 편집합니다. 변경분은 다음 대화에 전달합니다.',
    handler: async (args, ctx) => {
      const inputLog = args.trim() === '--debug-input' ? path.join(os.tmpdir(), `calliopi-input-${process.pid}-${Date.now()}.jsonl`) : undefined;
      if (ctx.mode !== 'tui') return ctx.ui.notify('파일 편집기는 Pi 대화형 TUI에서만 사용할 수 있습니다.', 'warning');
      if (active) return ctx.ui.notify('이미 파일 편집기가 열려 있습니다.', 'warning');
      if (!ctx.isIdle()) return ctx.ui.notify('Pi 작업이 끝난 뒤 파일 편집기를 열어주세요.', 'warning');
      if (process.platform === 'win32') return ctx.ui.notify('파일 편집기는 현재 macOS/Linux를 지원합니다.', 'warning');
      for (const command of ['rg', 'fzf', 'vim']) {
        const check = spawnSync('/bin/sh', ['-c', 'command -v "$1"', 'sh', command], { encoding: 'utf8' });
        if (check.status !== 0) return ctx.ui.notify(`${command}를 PATH에서 찾을 수 없습니다. 먼저 설치해주세요.`, 'error');
      }
      active = true;
      let directory: string | undefined;
      let unsubscribe: (() => void) | undefined;
      try {
        // Lazy import: other UI resources still load when native PTY dependencies are unavailable.
        const { TerminalOverlay } = await import('../lib/terminal-overlay.ts');
        const candidates = listFiles(ctx.cwd);
        if (!candidates.length) return ctx.ui.notify('선택할 파일이 없습니다. ignored·hidden·민감 파일은 제외합니다.', 'info');
        directory = fs.mkdtempSync(path.join(os.tmpdir(), 'calliopi-edit-'));
        const privateDirectory = directory;
        const result = await ctx.ui.custom<any>((tui, theme, _keys, done) => {
          if (tui.terminal.columns < 40 || tui.terminal.rows < 12) throw new Error('편집 창을 열려면 터미널 크기가 최소 40칸 × 12줄이어야 합니다.');
          const view = new TerminalOverlay({ tui, theme, cwd: ctx.cwd, inputLog, ui: { CURSOR_MARKER, renderFakeCursor, truncateToWidth } });
          let finished = false;
          const finish = (value: any) => {
            if (finished) return;
            finished = true;
            unsubscribe?.(); unsubscribe = undefined;
            view.dispose();
            done(value);
          };
          close = () => finish(null);
          // Consume before Pi's application shortcuts. Esc/Ctrl+C/Ctrl+D belong to fzf/Vim,
          // not to Pi. A covering dialog keeps its own input when this overlay loses focus.
          unsubscribe = ctx.ui.onTerminalInput(data => {
            if (!view.focused || finished) return;
            view.handleInput(data);
            return { consume: true };
          });
          // Start after the component is mounted and its initial PTY size has been rendered.
          queueMicrotask(() => {
            void editOneFile({
              cwd: ctx.cwd, candidates, directory: privateDirectory,
              run: (command: string, args: string[], env?: NodeJS.ProcessEnv) => view.run(command, args, env),
              cancelled: () => finished || shuttingDown,
            }).then(finish, error => finish({ error: error.message }));
          });
          return view;
        }, {
          overlay: true,
          overlayOptions: { anchor: 'center', width: '90%', maxHeight: '85%', margin: 1 },
          blocked: { kind: 'question', message: '파일 선택 또는 Vim 편집 중' },
        });
        if (shuttingDown) return;
        if (inputLog) ctx.ui.notify(`입력 진단 로그: ${inputLog}`, 'info');
        if (result?.error) throw new Error(result.error);
        if (result?.content) {
          pi.sendMessage({ customType: 'calliopi-file-edit', content: result.content, display: false, details: { file: result.file } }, { deliverAs: 'nextTurn' });
          ctx.ui.notify(`${result.file} 변경 사항을 다음 대화에 전달합니다.`, 'info');
        } else if (result?.file) ctx.ui.notify(`${result.file}: 변경 없음`, 'info');
        if (result?.exitCode) ctx.ui.notify(`Vim이 코드 ${result.exitCode}로 종료했습니다. 저장된 변경은 반영했습니다.`, 'warning');
      } catch (error: any) {
        if (!shuttingDown) ctx.ui.notify(`파일 편집기: ${error.message}`, 'error');
      } finally {
        close?.(); close = undefined;
        unsubscribe?.();
        if (directory) fs.rmSync(directory, { recursive: true, force: true });
        active = false;
      }
    },
  });
}
