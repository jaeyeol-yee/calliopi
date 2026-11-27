// One benchmark run: a fresh copy of the task's fixture, `pi -p` with the arm's model and effort in it,
// the oracle on what is left, and counts from the Pi session. Nothing here grades with a model.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isFaux, type PlannedRun } from './spec.ts';
import { changedFiles, runOracle, snapshot, type CheckResult } from './task.ts';

export const ROOT = path.resolve(import.meta.dirname, '..', '..');
const FAUX = path.join(ROOT, 'bench', 'faux-extension.ts');

export interface RunSignals {
  turns: number;
  toolCalls: Record<string, number>;
  toolErrors: number;
  /** Model calls that made more than one tool call. */
  parallelCalls: number;
  input: number; output: number; cacheRead: number; cacheWrite: number;
  /** Dollars, as Pi priced each response. */
  cost: number;
  stopReason?: string;
}

export interface RunRecord {
  spec: string;
  arm: string;
  model: string;
  effort: string;
  harness: 'on' | 'off';
  task: string;
  taskClass: string;
  taskVersion: number;
  rep: number;
  piVersion: string;
  harnessSha: string;
  at: string;
  ms: number;
  exit: number | null;
  timedOut: boolean;
  pass: boolean;
  checks: CheckResult[];
  changed: string[];
  outOfScope: string[];
  signals: RunSignals;
  answer: string;
}

export function sessionSignals(file: string | undefined): RunSignals {
  const s: RunSignals = { turns: 0, toolCalls: {}, toolErrors: 0, parallelCalls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  if (!file) return s;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    let entry: { type?: string; message?: any };
    try { entry = JSON.parse(line); } catch { continue; }
    const m = entry.message;
    if (entry.type !== 'message' || !m) continue;
    if (m.role === 'toolResult' && m.isError) s.toolErrors++;
    if (m.role !== 'assistant') continue;
    s.turns++;
    const u = m.usage ?? {};
    s.input += u.input ?? 0; s.output += u.output ?? 0; s.cacheRead += u.cacheRead ?? 0; s.cacheWrite += u.cacheWrite ?? 0;
    s.cost += u.cost?.total ?? 0;
    s.stopReason = m.stopReason;
    const calls = (Array.isArray(m.content) ? m.content : []).filter((b: any) => b?.type === 'toolCall');
    if (calls.length > 1) s.parallelCalls++;
    for (const c of calls) s.toolCalls[c.name] = (s.toolCalls[c.name] ?? 0) + 1;
  }
  return s;
}

/** Which Pi runs an arm: faux arms use this repository's dev dependency, whose pi-ai the faux extension imports; real models use the installed Pi. */
export interface PiBinary { command: string; version: string }
export interface RunContext { spec: string; harnessSha: string; outDir: string; timeoutMinutes: number; pi: (run: PlannedRun) => PiBinary }

export function piArgs(run: PlannedRun, sessionDir: string): string[] {
  const { arm, task } = run;
  return [
    '-p', '--offline',
    '--no-extensions', '--no-skills', '--no-context-files', '--no-prompt-templates', '--no-mcp', '--no-approve',
    '--session-dir', sessionDir,
    ...(arm.harness === 'on' ? ['-e', ROOT] : []),
    ...(isFaux(arm.model) ? ['-e', FAUX] : []),
    '--model', arm.model, '--thinking', arm.effort,
    task.prompt,
  ];
}

export function runOne(run: PlannedRun, ctx: RunContext): RunRecord {
  const { arm, task, rep } = run;
  const dir = path.join(ctx.outDir, 'runs', `${arm.id}`, task.id.replace('/', '__'), `rep${rep}`);
  fs.rmSync(dir, { recursive: true, force: true });
  const sessions = path.join(dir, 'session');
  fs.mkdirSync(sessions, { recursive: true });
  // Outside the repository: the run must not see Calliopi's git history, package.json or files.
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'calliopi-bench-'));
  fs.cpSync(task.fixture, work, { recursive: true });
  spawnSync('git', ['init', '-q'], { cwd: work });
  spawnSync('git', ['add', '-A'], { cwd: work });
  spawnSync('git', ['-c', 'user.name=bench', '-c', 'user.email=bench@localhost', 'commit', '-qm', 'fixture'], { cwd: work });
  const before = snapshot(work);
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.CALLIOPI_AGENT_DIR; // never run as somebody's subagent
  if (isFaux(arm.model)) {
    const script = path.join(dir, 'faux.json');
    fs.writeFileSync(script, JSON.stringify(arm.faux ?? task.faux ?? []));
    env.BENCH_FAUX = script;
  }
  const started = Date.now();
  const pi = ctx.pi(run);
  const r = spawnSync(pi.command, piArgs(run, sessions), { cwd: work, env, encoding: 'utf8', timeout: ctx.timeoutMinutes * 60_000, maxBuffer: 64 << 20 });
  const ms = Date.now() - started;
  const answer = r.stdout ?? '';
  fs.writeFileSync(path.join(dir, 'answer.txt'), answer);
  fs.writeFileSync(path.join(dir, 'stderr.txt'), r.stderr ?? '');
  const sessionFile = fs.readdirSync(sessions).filter(n => n.endsWith('.jsonl')).map(n => path.join(sessions, n)).at(0);
  const checks = runOracle(task, work, answer, before);
  const changed = changedFiles(before, snapshot(work));
  const timedOut = (r.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT';
  // Keep what the run left for reading later, then drop the temporary copy.
  fs.cpSync(work, path.join(dir, 'work'), { recursive: true, filter: src => !src.split(path.sep).includes('.git') });
  fs.rmSync(work, { recursive: true, force: true });
  return {
    spec: ctx.spec, arm: arm.id, model: arm.model, effort: arm.effort, harness: arm.harness,
    task: task.id, taskClass: task.class, taskVersion: task.version, rep,
    piVersion: pi.version, harnessSha: ctx.harnessSha, at: new Date(started).toISOString(), ms,
    exit: r.status, timedOut, pass: !timedOut && checks.every(c => c.pass), checks, changed,
    outOfScope: task.scope.length ? changed.filter(f => !task.scope.includes(f)) : [],
    signals: sessionSignals(sessionFile), answer: answer.slice(-2000),
  };
}
