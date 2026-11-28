// One benchmark run: a fresh copy of the task's fixture, `pi -p` with the arm's model and effort in it,
// the oracle on what is left (a pass or fail per dimension), and counts from the Pi session. Nothing here grades with a model.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listAgents, sessionFile, treeDir } from '@calliopi/core/agents';
import { isFaux, type PlannedRun } from './spec.ts';
import { runOracle, snapshot, taskGroup, type CheckResult, type ContentSize, type Dimension } from './task.ts';

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
  /** The provider's message when the last response ended in an error. */
  errorMessage?: string;
}

/** Subagents a run started: their work and cost belong to the run. */
export interface Children {
  count: number;
  cost: number;
  turns: number;
  /** End status → count; children cut off when `pi -p` exited show as stopped. */
  ends: Record<string, number>;
}

export interface RunRecord {
  spec: string;
  arm: string;
  model: string;
  effort: string;
  harness: 'on' | 'off';
  /** The Calliopi commit the run loaded (the working tree's, or its arm's harnessRef). */
  harnessCommit?: string;
  /** Runs at once in the invocation (1 when absent). */
  concurrency?: number;
  task: string;
  /** The task's class, or <class>-hard for a hard task. */
  taskClass: string;
  taskVersion: number;
  rep: number;
  piVersion: string;
  harnessSha: string;
  at: string;
  ms: number;
  exit: number | null;
  timedOut: boolean;
  /** Strict pass: every dimension that applies to the task passed, and the run did not time out. */
  pass: boolean;
  /** Pass per dimension. Absent in records from before dimensions, whose `pass` was the outcome alone. */
  dimensions?: Partial<Record<Dimension, boolean>>;
  /** Precision on review tasks: cited findings that are no bug. */
  extraFindings?: number;
  /** The answer's words, and those in blocks the task neither needs nor allows. */
  content?: ContentSize;
  /** The run ended on a provider error (limit, outage): it says nothing about the model or the task. */
  error?: string;
  checks: CheckResult[];
  changed: string[];
  outOfScope: string[];
  signals: RunSignals;
  children: Children;
  answer: string;
}

/** What a run cost with its subagents. */
export const runCost = (r: RunRecord) => r.signals.cost + (r.children?.cost ?? 0);

const agentDir = (env: NodeJS.ProcessEnv) => env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), '.pi', 'agent');

/** The subagents of the run whose Pi session is `session`: counted, then moved from the user's registry into the run's directory. */
export function collectChildren(session: string | undefined, into: string, env: NodeJS.ProcessEnv = process.env): Children {
  const out: Children = { count: 0, cost: 0, turns: 0, ends: {} };
  const id = session && path.basename(session, '.jsonl').split('_').at(-1);
  if (!id) return out;
  const tree = treeDir(path.join(agentDir(env), 'calliopi-agents'), id);
  for (const child of listAgents(path.dirname(tree), path.basename(tree))) {
    out.count++;
    const end = child.result?.status ?? child.status?.state ?? 'starting';
    out.ends[end] = (out.ends[end] ?? 0) + 1;
    const s = fs.existsSync(sessionFile(child)) ? sessionSignals(sessionFile(child)) : undefined;
    out.cost += s?.cost ?? 0; out.turns += s?.turns ?? 0;
  }
  if (out.count && fs.existsSync(tree)) {
    fs.cpSync(tree, path.join(into, 'agents'), { recursive: true });
    fs.rmSync(tree, { recursive: true, force: true });
  }
  return out;
}

/** The provider error a run ended on, if it did. */
export const providerError = (s: RunSignals) => (s.stopReason === 'error' ? s.errorMessage ?? 'error' : undefined);

/** Errors that will repeat for the rest of the spec: a spent subscription or quota. */
export const EXHAUSTED = /usage limit|quota|insufficient_quota|billing|credit balance/i;

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
    s.errorMessage = m.stopReason === 'error' ? String(m.errorMessage ?? 'error') : undefined;
    const calls = (Array.isArray(m.content) ? m.content : []).filter((b: any) => b?.type === 'toolCall');
    if (calls.length > 1) s.parallelCalls++;
    for (const c of calls) s.toolCalls[c.name] = (s.toolCalls[c.name] ?? 0) + 1;
  }
  return s;
}

/** Which Pi runs an arm: faux arms use this repository's dev dependency, whose pi-ai the faux extension imports; real models use the installed Pi. */
export interface PiBinary { command: string; version: string }
export interface RunContext {
  spec: string; harnessSha: string; outDir: string; timeoutMinutes: number; pi: (run: PlannedRun) => PiBinary;
  /** Runs at once when this one ran: timings of concurrent runs are not comparable with sequential ones. */
  concurrency?: number;
  /** Where Calliopi as of a ref is checked out, and its commit. */
  harnessAt?: (ref: string) => { dir: string; commit: string };
}

