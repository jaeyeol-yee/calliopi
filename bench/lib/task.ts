// A benchmark task: bench/tasks/<class>/<name>/task.yaml plus a fixture/ directory that each run gets
// a fresh copy of. The oracle is deterministic (commands, files, the final answer); no model grades.
//
//   version: 1                 # bump when the prompt, fixture or oracle changes: results do not mix
//   tier: hard                 # optional: reported apart from the class's other tasks, as <class>-hard
//   prompt: |
//     npm test fails. Fix the bug.
//   scope: [src/range.js]      # existing files the task may change; changing another existing file fails the
//                              # scope dimension, a new file does not (it is listed in `added`). []: read-only,
//                              # any change or new file fails it
//   oracle:                    # every check belongs to a dimension (`dimension:`; outcome unless noted)
//     - command: node --test   # exit 0
//     - file: src/range.js
//       contains: "i <= end"   # or matches: <regex>, or absent: <regex>
//     - answer: "^src/config/defaults\\.js:5$"   # regex on the last non-empty line of the final answer
//     - unchanged: [test/range.test.js]
//     - diagnosis:             # dimension diagnosis: per bug, one of its regexes (case-insensitive) matches the answer
//         shared-regex: ["lastIndex", "global regex"]
//     - citation: [[5, 10], [12]]   # dimension citation: the last line (`line N` / `lines N, M`) names a line of
//                                   # every bug; cited lines of no bug are counted as extra findings (precision).
//                                   # []: the file has no bug, and citing any line fails
//     - content:               # dimension coverage: every `required` item (regexes, as in diagnosis) is in the answer.
//         required: { cause: ["<=", "off[- ]by[- ]one"] }       # Blocks of the answer (paragraphs, list items) that
//         allowed: { verification: ["node --test"] }            # carry no required, diagnosis or allowed item are surplus
//     - hidden: node --test test/hidden.test.js   # dimension hidden: run with the task's hidden/ copied over the work
//   faux: [...]                # replies for faux/* models (smoke tasks)
//
// A run passes (strict pass) when every dimension that applies to its task passes. Extra findings and
// the surplus share of the answer are numbers beside that, not dimensions.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';

export const CLASSES = ['search', 'small-fix', 'multi-file', 'review', 'smoke'] as const;
export type TaskClass = (typeof CLASSES)[number];

export const DIMENSIONS = ['outcome', 'diagnosis', 'citation', 'coverage', 'scope', 'hidden'] as const;
export type Dimension = (typeof DIMENSIONS)[number];

export type Check = (
  | { command: string }
  | { file: string; contains?: string; matches?: string; absent?: string }
  | { answer: string }
  | { unchanged: string[] }
  /** Bug name → regexes; the bug counts as diagnosed when one matches anywhere in the answer. */
  | { diagnosis: Record<string, string[]> }
  /** Per bug, the lines that count as citing it. */
  | { citation: number[][] }
  /** What the answer must say (required: fails coverage when missing) and may say (allowed); the rest is surplus. */
  | { content: { required: Record<string, string[]>; allowed: Record<string, string[]> } }
  /** A command run in a copy of the work directory with the task's hidden/ files laid over it. */
  | { hidden: string }
) & { dimension: Dimension };

export interface Task {
  /** class/name */
  id: string;
  class: TaskClass;
  /** hard: made to separate the stronger models; reported as its own group. */
  tier: 'base' | 'hard';
  version: number;
  prompt: string;
  /** Files the task may change; empty: none. Undefined: changes are not graded. */
  scope?: string[];
  oracle: Check[];
  faux?: unknown[];
  fixture: string;
  /** Tests the model never sees (tasks/<class>/<name>/hidden), for `hidden` checks. */
  hidden?: string;
}

/** The group a task's runs are reported under: its class, or <class>-hard. */
export const taskGroup = (task: Pick<Task, 'class' | 'tier'>) => (task.tier === 'hard' ? `${task.class}-hard` : task.class);

