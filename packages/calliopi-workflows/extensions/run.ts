import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { cleanDisplay, nodePreview } from '@calliopi/core/fzf';
import { detectMultiplexer, MULTIPLEXER_NAMES, type Exec, type Multiplexer } from '@calliopi/core/multiplexer';
import { runWorkflow } from '@calliopi/core/workflow';
import { preflight, openOverlaySession } from '@calliopi/ui/overlay-session';
import { inferCommand, inferContext } from '#lib/job-infer.ts';
import { createJob, interruptJob, jobMessage, jobName, jobsRoot, listJobs, parseRunArgs, plainLog, pruneJobs, readJob, sameRun, setJobPane, statusText, stopJob, EXIT_FILE, JOB_LIST, type Job } from '#lib/jobs.ts';

const runner = fileURLToPath(new URL('../bin/job-runner.ts', import.meta.url));
const preview = fileURLToPath(new URL('../bin/job-preview.ts', import.meta.url));

const SHARE = '출력 끝부분을 대화에 전달', SCREEN = '지금 화면을 대화에 전달', FOCUS = 'pane으로 이동', STOP = '중지', REMOVE = '기록 삭제';

// /cl-run [-s] [-n <name>] <command>: run a command in a pane instead of with `!`, which holds Pi
// until the command ends. The pane opens beside Pi without taking focus; -s (--silent) runs it in a
// background window instead (tmux). Pi is told when it ends: a notice, and the exit code with the
// end of the output for the next turn.
// /cl-run ? <words>: the current model writes the command; it runs only after the user confirms it.
// /cl-jobs: every job with its state; pick one to pass its output on, go to its pane, stop or forget it.
// ctrl+\ or alt+k: Ctrl+C to the newest job started here; pressed again soon after, stop it, then kill it.
// ctrl+\ reaches Pi in any terminal; alt+k only where Option (macOS) is sent as Alt, not as a character (˚).
export const STOP_KEYS = ['ctrl+\\', 'alt+k'] as const;
/** Presses this close together escalate: Ctrl+C, then SIGTERM, then SIGKILL to the process group. */
const ESCALATE_MS = 3000;

