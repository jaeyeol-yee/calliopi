import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { detectMultiplexer, openSidePane } from '@calliopi/ui/pane';
import { preflight, openOverlaySession } from '@calliopi/ui/overlay-session';
import { listFiles, pickable } from '#lib/file-edit.ts';
import { repositoryRoot } from '#lib/git-log.ts';
import { pickFile } from '#lib/preview-pick.ts';
import { changedSince, parentBranch } from '#lib/preview-git.ts';
import { drainShares, shareMessage, paneAlive, writeRequest, CLOSED_MARKER } from '#lib/preview-share.ts';
import type { PaneConfig } from '#lib/preview-pane.ts';

const paneScript = fileURLToPath(new URL('../bin/preview-pane.ts', import.meta.url));

// /cl-preview [query]: pick a file with fzf in Pi's floating overlay, then show it in a pane beside Pi
// (a multiplexer pane: Pi cannot split its own screen). Running it again shows the new file in the
// same pane. The pane follows edits, compares with a branch on demand (b) and can share with Pi (s).
// /cl-preview --changed[=<branch>] [query] lists only files changed since HEAD left that branch
// (default: the nearest local branch, see parentBranch).
export default function (pi: ExtensionAPI) {
  let pane: string | undefined; // private directory of the open pane
  let poll: NodeJS.Timeout | undefined;
  let lastCtx: ExtensionContext | undefined;
  let picking = false;
  let shuttingDown = false;
  let closeOverlay: (() => void) | undefined;

  const forget = () => { if (pane) fs.rmSync(pane, { recursive: true, force: true }); pane = undefined; clearInterval(poll); poll = undefined; };
  const drain = () => {
    if (!pane) return;
    for (const share of drainShares(path.join(pane, 'outbox'))) {
      pi.sendMessage({ customType: 'calliopi-preview', content: shareMessage(share), display: false, details: { file: share.file, mode: share.mode, ref: share.ref } }, { deliverAs: 'nextTurn' });
      lastCtx?.ui.notify(`${share.file} 미리보기 내용을 다음 대화에 전달합니다.`, 'info');
    }
    if (fs.existsSync(path.join(pane, CLOSED_MARKER))) forget();
  };

  pi.on('session_shutdown', () => { shuttingDown = true; closeOverlay?.(); forget(); }); // an open pane can no longer share; it says so

  pi.registerCommand('cl-preview', {
    description: 'fzf로 파일을 찾아 옆 pane에 띄웁니다. 다시 실행하면 같은 pane에서 파일을 바꿉니다. 스크롤·찾기, 변경 자동 반영, b 브랜치와 갈라진 뒤 diff, s 대화로 전달. 인자는 검색어, --changed[=브랜치](-c)는 부모 브랜치(가장 가까운 로컬 브랜치)에서 갈라진 뒤 바뀐 파일만. Rex 안에서 사용합니다.',
    handler: async (args, ctx) => {
      if (picking) return ctx.ui.notify('이미 파일을 고르는 중입니다.', 'warning');
      if (!detectMultiplexer()) return ctx.ui.notify('미리보기: 터미널 멀티플렉서(Rex) 안에서 실행해주세요. Pi 화면은 나눌 수 없어 옆 pane에 띄웁니다.', 'warning');
      const words = args.trim().split(/\s+/).filter(Boolean);
      const flag = /^(?:--changed|-c)(?:=(.+))?$/.exec(words[0] ?? '');
      const changedOnly = flag !== null;
      const query = (changedOnly ? words.slice(1) : words).join(' ') || undefined;
      const problem = preflight(ctx, changedOnly ? ['fzf', 'git'] : ['fzf', 'rg']);
      if (problem) return ctx.ui.notify(`미리보기: ${problem}`, 'warning');
      let root: string | null = null;
      try { root = fs.realpathSync(repositoryRoot(ctx.cwd)); } catch { /* not a repository: no diffs or branch comparison */ }
      let candidates: string[];
      let scope: string | undefined;
      let base: string | null | undefined;
      if (changedOnly) {
        // The changed files are the list: no rg walk over the whole tree (matters in a monorepo).
        base = flag[1] ?? parentBranch(ctx.cwd);
        const changed = base ? changedSince(ctx.cwd, base) : null;
        if (!base) return ctx.ui.notify('미리보기: 비교할 부모 브랜치를 찾지 못했습니다. --changed=<브랜치>로 지정하세요.', 'warning');
        if (!changed) return ctx.ui.notify(`미리보기: ${base}와 공통 조상을 찾지 못했습니다. 브랜치 이름을 확인하세요.`, 'warning');
        candidates = pickable(ctx.cwd, [...changed].sort(), { skipHidden: true });
        if (!candidates.length) return ctx.ui.notify(`${base}에서 갈라진 뒤 바뀐 파일이 없습니다. 삭제·hidden·민감 파일은 제외합니다.`, 'info');
        scope = `${base}에서 갈라진 뒤 변경 ${candidates.length}개`;
      } else {
        candidates = listFiles(ctx.cwd);
      }
      if (!candidates.length) return ctx.ui.notify('선택할 파일이 없습니다. ignored·hidden·민감 파일은 제외합니다.', 'info');

      picking = true;
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'calliopi-preview-pick-'));
      let file: string | null = null;
      try {
        const result = await openOverlaySession<string | null>(ctx, {
          cwd: ctx.cwd, title: ' Calliopi · 파일 미리보기 ', footer: ' Enter: 옆 pane에 표시 · Esc: 취소 ',
          blocked: { kind: 'question', message: '미리볼 파일 선택 중' },
          isShuttingDown: () => shuttingDown, setClose: fn => { closeOverlay = fn; },
          flow: ({ run, cancelled }) => pickFile({ candidates, directory, run, cancelled, query, scope, cwd: ctx.cwd, root, base, diffFirst: changedOnly }),
        });
        if (result && typeof result === 'object') throw new Error(result.error);
        file = result;
      } catch (error) {
        if (!shuttingDown) ctx.ui.notify(`미리보기: ${error instanceof Error ? error.message : String(error)}`, 'error');
      } finally {
        closeOverlay?.(); closeOverlay = undefined;
        fs.rmSync(directory, { recursive: true, force: true });
        picking = false;
      }
      if (!file || shuttingDown) return;

      lastCtx = ctx;
      if (pane && paneAlive(pane)) { writeRequest(pane, file); return; } // same sidebar, new file
      forget();
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'calliopi-preview-'));
      fs.mkdirSync(path.join(dir, 'outbox'), { mode: 0o700 });
      const config: PaneConfig = { cwd: ctx.cwd, root, file, dir, piPid: process.pid };
      const configPath = path.join(dir, 'config.json');
      fs.writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
      try {
        await openSidePane((command, a, options) => pi.exec(command, a, options), { command: [process.execPath, paneScript, configPath], cwd: ctx.cwd, label: 'cl-preview', ratio: 45 });
      } catch (error) {
        fs.rmSync(dir, { recursive: true, force: true });
        return ctx.ui.notify(`미리보기: ${error instanceof Error ? error.message : String(error)}`, 'error');
      }
      pane = dir;
      poll ??= setInterval(drain, 500);
    },
  });
}