export const TASKS_DIR = path.resolve(import.meta.dirname, '..', 'tasks');

export function parseTask(id: string, text: string, fixture: string, hidden?: string): Task {
  const raw = YAML.parse(text) as Record<string, unknown>;
  const cls = id.split('/')[0] as TaskClass;
  if (!CLASSES.includes(cls)) throw new Error(`${id}: unknown class (${CLASSES.join(', ')})`);
  if (typeof raw?.prompt !== 'string' || !raw.prompt.trim()) throw new Error(`${id}: prompt is required`);
  if (!Number.isInteger(raw.version)) throw new Error(`${id}: version must be an integer`);
  if (!Array.isArray(raw.oracle) || !raw.oracle.length) throw new Error(`${id}: oracle must be a non-empty list`);
  const oracle = raw.oracle.map((c: Record<string, unknown>, i: number): Check => {
    const bad = (why: string) => new Error(`${id}: oracle[${i}] ${why}`);
    if (c.dimension !== undefined && !DIMENSIONS.includes(c.dimension as Dimension)) throw bad(`has an unknown dimension (${DIMENSIONS.join(', ')})`);
    // A check without a dimension is an outcome check, as every check was before dimensions.
    const dim = (fallback: Dimension = 'outcome') => ({ dimension: (c.dimension as Dimension | undefined) ?? fallback });
    if (typeof c.command === 'string') return { command: c.command, ...dim() };
    if (typeof c.answer === 'string') return { answer: c.answer, ...dim() };
    if (Array.isArray(c.unchanged)) return { unchanged: c.unchanged.map(String), ...dim() };
    if (typeof c.file === 'string' && (c.contains ?? c.matches ?? c.absent) !== undefined)
      return { file: c.file, ...(c.contains !== undefined ? { contains: String(c.contains) } : {}), ...(c.matches !== undefined ? { matches: String(c.matches) } : {}), ...(c.absent !== undefined ? { absent: String(c.absent) } : {}), ...dim() };
    if (c.diagnosis && typeof c.diagnosis === 'object' && !Array.isArray(c.diagnosis)) {
      const bugs = Object.entries(c.diagnosis as Record<string, unknown>).map(([bug, any]) => [bug, Array.isArray(any) ? any.map(String) : []] as const);
      if (!bugs.length || bugs.some(([, any]) => !any.length)) throw bad('diagnosis needs a non-empty regex list per bug');
      for (const [, any] of bugs) for (const re of any) new RegExp(re, 'i');
      return { diagnosis: Object.fromEntries(bugs), ...dim('diagnosis') };
    }
    if (Array.isArray(c.citation)) {
      const bugs = c.citation.map(lines => (Array.isArray(lines) ? lines : [lines]).map(Number));
      if (bugs.some(lines => !lines.length || lines.some(n => !Number.isInteger(n) || n < 1))) throw bad('citation needs a list of line numbers per bug');
      return { citation: bugs, ...dim('citation') };
    }
    if (c.content && typeof c.content === 'object') {
      const items = (of: unknown, what: string) => {
        const entries = Object.entries((of ?? {}) as Record<string, unknown>).map(([name, any]) => [name, Array.isArray(any) ? any.map(String) : []] as const);
        if (entries.some(([, any]) => !any.length)) throw bad(`content.${what} needs a non-empty regex list per item`);
        for (const [, any] of entries) for (const re of any) new RegExp(re, 'i');
        return Object.fromEntries(entries);
      };
      const content = c.content as Record<string, unknown>;
      return { content: { required: items(content.required, 'required'), allowed: items(content.allowed, 'allowed') }, ...dim('coverage') };
    }
    if (typeof c.hidden === 'string') {
      if (!hidden) throw bad('needs a hidden/ directory next to fixture/');
      return { hidden: c.hidden, ...dim('hidden') };
    }
    throw bad('is not a known check');
  });
  if (raw.scope !== undefined && !Array.isArray(raw.scope)) throw new Error(`${id}: scope must be a list`);
  if (raw.tier !== undefined && raw.tier !== 'hard' && raw.tier !== 'base') throw new Error(`${id}: tier must be base or hard`);
  return {
    id, class: cls, tier: raw.tier === 'hard' ? 'hard' : 'base', version: raw.version as number, prompt: raw.prompt, oracle, fixture,
    ...(Array.isArray(raw.scope) ? { scope: raw.scope.map(String) } : {}),
    ...(Array.isArray(raw.faux) ? { faux: raw.faux } : {}),
    ...(hidden ? { hidden } : {}),
  };
}

