// One benchmark run: a fresh copy of the task's fixture, `pi -p` with the arm's model and effort in it,
// the oracle on what is left, and counts from the Pi session. Nothing here grades with a model.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listAgents, sessionFile, treeDir } from '@calliopi/core/agents';
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
export interface RunContext {
  spec: string; harnessSha: string; outDir: string; timeoutMinutes: number; pi: (run: PlannedRun) => PiBinary;
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
  const at = arm.harnessRef ? ctx.harnessAt?.(arm.harnessRef) : undefined;
  if (arm.harnessRef && !at) throw new Error(`${arm.id}: no checkout for harnessRef ${arm.harnessRef}`);
  const r = spawnSync(pi.command, piArgs(run, sessions, at?.dir), { cwd: work, env, encoding: 'utf8', timeout: ctx.timeoutMinutes * 60_000, maxBuffer: 64 << 20 });
  const ms = Date.now() - started;
  const answer = r.stdout ?? '';
  fs.writeFileSync(path.join(dir, 'answer.txt'), answer);
  fs.writeFileSync(path.join(dir, 'stderr.txt'), r.stderr ?? '');
  const session = fs.readdirSync(sessions).filter(n => n.endsWith('.jsonl')).map(n => path.join(sessions, n)).at(0);
  const checks = runOracle(task, work, answer, before);
  const changed = changedFiles(before, snapshot(work));
  const timedOut = (r.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT';
  // Keep what the run left for reading later, then drop the temporary copy.
  fs.cpSync(work, path.join(dir, 'work'), { recursive: true, filter: src => !src.split(path.sep).includes('.git') });
  fs.rmSync(work, { recursive: true, force: true });
  return {
    spec: ctx.spec, arm: arm.id, model: arm.model, effort: arm.effort, harness: arm.harness,
    ...(arm.harness === 'on' ? { harnessCommit: at?.commit ?? ctx.harnessSha } : {}),
    task: task.id, taskClass: task.class, taskVersion: task.version, rep,
    piVersion: pi.version, harnessSha: ctx.harnessSha, at: new Date(started).toISOString(), ms,
    exit: r.status, timedOut, pass: !timedOut && checks.every(c => c.pass), checks, changed,
    outOfScope: task.scope.length ? changed.filter(f => !task.scope.includes(f)) : [],
    signals: sessionSignals(session), children: collectChildren(session, dir, env), answer: answer.slice(-2000),
  };
}
