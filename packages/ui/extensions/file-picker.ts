import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { listFiles } from '#lib/file-edit.ts';
import { editOneFile, type EditResult } from '#lib/editor-flow.ts';
import { preflight, openOverlaySession } from '#lib/overlay-session.ts';

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
      if (active) return ctx.ui.notify('이미 파일 편집기가 열려 있습니다.', 'warning');
      const problem = preflight(ctx, ['rg', 'fzf', 'vim']);
      if (problem) return ctx.ui.notify(`파일 편집기: ${problem}`, 'warning');
      active = true;
      let directory: string | undefined;
      try {
        const candidates = listFiles(ctx.cwd);
        if (!candidates.length) return ctx.ui.notify('선택할 파일이 없습니다. ignored·hidden·민감 파일은 제외합니다.', 'info');
        directory = fs.mkdtempSync(path.join(os.tmpdir(), 'calliopi-edit-'));
        const privateDirectory = directory;
        const result = await openOverlaySession<EditResult | null>(ctx, {
          cwd: ctx.cwd, inputLog,
          title: ' Calliopi · fzf → Vim ', footer: ' Esc: fzf 취소 · :q: 편집 종료 ',
          blocked: { kind: 'question', message: '파일 선택 또는 Vim 편집 중' },
          isShuttingDown: () => shuttingDown, setClose: (fn) => { close = fn; },
          flow: ({ run, cancelled }) => editOneFile({ cwd: ctx.cwd, candidates, directory: privateDirectory, run, cancelled }),
        });
        if (shuttingDown) return;
        if (inputLog) ctx.ui.notify(`입력 진단 로그: ${inputLog}`, 'info');
        if (result && 'error' in result) throw new Error(result.error);
        if (result?.content) {
          pi.sendMessage({ customType: 'calliopi-file-edit', content: result.content, display: false, details: { file: result.file } }, { deliverAs: 'nextTurn' });
          ctx.ui.notify(`${result.file} 변경 사항을 다음 대화에 전달합니다.`, 'info');
        } else if (result?.file) ctx.ui.notify(`${result.file}: 변경 없음`, 'info');
        if (result?.exitCode) ctx.ui.notify(`Vim이 코드 ${result.exitCode}로 종료했습니다. 저장된 변경은 반영했습니다.`, 'warning');
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        if (!shuttingDown) ctx.ui.notify(`파일 편집기: ${message}`, 'error');
      } finally {
        close?.(); close = undefined;
        if (directory) fs.rmSync(directory, { recursive: true, force: true });
        active = false;
      }
    },
  });
}