export function loadTasks(dir = TASKS_DIR): Task[] {
  const out: Task[] = [];
  for (const cls of fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [])
    for (const name of fs.readdirSync(path.join(dir, cls)).sort()) {
      const file = path.join(dir, cls, name, 'task.yaml');
      const hidden = path.join(dir, cls, name, 'hidden');
      if (fs.existsSync(file)) out.push(parseTask(`${cls}/${name}`, fs.readFileSync(file, 'utf8'), path.join(dir, cls, name, 'fixture'), fs.existsSync(hidden) ? hidden : undefined));
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

export interface CheckResult {
  check: string;
  /** Absent in records from before dimensions: read as outcome. */
  dimension?: Dimension;
  pass: boolean;
  detail?: string;
  /** Citation checks: cited lines that belong to no bug. */
  extra?: number;
}

export interface ContentSize {
  /** Words in the answer; in its blocks that carry an allowed item but no required one; and in those that carry neither (surplus). The rest are needed. */
  words: number; allowedWords: number; surplusWords: number;
  blocks: number; surplusBlocks: number;
}

export interface Grade {
  checks: CheckResult[];
  /** Pass per dimension, for the dimensions the task has. */
  dimensions: Partial<Record<Dimension, boolean>>;
  /** Precision: findings cited beyond the real bugs. Undefined when the task has no citation check or the citation could not be read. */
  extraFindings?: number;
  /** The answer's size against what the task needs; for tasks with a content check. */
  content?: ContentSize;
  changed: string[];
  /** Existing files changed outside the scope (or, for a read-only task, any change). */
  outOfScope: string[];
  /** Files the run created outside the scope; allowed unless the task is read-only. */
  added: string[];
  /** Strict pass: every dimension passes. */
  pass: boolean;
}

const lastLine = (text: string) => text.split('\n').map(l => l.trim().replace(/^[`*]+|[`*]+$/g, '')).filter(Boolean).at(-1) ?? '';

/** The lines a final `line N` / `lines N, M` names, or undefined when the last line is not of that form. */
export function citedLines(answer: string): number[] | undefined {
  const m = /^lines? (\d+(?:(?:, ?| and |, and )\d+)*)\.?$/i.exec(lastLine(answer));
  return m ? [...new Set(m[1]!.match(/\d+/g)!.map(Number))] : undefined;
}

/** The answer as blocks: paragraphs, with every list item, heading and table row a block of its own. */
export function answerBlocks(answer: string): string[] {
  const blocks: string[] = [];
  let open = false;
  for (const line of answer.split('\n')) {
    if (!/[\p{L}\p{N}]/u.test(line)) { open = false; continue; } // blank lines and rules end a block
    if (open && !/^\s*([-*•]|\d+[.)]|#+|\|)\s?/.test(line)) blocks[blocks.length - 1] += ` ${line.trim()}`;
    else blocks.push(line.trim());
    open = true;
  }
  return blocks;
}

/** Words: list markers, table bars and other tokens without a letter or digit do not count. */
const wordCount = (text: string) => text.split(/\s+/).filter(token => /[\p{L}\p{N}]/u.test(token)).length;

/** How much of the answer is needed: a block is needed when it holds a required item (or is the final answer line), allowed when it holds an allowed one or is an item of a list such a block introduces, surplus otherwise. */
export function contentSize(answer: string, needed: string[], allowed: string[], finalLine: boolean): ContentSize {
  const blocks = answerBlocks(answer);
  if (finalLine && blocks.length) {
    // the line the prompt asks for is needed even when it shares a paragraph
    const last = lastLine(answer), at = blocks.length - 1;
    if (blocks[at] !== last && blocks[at]!.endsWith(last)) blocks.splice(at, 1, blocks[at]!.slice(0, -last.length).trim(), last);
  }
  const has = (res: string[], block: string) => res.some(re => new RegExp(re, 'i').test(block));
  // A list item with no item of its own belongs to the line that introduces the list ("The rest matches the comments:").
  let lead: 'needed' | 'allowed' | undefined;
  const words = { needed: 0, allowed: 0, surplus: 0 };
  let surplusBlocks = 0;
  for (const [i, block] of blocks.entries()) {
    const own = (finalLine && i === blocks.length - 1) || has(needed, block) ? 'needed' : has(allowed, block) ? 'allowed' : undefined;
    const listItem = /^([-*•]|\d+[.)])\s/.test(block);
    if (!listItem) lead = own && /:(\*\*|__|\*|_)?$/.test(block) ? own : undefined;
    const kind = own ?? (listItem ? lead : undefined) ?? 'surplus';
    words[kind] += wordCount(block);
    if (kind === 'surplus') surplusBlocks++;
  }
  return { words: words.needed + words.allowed + words.surplus, allowedWords: words.allowed, surplusWords: words.surplus, blocks: blocks.length, surplusBlocks };
}

const shell = (command: string, cwd: string): { pass: boolean; detail?: string } => {
  // Without the test runner's context: under `node --test`, a nested `node --test` reports to the parent and exits 0.
  const { NODE_TEST_CONTEXT: _, ...env } = process.env;
  const r = spawnSync(command, { cwd, shell: true, encoding: 'utf8', timeout: 120_000, env });
  return { pass: r.status === 0, ...(r.status === 0 ? {} : { detail: `exit ${r.status}: ${(r.stderr || r.stdout).trim().split('\n').slice(-3).join(' | ')}` }) };
};

/** Grades what a run left in `dir` (never written to) and its final answer; `before` is the fixture's snapshot. */
export function runOracle(task: Task, dir: string, answer: string, before: Map<string, string>): Grade {
  const read = (f: string) => { try { return fs.readFileSync(path.join(dir, f), 'utf8'); } catch { return undefined; } };
  const checks = task.oracle.flatMap((c): CheckResult[] => [grade(c)].filter(r => r.check));
  function grade(c: Check): CheckResult {
    const dimension = c.dimension;
    if ('command' in c) return { check: `command: ${c.command}`, dimension, ...shell(c.command, dir) };
    if ('hidden' in c) {
      const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'calliopi-bench-hidden-'));
      try {
        fs.cpSync(dir, copy, { recursive: true, filter: src => !path.relative(dir, src).split(path.sep).includes('.git') });
        fs.cpSync(task.hidden!, copy, { recursive: true });
        return { check: `hidden: ${c.hidden}`, dimension, ...shell(c.hidden, copy) };
      } finally { fs.rmSync(copy, { recursive: true, force: true }); }
    }
    if ('answer' in c) {
      const line = lastLine(answer);
      return { check: `answer: ${c.answer}`, dimension, pass: new RegExp(c.answer).test(line), detail: line.slice(0, 200) };
    }
    if ('diagnosis' in c) {
      const missed = Object.entries(c.diagnosis).filter(([, any]) => !any.some(re => new RegExp(re, 'i').test(answer))).map(([bug]) => bug);
      return { check: `diagnosis: ${Object.keys(c.diagnosis).join(', ')}`, dimension, pass: !missed.length, ...(missed.length ? { detail: `not found: ${missed.join(', ')}` } : {}) };
    }
    if ('citation' in c) {
      const check = `citation: ${c.citation.map(lines => lines.join('|')).join(', ')}`;
      const cited = citedLines(answer);
      // A file without bugs: nothing may be cited.
      if (!c.citation.length) return { check: 'citation: none', dimension, pass: !cited, extra: cited?.length ?? 0, ...(cited ? { detail: `cited ${cited.join(', ')}; the file has no bug` } : {}) };
      if (!cited) return { check, dimension, pass: false, detail: `no line citation: ${lastLine(answer).slice(0, 160)}` };
      const missed = c.citation.filter(lines => !lines.some(n => cited.includes(n)));
      const extra = cited.filter(n => !c.citation.flat().includes(n));
      return { check, dimension, pass: !missed.length, extra: extra.length, detail: `cited ${cited.join(', ')}${missed.length ? `; no line of ${missed.map(lines => lines.join('|')).join(', ')}` : ''}${extra.length ? `; extra ${extra.join(', ')}` : ''}` };
    }
    if ('content' in c) {
      // Without required items the check only measures the answer's size (below); it has no verdict.
      const missed = Object.entries(c.content.required).filter(([, any]) => !any.some(re => new RegExp(re, 'i').test(answer))).map(([item]) => item);
      return { check: Object.keys(c.content.required).length ? `content: ${Object.keys(c.content.required).join(', ')}` : '', dimension, pass: !missed.length, ...(missed.length ? { detail: `not in the answer: ${missed.join(', ')}` } : {}) };
    }
    if ('unchanged' in c) {
      const changed = c.unchanged.filter(f => before.get(f) !== read(f));
      return { check: `unchanged: ${c.unchanged.join(', ')}`, dimension, pass: !changed.length, ...(changed.length ? { detail: `changed: ${changed.join(', ')}` } : {}) };
    }
    const text = read(c.file);
    const ok = text !== undefined
      && (c.contains === undefined || text.includes(c.contains))
      && (c.matches === undefined || new RegExp(c.matches, 'm').test(text))
      && (c.absent === undefined || !new RegExp(c.absent, 'm').test(text));
    return { check: `file: ${c.file}`, dimension, pass: ok, ...(ok ? {} : { detail: text === undefined ? 'missing' : 'content does not match' }) };
  }
  const changed = changedFiles(before, snapshot(dir));
  // A new file (a helper split out of a change) is not out of scope: the prompt does not list the scope.
  // Changing an existing file the task did not ask for is; on a read-only task, so is anything.
  const outside = task.scope ? changed.filter(f => !task.scope!.includes(f)) : [];
  const added = outside.filter(f => !before.has(f));
  const outOfScope = task.scope?.length === 0 ? outside : outside.filter(f => before.has(f));
  if (task.scope) checks.push({ check: `scope: ${task.scope.join(', ') || 'no file may change'}`, dimension: 'scope', pass: !outOfScope.length, ...(outOfScope.length ? { detail: `changed: ${outOfScope.join(', ')}` } : {}) });
  const dimensions: Partial<Record<Dimension, boolean>> = {};
  for (const d of DIMENSIONS) { const of = checks.filter(c => c.dimension === d); if (of.length) dimensions[d] = of.every(c => c.pass); }
  const extras = checks.flatMap(c => (c.extra === undefined ? [] : [c.extra]));
  const content = task.oracle.find(c => 'content' in c);
  const size = content && 'content' in content ? contentSize(answer,
    [...Object.values(content.content.required), ...task.oracle.flatMap(c => ('diagnosis' in c ? Object.values(c.diagnosis) : []))].flat(),
    Object.values(content.content.allowed).flat(), task.oracle.some(c => 'answer' in c || 'citation' in c)) : undefined;
  return { checks, dimensions, ...(extras.length ? { extraFindings: extras.reduce((a, b) => a + b, 0) } : {}), ...(size ? { content: size } : {}), changed, outOfScope, added, pass: Object.values(dimensions).every(Boolean) };
}