export default function (pi: ExtensionAPI) {
  const watched = new Set<string>(); // job directories started here and still running
  // The runner writes the exit code the moment the command ends; watching for it tells Pi at once.
  // The poll stays for what leaves no file (a runner killed outright) and for file systems without events.
  const watchers = new Map<string, fs.FSWatcher>();
  const unwatch = (dir: string) => { watchers.get(dir)?.close(); watchers.delete(dir); };
  let presses: { dir: string; at: number; count: number } | undefined;
  let poll: NodeJS.Timeout | undefined;
  let lastCtx: ExtensionContext | undefined;
  let picking = false;
  let shuttingDown = false;
  let closeOverlay: (() => void) | undefined;
  const exec: Exec = (command, args, options) => pi.exec(command, args, options);

  const share = (job: Job, content = jobMessage(job)) =>
    pi.sendMessage({ customType: 'calliopi-job', content, display: false, details: { name: job.name, state: job.state, exitCode: job.exitCode } }, { deliverAs: 'nextTurn' });

  const check = () => {
    for (const dir of watched) {
      const job = readJob(dir);
      if (job?.state === 'running') continue;
      watched.delete(dir);
      unwatch(dir);
      if (!job) continue; // forgotten from /cl-jobs
      share(job);
      lastCtx?.ui.notify(`${job.name}: ${statusText(job)}. 결과를 다음 대화에 전달합니다.`, job.state === 'exited' && job.exitCode === 0 ? 'info' : 'warning');
    }
    if (!watched.size) { clearInterval(poll); poll = undefined; }
  };

  pi.on('session_shutdown', () => { // the jobs themselves keep running
    shuttingDown = true; closeOverlay?.(); clearInterval(poll); poll = undefined;
    for (const dir of [...watchers.keys()]) unwatch(dir);
  });

  const stop = async (key: string, ctx: ExtensionContext) => {
    const running = [...watched].flatMap(dir => readJob(dir) ?? []).filter(j => j.state === 'running').sort((a, b) => b.startedAt - a.startedAt);
    const job = running[0];
    if (!job) return ctx.ui.notify('끊을 작업이 없습니다. 이 세션에서 /cl-run으로 시작해 실행 중인 작업에만 보냅니다.', 'info');
    const now = Date.now();
    const count = presses?.dir === job.dir && now - presses.at < ESCALATE_MS ? presses.count + 1 : 1;
    presses = { dir: job.dir, at: now, count };
    const sent = count === 1 ? interruptJob(job) : stopJob(job);
    if (!sent) return ctx.ui.notify(`${job.name}: 실행 중인 프로세스를 찾지 못했습니다.`, 'warning');
    const others = running.length > 1 ? ` (실행 중 ${running.length}개 중 가장 최근)` : '';
    ctx.ui.notify(count === 1 ? `${job.name}에 Ctrl+C를 보냈습니다${others}. 3초 안에 ${key}를 다시 누르면 종료합니다.`
      : count === 2 ? `${job.name}에 종료 신호를 보냈습니다. 다시 누르면 강제 종료합니다.`
      : `${job.name}을(를) 강제 종료합니다.`, 'info');
  };
  for (const key of STOP_KEYS) {
    pi.registerShortcut(key, {
      description: '/cl-run 작업 끊기: 이 세션에서 시작한 가장 최근 작업에 Ctrl+C. 3초 안에 다시 누르면 종료(SIGTERM), 한 번 더 누르면 강제 종료(SIGKILL)',
      handler: ctx => stop(key, ctx),
    });
  }

  pi.registerCommand('cl-run', {
    description: '명령을 옆 pane에서 실행하고 바로 돌아옵니다(! 와 달리 Pi를 붙잡지 않습니다). 끝나면 알리고 종료 코드와 출력 끝부분을 다음 대화에 전달합니다. -s(--silent): 백그라운드 창에서 실행(tmux). -n <이름>: 작업 이름. ? <하고 싶은 일>: 모델이 명령을 추론하고 확인을 받은 뒤 실행. /cl-jobs로 조회합니다.',
    handler: async (args, ctx) => {
      if (ctx.mode !== 'tui') return ctx.ui.notify('명령 실행: Pi 대화형 TUI에서만 사용할 수 있습니다.', 'warning');
      const parsed = parseRunArgs(args);
      if ('error' in parsed) return ctx.ui.notify(`명령 실행: ${parsed.error}`, 'warning');
      const mux = await detectMultiplexer({ exec });
      if (!mux) return ctx.ui.notify(`명령 실행: 터미널 멀티플렉서(${MULTIPLEXER_NAMES}) 안에서 실행해주세요.`, 'warning');
      if (parsed.silent && !mux.openBackground) return ctx.ui.notify(`명령 실행: --silent(백그라운드 창)는 tmux에서만 됩니다. ${mux.name}에서는 옵션 없이 옆 pane으로 실행하세요.`, 'warning');

      let root: string;
      try { root = jobsRoot(); } catch (error) { return ctx.ui.notify(`명령 실행: ${error instanceof Error ? error.message : String(error)}`, 'error'); }
      pruneJobs(root);
      if (parsed.infer) {
        const model = ctx.model;
        if (!model || !ctx.modelRegistry.hasConfiguredAuth(model)) return ctx.ui.notify('명령 실행: 명령을 추론할 모델이 없습니다. 모델을 고르거나 명령을 직접 적어주세요.', 'warning');
        ctx.ui.notify(`명령 추론 중: ${parsed.command}`, 'info');
        try {
          const result = await inferCommand(parsed.command, inferContext(ctx.cwd, listJobs(root).filter(j => j.cwd === ctx.cwd).map(j => j.command)), {
            complete: async (systemPrompt, text) => {
              const reply = await ctx.modelRegistry.complete(model, { systemPrompt, messages: [{ role: 'user', content: [{ type: 'text', text }], timestamp: Date.now() }] });
              if (reply.stopReason === 'error' || reply.stopReason === 'aborted') throw new Error(reply.errorMessage || '모델 요청이 실패했습니다.');
              return reply.content.flatMap(c => c.type === 'text' ? c.text : []).join('');
            },
            confirm: (title, command) => ctx.ui.editor(title, command),
          });
          if ('cancelled' in result) return ctx.ui.notify('명령 실행: 취소했습니다.', 'info');
          if ('error' in result) return ctx.ui.notify(`명령 추론: ${result.error}`, 'warning');
          parsed.command = result.command;
        } catch (error) {
          return ctx.ui.notify(`명령 추론: ${error instanceof Error ? error.message : String(error)}`, 'error');
        }
      }
      // Read now, not before the model and the confirmation: another Pi may have started a job meanwhile.
      const jobs = listJobs(root);
      const same = parsed.name ? jobs.find(j => j.name === parsed.name) : undefined;
      if (same?.state === 'running') return ctx.ui.notify(`명령 실행: ${same.name}이(가) 아직 실행 중입니다. 다른 이름을 쓰거나 /cl-jobs에서 중지하세요.`, 'warning');
      if (same) {
        if (watched.has(same.dir)) check(); // its result goes to the conversation before its record is replaced
        fs.rmSync(same.dir, { recursive: true, force: true }); // a named job run again replaces its last run
      }
      const name = parsed.name ?? jobName(parsed.command, new Set(jobs.map(j => j.name)));
      let dir: string;
      try { dir = createJob(root, { name, command: parsed.command, cwd: ctx.cwd, startedAt: Date.now(), silent: parsed.silent, pane: null }); }
      catch { return ctx.ui.notify(`명령 실행: ${name} 이름을 방금 다른 작업이 가져갔습니다. 다시 실행해주세요.`, 'warning'); }
      try {
        const command = [process.execPath, runner, dir], label = `cl-run ${name}`;
        const { paneId } = parsed.silent ? await mux.openBackground!(exec, { command, cwd: ctx.cwd, label })
          : await mux.openSide(exec, { command, cwd: ctx.cwd, label, ratio: 40, focus: false });
        if (paneId) setJobPane(dir, { ...mux.self, pane: paneId });
      } catch (error) {
        fs.rmSync(dir, { recursive: true, force: true });
        return ctx.ui.notify(`명령 실행: ${error instanceof Error ? error.message : String(error)}`, 'error');
      }
      lastCtx = ctx;
      watched.add(dir);
      try { watchers.set(dir, fs.watch(dir, (_event, file) => { if (!file || file === EXIT_FILE) check(); })); } catch { /* the poll covers it */ }
      poll ??= setInterval(check, 1000);
      ctx.ui.notify(`${name} 시작${parsed.silent ? '(백그라운드 창)' : ''}: ${parsed.command}`, 'info');
    },
  });

  /** The job's pane, when this Pi can reach it: same multiplexer and session. */
  const reachable = (mux: Multiplexer | null, job: Job) =>
    mux && job.state === 'running' && job.pane?.multiplexer === mux.id && job.pane.session === mux.self.session ? job.pane.pane : null;

  pi.registerCommand('cl-jobs', {
    description: '/cl-run으로 시작한 작업의 상태(실행 중·종료 코드·경과 시간)와 출력을 봅니다. 고르면 출력을 대화에 전달하거나, pane으로 이동하거나, 중지·삭제합니다.',
    handler: async (_args, ctx) => {
      if (picking) return ctx.ui.notify('이미 작업 목록이 열려 있습니다.', 'warning');
      const problem = preflight(ctx, ['fzf']);
      if (problem) return ctx.ui.notify(`작업 목록: ${problem}`, 'warning');
      let jobs: Job[];
      try { jobs = listJobs(jobsRoot()); } catch (error) { return ctx.ui.notify(`작업 목록: ${error instanceof Error ? error.message : String(error)}`, 'error'); }
      if (!jobs.length) return ctx.ui.notify('작업이 없습니다. /cl-run <명령>으로 시작하세요.', 'info');

      picking = true;
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'calliopi-jobs-pick-'));
      let job: Job | null = null;
      try {
        fs.writeFileSync(path.join(directory, JOB_LIST), `${jobs.map(j => j.dir).join('\0')}\0`, { mode: 0o600 });
        const width = Math.max(...jobs.map(j => j.name.length));
        const result = await openOverlaySession<number | null>(ctx, {
          cwd: ctx.cwd, title: ' Calliopi · 작업 ', footer: ' Enter: 선택 · Esc: 닫기 ',
          blocked: { kind: 'question', message: '작업 선택 중' },
          isShuttingDown: () => shuttingDown, setClose: fn => { closeOverlay = fn; },
          flow: ({ run, cancelled }) => runWorkflow<number>({
            name: 'jobs', prompt: 'Job > ', preview: nodePreview(preview, directory), previewWindow: 'right:60%:wrap:~2',
            items: jobs.map(j => cleanDisplay(`${j.name.padEnd(width)}  ${statusText(j)}  ${j.command}`)),
            header: 'Enter: 전달·이동·중지·삭제 · Esc: 닫기',
            onSelect: ({ index }) => ({ done: index }),
          }, { run, directory, cancelled }),
        });
        if (result && typeof result === 'object') throw new Error(result.error);
        job = result === null ? null : readJob(jobs[result]!.dir); // its state may have changed while the list was open
      } catch (error) {
        if (!shuttingDown) ctx.ui.notify(`작업 목록: ${error instanceof Error ? error.message : String(error)}`, 'error');
      } finally {
        closeOverlay?.(); closeOverlay = undefined;
        fs.rmSync(directory, { recursive: true, force: true });
        picking = false;
      }
      if (!job || shuttingDown) return;

      const mux = await detectMultiplexer({ exec });
      const pane = reachable(mux, job);
      const running = job.state === 'running';
      const action = await ctx.ui.select(`${job.name} · ${statusText(job)}`, [
        SHARE, ...(pane && mux?.capture ? [SCREEN] : []), ...(pane && mux?.focus ? [FOCUS] : []), running ? STOP : REMOVE,
      ]);
      try {
        if (action === SHARE) {
          share(job);
          ctx.ui.notify(`${job.name} 출력을 다음 대화에 전달합니다.`, 'info');
        } else if (action === SCREEN) {
          const screen = plainLog(await mux!.capture!(exec, pane!)).replace(/\n+$/, '');
          share(job, `The user shared what the /cl-run job "${job.name}" (${job.command}) shows on screen right now. This is context, not a request by itself.\n\n<screen>\n${screen}\n</screen>`);
          ctx.ui.notify(`${job.name} 화면을 다음 대화에 전달합니다.`, 'info');
        } else if (action === FOCUS) {
          await mux!.focus!(exec, pane!);
        } else if ((action === STOP || action === REMOVE) && !sameRun(job)) {
          // The menu was open for a while: the name may belong to a newer run now, which is not the one chosen.
          ctx.ui.notify(`${job.name}: 고른 뒤에 작업이 바뀌었습니다. /cl-jobs를 다시 열어주세요.`, 'warning');
        } else if (action === STOP) {
          ctx.ui.notify(stopJob(job) ? `${job.name}에 종료 신호를 보냈습니다.` : `${job.name}: 실행 중인 프로세스를 찾지 못했습니다.`, 'info');
        } else if (action === REMOVE) {
          fs.rmSync(job.dir, { recursive: true, force: true });
          ctx.ui.notify(`${job.name} 기록을 삭제했습니다.`, 'info');
        }
      } catch (error) {
        ctx.ui.notify(`작업 목록: ${error instanceof Error ? error.message : String(error)}`, 'error');
      }
    },
  });
}
