// A benchmark task: bench/tasks/<class>/<name>/task.yaml plus a fixture/ directory that each run gets
// a fresh copy of. The oracle is deterministic (commands, files, the final answer); no model grades.
//
//   version: 1                 # bump when the prompt, fixture or oracle changes: results do not mix
//   prompt: |
//     npm test fails. Fix the bug.
//   scope: [src/range.js]      # files the task may change; other changes count as out of scope
//   oracle:
//     - command: node --test   # exit 0
//     - file: src/range.js
//       contains: "i <= end"   # or matches: <regex>, or absent: <regex>
//     - answer: "^src/config/defaults\\.js:5$"   # regex on the last non-empty line of the final answer
//     - unchanged: [test/range.test.js]
//   faux: [...]                # replies for faux/* models (smoke tasks)
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

export const CLASSES = ['search', 'small-fix', 'multi-file', 'review', 'smoke'] as const;
export type TaskClass = (typeof CLASSES)[number];

export type Check =
  | { command: string }
  | { file: string; contains?: string; matches?: string; absent?: string }
  | { answer: string }
  | { unchanged: string[] };

export interface Task {
  /** class/name */
  id: string;
  class: TaskClass;
  version: number;
  prompt: string;
  scope: string[];
  oracle: Check[];
  faux?: unknown[];
  fixture: string;
}

export const TASKS_DIR = path.resolve(import.meta.dirname, '..', 'tasks');

export function parseTask(id: string, text: string, fixture: string): Task {
  const raw = YAML.parse(text) as Record<string, unknown>;
  const cls = id.split('/')[0] as TaskClass;
  if (!CLASSES.includes(cls)) throw new Error(`${id}: unknown class (${CLASSES.join(', ')})`);
  if (typeof raw?.prompt !== 'string' || !raw.prompt.trim()) throw new Error(`${id}: prompt is required`);
  if (!Number.isInteger(raw.version)) throw new Error(`${id}: version must be an integer`);
  if (!Array.isArray(raw.oracle) || !raw.oracle.length) throw new Error(`${id}: oracle must be a non-empty list`);
  const oracle = raw.oracle.map((c: Record<string, unknown>, i: number): Check => {
    if (typeof c.command === 'string') return { command: c.command };
    if (typeof c.answer === 'string') return { answer: c.answer };
    if (Array.isArray(c.unchanged)) return { unchanged: c.unchanged.map(String) };
    if (typeof c.file === 'string' && (c.contains ?? c.matches ?? c.absent) !== undefined)
      return { file: c.file, ...(c.contains !== undefined ? { contains: String(c.contains) } : {}), ...(c.matches !== undefined ? { matches: String(c.matches) } : {}), ...(c.absent !== undefined ? { absent: String(c.absent) } : {}) };
    throw new Error(`${id}: oracle[${i}] is not a known check`);
  });
  return {
    id, class: cls, version: raw.version as number, prompt: raw.prompt, oracle, fixture,
    scope: Array.isArray(raw.scope) ? raw.scope.map(String) : [],
    ...(Array.isArray(raw.faux) ? { faux: raw.faux } : {}),
  };
}

export function loadTasks(dir = TASKS_DIR): Task[] {
  const out: Task[] = [];
  for (const cls of fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [])
    for (const name of fs.readdirSync(path.join(dir, cls)).sort()) {
      const file = path.join(dir, cls, name, 'task.yaml');
      if (fs.existsSync(file)) out.push(parseTask(`${cls}/${name}`, fs.readFileSync(file, 'utf8'), path.join(dir, cls, name, 'fixture')));
    }
  return out;
}

/** Every file under dir (relative, sorted) with its content, to see what a run changed. */
export function snapshot(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  (function walk(rel: string) {
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const p = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== '.git') walk(p); }
      else if (e.isFile()) out.set(p, fs.readFileSync(path.join(dir, p), 'utf8'));
    }
  })('');
  return out;
}

export const changedFiles = (before: Map<string, string>, after: Map<string, string>) =>
  [...new Set([...before.keys(), ...after.keys()])].filter(f => before.get(f) !== after.get(f)).sort();

export interface CheckResult { check: string; pass: boolean; detail?: string }

const lastLine = (text: string) => text.split('\n').map(l => l.trim().replace(/^[`*]+|[`*]+$/g, '')).filter(Boolean).at(-1) ?? '';

export function runOracle(task: Task, dir: string, answer: string, before: Map<string, string>): CheckResult[] {
  const read = (f: string) => { try { return fs.readFileSync(path.join(dir, f), 'utf8'); } catch { return undefined; } };
  return task.oracle.map((c): CheckResult => {
    if ('command' in c) {
      // Without the test runner's context: under `node --test`, a nested `node --test` reports to the parent and exits 0.
      const { NODE_TEST_CONTEXT: _, ...env } = process.env;
      const r = spawnSync(c.command, { cwd: dir, shell: true, encoding: 'utf8', timeout: 120_000, env });
      return { check: `command: ${c.command}`, pass: r.status === 0, ...(r.status === 0 ? {} : { detail: `exit ${r.status}: ${(r.stderr || r.stdout).trim().split('\n').slice(-3).join(' | ')}` }) };
    }
    if ('answer' in c) {
      const line = lastLine(answer);
      return { check: `answer: ${c.answer}`, pass: new RegExp(c.answer).test(line), detail: line.slice(0, 200) };
    }
    if ('unchanged' in c) {
      const changed = c.unchanged.filter(f => before.get(f) !== read(f));
      return { check: `unchanged: ${c.unchanged.join(', ')}`, pass: !changed.length, ...(changed.length ? { detail: `changed: ${changed.join(', ')}` } : {}) };
    }
    const text = read(c.file);
    const ok = text !== undefined
      && (c.contains === undefined || text.includes(c.contains))
      && (c.matches === undefined || new RegExp(c.matches, 'm').test(text))
      && (c.absent === undefined || !new RegExp(c.absent, 'm').test(text));
    return { check: `file: ${c.file}`, pass: ok, ...(ok ? {} : { detail: text === undefined ? 'missing' : 'content does not match' }) };
  });
}
