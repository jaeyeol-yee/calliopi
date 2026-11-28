// Calliopi's model benchmark.
//
//   npm run bench -- bench/specs/<name>.yaml --dry-run   check the spec and list the planned runs
//   npm run bench -- bench/specs/<name>.yaml             run them (real models cost money)
//   npm run bench -- bench/specs/<name>.yaml --jobs 4    up to 4 at once (the spec's concurrency otherwise)
//   npm run bench -- bench/specs/<name>.yaml --minutes 25  start no run after 25 minutes (the ones going finish)
//   npm run bench -- bench/specs/<name>.yaml --provider openai   only arms of these providers (comma-separated)
//   npm run bench -- bench/specs/<name>.yaml --optional          include arms marked optional (costly flagships)
//   npm run bench -- bench/specs/<name>.yaml --model opus,sonnet --effort low,xhigh --task review,search/unused-flags
//                                                            only those arms and tasks (a task is an id or a class)
//   npm run bench -- bench/specs/<name>.yaml --runs 10 --budget 60   repetitions and dollars instead of the spec's
//   npm run bench -- --report bench/.out/<name>          report from recorded runs
//
// Each run copies a task's fixture, runs `pi -p` with the arm's model and effort in it, applies the
// task's deterministic oracle and appends a record to bench/.out/<spec>/runs.jsonl. Records carry the
// Pi version, the harness commit and the task version, so results of different setups never mix
// unnoticed; a rerun appends, and the report reads every record.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { loadPi } from './lib/catalog.ts';
import { formatReport } from './lib/report.ts';
import { EXHAUSTED, ROOT, harnessWorktree, runCost, runOne, type PiBinary, type RunRecord } from './lib/run.ts';
import { nextRun, providerOf } from './lib/schedule.ts';
import { checkSpec, isFaux, parseSpec, plan, selectArms, taskList, type PlannedRun } from './lib/spec.ts';
import { loadTasks } from './lib/task.ts';

