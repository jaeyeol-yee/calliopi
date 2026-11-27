// Calliopi's model benchmark.
//
//   npm run bench -- bench/specs/<name>.yaml --dry-run   check the spec and list the planned runs
//   npm run bench -- bench/specs/<name>.yaml             run them (real models cost money)
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
import { ROOT, runCost, runOne, type PiBinary, type RunRecord } from './lib/run.ts';
import { checkSpec, isFaux, parseSpec, plan } from './lib/spec.ts';
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
  const file = argv.find(a => !a.startsWith('--'));
  if (!file) throw new Error('usage: npm run bench -- <spec.yaml> [--dry-run] | --report <dir>');
  const spec = parseSpec(fs.readFileSync(file, 'utf8'));
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
  const harnessSha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim() + (dirty ? '-dirty' : '');
  const installed: PiBinary = { command: 'pi', version: pi.version };
  const dev: PiBinary = { command: path.join(ROOT, 'node_modules', '.bin', 'pi'), version: JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules', '@earendil-works', 'pi-coding-agent', 'package.json'), 'utf8')).version };
  if (spec.budgetUsd === undefined && runs.some(r => !isFaux(r.arm.model))) throw new Error(`${spec.name}: real models need budgetUsd in the spec`);
  let spent = 0;
  for (const [i, run] of runs.entries()) {
    if (spec.budgetUsd !== undefined && spent >= spec.budgetUsd) { console.log(`budget reached: $${spent.toFixed(2)} of $${spec.budgetUsd}; ${runs.length - i} runs not started`); break; }
    const record = runOne(run, { spec: spec.name, harnessSha, outDir, timeoutMinutes: spec.timeoutMinutes, pi: r => (isFaux(r.arm.model) ? dev : installed) });
    spent += runCost(record);
    fs.appendFileSync(path.join(outDir, 'runs.jsonl'), `${JSON.stringify(record)}\n`);
    console.log(`[${i + 1}/${runs.length}] ${record.pass ? 'pass' : 'FAIL'} ${run.task.id} · ${run.arm.id} · rep ${run.rep} · ${(record.ms / 1000).toFixed(0)}s · $${runCost(record).toFixed(4)}${record.children.count ? ` · ${record.children.count} subagents` : ''}`);
  }
  const report = formatReport(readRecords(outDir), spec.target);
  fs.writeFileSync(path.join(outDir, 'report.md'), `${report}\n`);
  console.log(`\n${report}\n\n${path.relative(ROOT, path.join(outDir, 'report.md'))}`);
}

main(process.argv.slice(2)).catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