/** A worktree of Calliopi at `ref` with its dependencies installed, made once per commit under `base`. */
export function harnessWorktree(ref: string, base: string): { dir: string; commit: string } {
  const git = (args: string[], cwd = ROOT) => { const r = spawnSync('git', args, { cwd, encoding: 'utf8' }); if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.trim()}`); return r.stdout.trim(); };
  const commit = git(['rev-parse', '--short=12', `${ref}^{commit}`]);
  const dir = path.join(base, commit);
  if (!fs.existsSync(path.join(dir, 'node_modules'))) {
    fs.rmSync(dir, { recursive: true, force: true });
    spawnSync('git', ['worktree', 'prune'], { cwd: ROOT });
    git(['worktree', 'add', '--detach', dir, commit]);
    const ci = spawnSync('npm', ['ci', '--prefer-offline', '--no-audit', '--no-fund', '--ignore-scripts'], { cwd: dir, encoding: 'utf8' });
    if (ci.status !== 0) throw new Error(`npm ci in ${dir}: ${ci.stderr.trim().split('\n').slice(-3).join(' | ')}`);
  }
  return { dir, commit };
}

export function piArgs(run: PlannedRun, sessionDir: string, harnessDir = ROOT): string[] {
  const { arm, task } = run;
  return [
    '-p', '--offline',
    '--no-extensions', '--no-skills', '--no-context-files', '--no-prompt-templates', '--no-mcp', '--no-approve',
    '--session-dir', sessionDir,
    ...(arm.harness === 'on' ? ['-e', harnessDir] : []),
    ...(isFaux(arm.model) ? ['-e', FAUX] : []),
    '--model', arm.model, '--thinking', arm.effort,
    task.prompt,
  ];
}

export interface ProcessResult { status: number | null; stdout: string; stderr: string; timedOut: boolean }

/** Runs a process without blocking the event loop (other runs go on meanwhile); TERM at the timeout, KILL 10 seconds later. */
export function runProcess(command: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number }): Promise<ProcessResult> {
  return new Promise(resolve => {
    const child = spawn(command, args, { cwd: opts.cwd, env: opts.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', timedOut = false, kill: NodeJS.Timeout | undefined;
    child.stdout.setEncoding('utf8').on('data', (d: string) => { stdout += d; });
    child.stderr.setEncoding('utf8').on('data', (d: string) => { stderr += d; });
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); kill = setTimeout(() => child.kill('SIGKILL'), 10_000); }, opts.timeoutMs);
    const done = (status: number | null) => { clearTimeout(timer); if (kill) clearTimeout(kill); resolve({ status, stdout, stderr, timedOut }); };
    child.on('error', error => { stderr += String(error); done(null); });
    child.on('close', code => done(code));
  });
}

export async function runOne(run: PlannedRun, ctx: RunContext): Promise<RunRecord> {
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
  const at = arm.harnessRef ? ctx.harnessAt?.(arm.harnessRef) : undefined;
  if (arm.harnessRef && !at) throw new Error(`${arm.id}: no checkout for harnessRef ${arm.harnessRef}`);
  const r = await runProcess(pi.command, piArgs(run, sessions, at?.dir), { cwd: work, env, timeoutMs: ctx.timeoutMinutes * 60_000 });
  const ms = Date.now() - started;
  const answer = r.stdout ?? '';
  fs.writeFileSync(path.join(dir, 'answer.txt'), answer);
  fs.writeFileSync(path.join(dir, 'stderr.txt'), r.stderr ?? '');
  const session = fs.readdirSync(sessions).filter(n => n.endsWith('.jsonl')).map(n => path.join(sessions, n)).at(0);
  const grade = runOracle(task, work, answer, before);
  const signals = sessionSignals(session);
  const timedOut = r.timedOut;
  // Keep what the run left for reading later, then drop the temporary copy.
  fs.cpSync(work, path.join(dir, 'work'), { recursive: true, filter: src => !src.split(path.sep).includes('.git') });
  fs.rmSync(work, { recursive: true, force: true });
  return {
    spec: ctx.spec, arm: arm.id, model: arm.model, effort: arm.effort, harness: arm.harness,
    ...(arm.harness === 'on' ? { harnessCommit: at?.commit ?? ctx.harnessSha } : {}),
    ...((ctx.concurrency ?? 1) > 1 ? { concurrency: ctx.concurrency } : {}),
    task: task.id, taskClass: taskGroup(task), taskVersion: task.version, rep,
    piVersion: pi.version, harnessSha: ctx.harnessSha, at: new Date(started).toISOString(), ms,
    exit: r.status, timedOut, pass: !timedOut && grade.pass, dimensions: grade.dimensions, ...(grade.extraFindings !== undefined ? { extraFindings: grade.extraFindings } : {}), ...(grade.content ? { content: grade.content } : {}),
    ...(providerError(signals) ? { error: providerError(signals) } : {}), checks: grade.checks, changed: grade.changed, outOfScope: grade.outOfScope,
    signals, children: collectChildren(session, dir, env), answer: answer.slice(-2000),
  };
}
