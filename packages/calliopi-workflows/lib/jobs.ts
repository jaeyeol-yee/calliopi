// /cl-run jobs: a command the user starts in a multiplexer pane, so Pi stays free while it runs.
// A job is a private directory: meta.json (what and where), log (everything the program printed),
// pid (the runner, bin/job-runner.ts) and exit (the exit code; present once the command has ended).
// Nothing here asks the multiplexer anything, so a job is found by name whatever pane it is in.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { PaneRef } from '@calliopi/core/multiplexer';
import { stripAnsi } from '#lib/preview-render.ts';

export interface JobMeta {
  name: string;
  /** The command line, exactly as the user wrote it; run by their shell. */
  command: string;
  cwd: string;
  startedAt: number;
  /** Runs in a background window and closes when done, instead of beside Pi. */
  silent: boolean;
  /** Where it runs; null when the multiplexer did not report a pane id. */
  pane: PaneRef | null;
}

export type JobState = 'running' | 'exited' | 'lost';

export interface Job extends JobMeta {
  dir: string;
  state: JobState;
  /** Set when state is 'exited'. */
  exitCode?: number;
  endedAt?: number;
}

export const META_FILE = 'meta.json', LOG_FILE = 'log', PID_FILE = 'pid', EXIT_FILE = 'exit';
/** In the picker's private directory: the listed job directories, NUL-separated, for bin/job-preview.ts. */
export const JOB_LIST = 'jobs';
export const TAIL_LINES = 40, TAIL_BYTES = 64 * 1024;
/** Finished jobs older than this are removed when a new one starts. */
export const KEEP_MS = 24 * 60 * 60 * 1000;

/**
 * Per-user root (0700): jobs outlive the Pi process that started them. The temp directory may be
 * shared (/tmp), where anyone can create this path first and then swap a job's command under us,
 * so a root that is not a private directory of this user is refused.
 */