const OUT = path.join(ROOT, 'bench', '.out');
const readRecords = (dir: string): RunRecord[] => {
  try { return fs.readFileSync(path.join(dir, 'runs.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; }
};

async function main(argv: string[]) {
  const at = argv.indexOf('--report');
  if (at >= 0) {
    const dir = argv[at + 1];
    if (!dir) throw new Error('--report needs a directory');
    const target = Number(argv[argv.indexOf('--target') + 1]) || 0.9;
    console.log(formatReport(readRecords(dir), target));
    return;
  }
  const file = argv.find((a, i) => !a.startsWith('--') && !['--jobs', '--minutes', '--provider', '--model', '--effort', '--task', '--runs', '--budget', '--target', '--report'].includes(argv[i - 1] ?? ''));
  if (!file) throw new Error('usage: npm run bench -- <spec.yaml> [--dry-run] | --report <dir>');
  const list = (flag: string) => {
    const at = argv.indexOf(flag);
    if (at < 0) return undefined;
    if (!argv[at + 1] || argv[at + 1]!.startsWith('--')) throw new Error(`${flag} takes a comma-separated list`);
    return argv[at + 1]!.split(',').map(p => p.trim()).filter(Boolean);
  };
  const number = (flag: string) => {
    const at = argv.indexOf(flag);
    if (at < 0) return undefined;
    const n = Number(argv[at + 1]);
    if (!(n > 0)) throw new Error(`${flag} takes a positive number`);
    return n;
  };
  const providers = list('--provider');
  const parsed = parseSpec(fs.readFileSync(file, 'utf8'));
  const selected = selectArms(parsed, { providers, models: list('--model'), efforts: list('--effort'), optional: argv.includes('--optional') });
  const { left } = selected;
  const taskNames = list('--task'), runsOver = number('--runs'), budgetOver = number('--budget');
  if (runsOver !== undefined && !Number.isInteger(runsOver)) throw new Error('--runs takes a whole number');
  const spec = {
    ...selected.spec,
    ...(taskNames ? { tasks: taskList(taskNames, loadTasks()) } : {}),
    ...(runsOver ? { runs: runsOver } : {}),
    ...(budgetOver ? { budgetUsd: budgetOver } : {}),
  };
  if (left.length) {
    const by = new Map<string, number>();
    for (const l of left) by.set(l.why, (by.get(l.why) ?? 0) + 1);
    console.log(`left out ${left.length} arms: ${[...by].map(([why, n]) => `${n} by ${why}`).join(', ')}`);
  }
  if (!spec.arms.length) throw new Error(`${parsed.name}: no arm left to run${providers ? ` for ${providers.join(', ')}` : ''}`);
  const tasks = loadTasks();
  const pi = await loadPi();
  const problems = checkSpec(spec, pi, tasks);
  const runs = plan(spec, tasks);
  console.log(`${spec.name}: ${spec.arms.length} arms × ${runs.length / spec.arms.length / spec.runs} tasks × ${spec.runs} runs = ${runs.length} runs (Pi ${pi.version})${spec.budgetUsd !== undefined ? ` · budget $${spec.budgetUsd}` : ''}`);
  for (const arm of spec.arms) {
    const m = pi.get(arm.model);
    console.log(`  ${arm.id}: ${arm.model} effort ${arm.effort} harness ${arm.harness}${m ? ` · $${m.cost.input}/$${m.cost.output} per M` : ''}`);
  }
  if (problems.length) { for (const p of problems) console.error(`problem: ${p}`); process.exitCode = 1; return; }
  if (argv.includes('--dry-run')) { for (const r of runs) console.log(`  rep ${r.rep} · ${r.task.id} · ${r.arm.id}`); return; }

  const outDir = path.join(OUT, spec.name);
  fs.mkdirSync(outDir, { recursive: true });
  const dirty = execFileSync('git', ['status', '--porcelain', '--', 'packages'], { cwd: ROOT, encoding: 'utf8' }).trim();
  const harnessSha = execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim() + (dirty ? '-dirty' : '');
  const installed: PiBinary = { command: 'pi', version: pi.version };
  const dev: PiBinary = { command: path.join(ROOT, 'node_modules', '.bin', 'pi'), version: JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules', '@earendil-works', 'pi-coding-agent', 'package.json'), 'utf8')).version };
  if (spec.budgetUsd === undefined && runs.some(r => !isFaux(r.arm.model))) throw new Error(`${spec.name}: real models need budgetUsd in the spec`);
  let spent = 0, skipped = 0;
  /** Providers whose subscription or quota ran out: their remaining runs would only record the same error. */
  const exhausted = new Set<string>();
  // Calliopi as of each harnessRef, checked out once before any run (a bad ref fails here, not mid-way).
  const refs = new Map<string, { dir: string; commit: string }>();
  for (const ref of new Set(spec.arms.flatMap(a => (a.harnessRef ? [a.harnessRef] : [])))) {
    refs.set(ref, harnessWorktree(ref, path.join(OUT, 'worktrees')));
    console.log(`  harness ${ref} → ${refs.get(ref)!.commit}`);
  }
  const jobsAt = argv.indexOf('--jobs');
  const total = jobsAt >= 0 ? Number(argv[jobsAt + 1]) : spec.concurrency;
  if (!Number.isInteger(total) || total < 1 || total > 16) throw new Error('--jobs takes a whole number from 1 to 16');
  const limits = { total, perProvider: Math.min(spec.perProvider ?? total, total) };
  if (total > 1) console.log(`  ${limits.total} at once, ${limits.perProvider} per provider; the budget stops new runs, and the ones going finish`);
  const ctx = { spec: spec.name, harnessSha, outDir, timeoutMinutes: spec.timeoutMinutes, concurrency: limits.total, pi: (r: PlannedRun) => (isFaux(r.arm.model) ? dev : installed), harnessAt: (ref: string) => refs.get(ref)! };
  const minutesAt = argv.indexOf('--minutes');
  const deadline = minutesAt >= 0 ? Date.now() + Number(argv[minutesAt + 1]) * 60_000 : Infinity;
  if (minutesAt >= 0 && !(Number(argv[minutesAt + 1]) > 0)) throw new Error('--minutes takes a positive number');
  const queue = [...runs], active = new Map<string, number>(), going = new Set<Promise<void>>();
  let done = 0, stopped = false;
  const start = (run: PlannedRun) => {
    const provider = providerOf(run);
    active.set(provider, (active.get(provider) ?? 0) + 1);
    const p = runOne(run, ctx).then(record => {
      spent += runCost(record); done++;
      fs.appendFileSync(path.join(outDir, 'runs.jsonl'), `${JSON.stringify(record)}\n`);
      if (record.error && EXHAUSTED.test(record.error) && !exhausted.has(provider)) { exhausted.add(provider); console.log(`${provider}: ${record.error.slice(0, 160)} — its remaining runs are skipped`); }
      console.log(`[${done}/${runs.length}] ${record.error ? 'ERROR' : record.pass ? 'pass' : 'FAIL'} ${run.task.id} · ${run.arm.id} · rep ${run.rep} · ${(record.ms / 1000).toFixed(0)}s · $${runCost(record).toFixed(4)}${record.children.count ? ` · ${record.children.count} subagents` : ''}`);
    }).finally(() => { active.set(provider, active.get(provider)! - 1); going.delete(p); });
    going.add(p);
  };
  for (;;) {
    if (!stopped && Date.now() >= deadline) { stopped = true; console.log(`time is up: ${queue.length} runs not started`); }
    if (!stopped && spec.budgetUsd !== undefined && spent >= spec.budgetUsd) { stopped = true; console.log(`budget reached: $${spent.toFixed(2)} of $${spec.budgetUsd}; ${queue.length} runs not started`); }
    // Runs of a provider that ran out are dropped, not started.
    for (let i = queue.length - 1; i >= 0; i--) if (exhausted.has(providerOf(queue[i]!))) { queue.splice(i, 1); skipped++; }
    let i: number;
    while (!stopped && (i = nextRun(queue, active, limits, exhausted)) >= 0) start(queue.splice(i, 1)[0]!);
    if (!going.size) break;
    await Promise.race(going);
  }
  if (skipped) console.log(`${skipped} runs skipped: ${[...exhausted].join(', ')} ran out`);
  const report = formatReport(readRecords(outDir), spec.target);
  fs.writeFileSync(path.join(outDir, 'report.md'), `${report}\n`);
  console.log(`\n${report}\n\n${path.relative(ROOT, path.join(outDir, 'report.md'))}`);
}

main(process.argv.slice(2)).catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