export function jobsRoot(base = os.tmpdir()): string {
  const uid = os.userInfo().uid;
  const root = path.join(base, `calliopi-jobs-${uid}`);
  try { fs.mkdirSync(root, { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  const stat = fs.lstatSync(root);
  if (!stat.isDirectory() || stat.uid !== uid || (stat.mode & 0o077) !== 0) {
    throw new Error(`${root}이(가) 내 전용 디렉터리가 아닙니다(다른 사용자 소유, 링크, 또는 열린 권한). 확인하고 지운 뒤 다시 실행하세요.`);
  }
  return root;
}

export interface RunArgs {
  /** The command line; with `infer`, what the user wants in their own words instead. */
  command: string;
  silent: boolean;
  name?: string;
  /** `? <words>`: a model writes the command and the user confirms it (lib/job-infer.ts). */
  infer: boolean;
}

/** `[-s|--silent] [-n <name>|--name=<name>] <command>` or `… ? <words>`: flags only before the command, which is kept verbatim. */
export function parseRunArgs(args: string): RunArgs | { error: string } {
  let rest = args.trimStart(), silent = false, name: string | undefined;
  for (;;) {
    const m = /^(?:(-s|--silent)|(?:-n\s+|--name=)(\S+))(?:\s+|$)/.exec(rest);
    if (!m) break;
    if (m[1]) silent = true; else name = m[2];
    rest = rest.slice(m[0].length);
  }
  // `--` ends the flags, so a command may itself start with ? (a glob) or -.
  const literal = rest.startsWith('-- ');
  if (literal) rest = rest.slice(3).trimStart();
  if (!literal && /^\?{2,}(\s|$)/.test(rest)) return { error: '추론은 ? 하나만 씁니다. ??로 시작하는 명령을 그대로 실행하려면 -- 뒤에 적어주세요.' };
  const infer = !literal && /^\?(\s|$)/.test(rest);
  if (infer) rest = rest.slice(1).trimStart();
  if (name !== undefined && !/^[\w.-]{1,40}$/.test(name)) return { error: '이름은 영문·숫자·._- 40자까지입니다.' };
  if (!rest.trim()) return { error: infer ? '무엇을 실행할지 적어주세요. 예: /cl-run ? 테스트 돌려줘' : '실행할 명령을 적어주세요. 예: /cl-run npm test' };
  return { command: rest.trimEnd(), silent, name, infer };
}

/** A name from the command's first two words ("npm test" → npm-test), numbered when taken. */
export function jobName(command: string, taken: ReadonlySet<string>): string {
  const words = command.trim().split(/\s+/).filter(w => !/^\w+=/.test(w)).slice(0, 2).map(w => path.basename(w).replace(/[^\w.-]+/g, ''));
  const base = words.filter(Boolean).join('-').slice(0, 32) || 'job';
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}

const writeAtomic = (file: string, text: string) => {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.renameSync(tmp, file);
};

export function createJob(root: string, meta: JobMeta): string {
  const dir = path.join(root, meta.name);
  fs.mkdirSync(dir, { mode: 0o700 }); // throws when the name is taken
  writeAtomic(path.join(dir, META_FILE), JSON.stringify(meta));
  return dir;
}

export const setJobPane = (dir: string, pane: PaneRef | null) =>
  writeAtomic(path.join(dir, META_FILE), JSON.stringify({ ...(JSON.parse(fs.readFileSync(path.join(dir, META_FILE), 'utf8')) as JobMeta), pane }));

export const writeExit = (dir: string, code: number) => writeAtomic(path.join(dir, EXIT_FILE), `${code}\n`);

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/** The runner writes its pid when it starts; until then a young job counts as running. */
const STARTING_MS = 10_000;

export function readJob(dir: string, now = Date.now()): Job | null {
  let meta: JobMeta;
  try { meta = JSON.parse(fs.readFileSync(path.join(dir, META_FILE), 'utf8')) as JobMeta; } catch { return null; }
  const exited = (): Job | null => {
    try {
      const file = path.join(dir, EXIT_FILE);
      const exitCode = Number(fs.readFileSync(file, 'utf8'));
      return { ...meta, dir, state: 'exited', exitCode, endedAt: fs.statSync(file).mtimeMs };
    } catch { return null; }
  };
  const done = exited();
  if (done) return done;
  let pid: number | null = null;
  try { pid = Number(fs.readFileSync(path.join(dir, PID_FILE), 'utf8')); } catch { /* not started yet */ }
  if (pid ? alive(pid) : now - meta.startedAt < STARTING_MS) return { ...meta, dir, state: 'running' };
  // The runner writes the exit code and then exits: it may have done both since the first look.
  return exited() ?? { ...meta, dir, state: 'lost' };
}

/** Whether `job` is still the run in its directory: a name can be taken again by a later run. */
export const sameRun = (job: Job): boolean => readJob(job.dir)?.startedAt === job.startedAt;

/** Newest first. */
export function listJobs(root: string, now = Date.now()): Job[] {
  let names: string[];
  try { names = fs.readdirSync(root); } catch { return []; }
  return names.flatMap(n => readJob(path.join(root, n), now) ?? []).sort((a, b) => b.startedAt - a.startedAt);
}

export function pruneJobs(root: string, now = Date.now()): void {
  for (const job of listJobs(root, now)) {
    if (job.state !== 'running' && now - (job.endedAt ?? job.startedAt) > KEEP_MS) fs.rmSync(job.dir, { recursive: true, force: true });
  }
}

const signalRunner = (job: Job, signal: NodeJS.Signals) => {
  try { process.kill(Number(fs.readFileSync(path.join(job.dir, PID_FILE), 'utf8')), signal); return true; }
  catch { return false; }
};

/** Ask the runner to end the command: SIGHUP to it, and the whole process group when asked again. False when there is nothing to signal. */
export const stopJob = (job: Job): boolean => signalRunner(job, 'SIGTERM');

/** Ctrl+C, as if typed in the pane: the runner writes it to the command's terminal, which interrupts its foreground process group. */
export const interruptJob = (job: Job): boolean => signalRunner(job, 'SIGINT');

/** Terminal output as the text a reader would have seen: no escapes, and a line redrawn with \r keeps its last version. */
export function plainLog(raw: string): string {
  return stripAnsi(raw).replace(/\r\n/g, '\n').split('\n')
    .map(line => line.replace(/\r+$/, '').split('\r').at(-1)!.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').trimEnd())
    .join('\n');
}

/** The last `lines` lines of the log (reading at most the last `bytes`). */
export function tailLog(dir: string, lines = TAIL_LINES, bytes = TAIL_BYTES): { text: string; truncated: boolean } {
  let raw: Buffer;
  try {
    const file = path.join(dir, LOG_FILE);
    const size = fs.statSync(file).size, start = Math.max(0, size - bytes);
    raw = Buffer.alloc(size - start);
    const fd = fs.openSync(file, 'r');
    try { fs.readSync(fd, raw, 0, raw.length, start); } finally { fs.closeSync(fd); }
    const all = plainLog(raw.toString('utf8')).replace(/\n+$/, '').split('\n');
    if (start > 0) all.shift(); // the first line may be cut mid-way
    return { text: all.slice(-lines).join('\n'), truncated: start > 0 || all.length > lines };
  } catch { return { text: '', truncated: false }; }
}

export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}초`;
  if (s < 3600) return `${Math.floor(s / 60)}분 ${s % 60}초`;
  return `${Math.floor(s / 3600)}시간 ${Math.floor((s % 3600) / 60)}분`;
}

export function statusText(job: Job, now = Date.now()): string {
  if (job.state === 'running') return `실행 중 ${formatElapsed(now - job.startedAt)}`;
  if (job.state === 'lost') return '중단됨(종료 코드 없음)';
  return `종료 ${job.exitCode} · ${formatElapsed((job.endedAt ?? now) - job.startedAt)}`;
}

/** What the model is told about a job: its state and the end of its output. */
export function jobMessage(job: Job, now = Date.now()): string {
  const state = job.state === 'running' ? `is still running after ${formatElapsed(now - job.startedAt)}`
    : job.state === 'lost' ? 'ended without an exit code (its pane was probably closed)'
    : `exited with code ${job.exitCode} after ${formatElapsed((job.endedAt ?? now) - job.startedAt)}`;
  const intro = `The user ran a command with /cl-run (job "${job.name}", in ${job.cwd}); it ${state}. This is context, not a request by itself.`;
  const { text, truncated } = tailLog(job.dir);
  const command = `<command>\n${job.command}\n</command>`;
  if (!text) return `${intro}\n\n${command}\n\nIt printed nothing${job.state === 'running' ? ' so far' : ''}.`;
  return `${intro}\n\n${command}\n\n<output${truncated ? ` last-lines="${TAIL_LINES}"` : ''}>\n${text}\n</output>${truncated ? `\nEarlier output is in ${path.join(job.dir, LOG_FILE)} (raw terminal output).` : ''}`;
}
