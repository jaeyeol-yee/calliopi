import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CATALOG, loadPi, versionAtLeast } from '../lib/catalog.ts';
import { cells, formatReport, lineages, median, saturation, thresholds } from '../lib/report.ts';
import { collectChildren, type RunRecord } from '../lib/run.ts';
import { createAgent, treeDir, writeResult } from '@calliopi/core/agents';
import { checkSpec, parseSpec, plan } from '../lib/spec.ts';
import { loadTasks, runOracle, snapshot } from '../lib/task.ts';

test('every catalog model exists in the installed Pi, with its lineage orders distinct', async () => {
  const pi = await loadPi();
  const missing = CATALOG.filter(c => (!c.minPi || versionAtLeast(pi.version, c.minPi)) && !pi.get(c.id)).map(c => c.id);
  assert.deepEqual(missing, [], `Pi ${pi.version} (${pi.source}) lacks these catalog models`);
  const keys = CATALOG.map(c => `${c.lineage}:${c.order}`);
  assert.equal(new Set(keys).size, keys.length);
  assert.ok(pi.get('anthropic/claude-opus-5-5')!.efforts.includes('medium'));
});

test('spec: effort lists expand, replicates need labels, harness and efforts are checked', async () => {
  const spec = parseSpec(`name: t\nruns: 2\narms:\n  - { model: anthropic/claude-opus-5-5, effort: [low, high] }\n  - { model: anthropic/claude-opus-5-5, effort: low, label: rep }\n  - { model: anthropic/claude-fable-5-2, effort: off, harness: off }\n`);
  assert.deepEqual(spec.arms.map(a => [a.id, a.effort, a.harness]), [['claude-opus-5-5@low', 'low', 'on'], ['claude-opus-5-5@high', 'high', 'on'], ['rep', 'low', 'on'], ['claude-fable-5-2@off-bare', 'off', 'off']]);
  assert.throws(() => parseSpec(`name: t\narms:\n  - { model: a/b, effort: medium }\n  - { model: a/b, effort: medium }\n`), /appears twice/);
  assert.throws(() => parseSpec(`name: t\narms:\n  - { model: a/b, effort: huge }\n`), /unknown effort/);
  assert.throws(() => parseSpec(`name: t\narms: []\n`), /non-empty/);
  assert.deepEqual(parseSpec(`name: t\narms:\n  - { model: a/b, harnessRef: main }\n`).arms.map(a => [a.id, a.harnessRef]), [['b@medium@main', 'main']]);
  assert.throws(() => parseSpec(`name: t\narms:\n  - { model: a/b, harnessRef: main, harness: off }\n`), /harnessRef/);
  assert.throws(() => parseSpec(`name: t\narms:\n  - { model: a/b, harnessRef: '--upload-pack=x' }\n`), /harnessRef/);
  assert.equal(parseSpec(`name: t\nbudgetUsd: 2.5\narms:\n  - { model: a/b }\n`).budgetUsd, 2.5);
  const tasks = loadTasks();
  const problems = checkSpec(spec, await loadPi(), tasks);
  assert.deepEqual(problems, ['claude-fable-5-2@off-bare: anthropic/claude-fable-5-2 does not accept effort off (minimal, low, medium, high, xhigh, max)']);
  const runs = plan(spec, tasks);
  assert.equal(runs.length, 2 * 12 * 4); // runs × non-smoke tasks × arms
  assert.equal(runs[0]!.rep, 1); assert.equal(runs.at(-1)!.rep, 2);
});

test('the shipped specs parse and check clean', async () => {
  const pi = await loadPi(), tasks = loadTasks();
  for (const f of fs.readdirSync(path.join(import.meta.dirname, '..', 'specs')))
    assert.deepEqual(checkSpec(parseSpec(fs.readFileSync(path.join(import.meta.dirname, '..', 'specs', f), 'utf8')), pi, tasks), [], f);
});

// Every task: doing nothing fails its oracle, the reference solution passes it.
const SOLUTIONS: Record<string, { edits?: [string, string, string][]; answer: string }> = {
  'search/find-default': { answer: 'The default is requestTimeoutMs.\nsrc/config/defaults.js:5' },
  'small-fix/off-by-one': { edits: [['src/range.js', 'i < end', 'i <= end']], answer: 'Fixed.' },
  'multi-file/rename-option': {
    edits: [['src/logger.js', 'options.verbose', 'options.debug'], ['src/server.js', '{ verbose: config.verbose }', '{ debug: config.debug }'], ['src/cli.js', "{ verbose: argv.includes('--verbose')", "{ debug: argv.includes('--debug')"], ['src/cli.js', '--verbose', '--debug']],
    answer: 'Renamed.',
  },
  'review/spot-bug': { answer: 'The 5 euro discount uses > instead of >= 100 euros.\nline 6' },
  'search/trace-port': { answer: 'The staging profile sets 8100 and PORT_OFFSET=2 shifts it.\n8102' },
  'small-fix/thousands': { edits: [['src/parse.js', ".replace(',', '')", ".replaceAll(',', '')"]], answer: 'Fixed.' },
  'multi-file/locale': {
    edits: [
      ['src/format.js', 'function formatPrice(cents) {\n  return `€${(cents / 100).toFixed(2)}`;', "function formatPrice(cents, locale = 'en') {\n  const [whole, frac] = (cents / 100).toFixed(2).split('.');\n  if (locale === 'de') return `${whole.replace(/\\B(?=(\\d{3})+$)/g, '.')},${frac} €`;\n  return `€${whole}.${frac}`;"],
      ['src/cart.js', 'function summary(items) {', "function summary(items, locale = 'en') {"],
      ['src/cart.js', 'formatPrice(cents)', 'formatPrice(cents, locale)'],
      ['src/invoice.js', 'function invoiceLine(item) {', "function invoiceLine(item, locale = 'en') {"],
      ['src/invoice.js', 'formatPrice(item.cents * item.qty)', 'formatPrice(item.cents * item.qty, locale)'],
    ],
    answer: 'Done.',
  },
  'review/pagination': { answer: 'slice already excludes its end, so the last item of each page is lost.\nline 8' },
  'search/direct-callers': { answer: 'reminders.js (mail.sendEmail), signup.js (deliver), broadcast.js (send).\n3' },
  'small-fix/lru': {
    edits: [
      ['src/lru.js', '    return this.map.get(key);', '    if (!this.map.has(key)) return undefined;\n    const value = this.map.get(key);\n    this.map.delete(key);\n    this.map.set(key, value);\n    return value;'],
      ['src/lru.js', '    this.map.set(key, value);\n    if', '    this.map.delete(key);\n    this.map.set(key, value);\n    if'],
    ],
    answer: 'Fixed.',
  },
  'multi-file/promisify': {
    edits: [
      ['src/store.js', 'function read(key, cb) {\n  setImmediate(() => {\n    if (failNext > 0) { failNext--; return cb(new Error(\'transient\')); }\n    if (!data.has(key)) return cb(new Error(`missing ${key}`));\n    cb(null, data.get(key));\n  });\n}',
        'function read(key) {\n  return new Promise((resolve, reject) => setImmediate(() => {\n    if (failNext > 0) { failNext--; return reject(new Error(\'transient\')); }\n    if (!data.has(key)) return reject(new Error(`missing ${key}`));\n    resolve(data.get(key));\n  }));\n}'],
      ['src/retry.js', '*', "const store = require('./store');\nasync function readWithRetry(key, times) {\n  try { return await store.read(key); }\n  catch (err) { if (err.message === 'transient' && times > 1) return readWithRetry(key, times - 1); throw err; }\n}\nmodule.exports = { readWithRetry };\n"],
      ['src/greet.js', '*', "const { readWithRetry } = require('./retry');\nasync function greeting(name) { return `${await readWithRetry('greeting', 3)}, ${name}`; }\nmodule.exports = { greeting };\n"],
      ['src/counter.js', '*', "const { readWithRetry } = require('./retry');\nasync function nextCount() { return Number(await readWithRetry('count', 2)) + 1; }\nmodule.exports = { nextCount };\n"],
    ],
    answer: 'Done.',
  },
  'review/duration': { answer: 'TOKEN is a shared /g regex: after a throw its lastIndex is left set. `<` lets a unit repeat.\nlines 5, 12' },
  'smoke/faux-fix': { edits: [['src/greet.js', "return 'Hello, ';", 'return `Hello, ${name}`;']], answer: 'ok' },
};

test('each task: a no-op fails its oracle and the reference solution passes it', () => {
  for (const task of loadTasks()) {
    const solution = SOLUTIONS[task.id];
    assert.ok(solution, `${task.id} has no reference solution in this test`);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-oracle-'));
    try {
      fs.cpSync(task.fixture, dir, { recursive: true });
      const before = snapshot(dir);
      assert.ok(runOracle(task, dir, 'I looked at it.', before).some(c => !c.pass), `${task.id}: a no-op passes`);
      for (const [file, from, to] of solution.edits ?? []) {
        const p = path.join(dir, file), text = fs.readFileSync(p, 'utf8');
        if (from === '*') { fs.writeFileSync(p, to); continue; } // the whole file
        assert.ok(text.includes(from), `${task.id}: ${file} lacks ${from}`);
        fs.writeFileSync(p, text.replace(from, to));
      }
      const checks = runOracle(task, dir, solution.answer, before);
      assert.ok(checks.every(c => c.pass), `${task.id}: ${JSON.stringify(checks.filter(c => !c.pass))}`);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
});

const rec = (arm: string, model: string, effort: string, taskClass: string, rep: number, pass: boolean, cost: number, harness: 'on' | 'off' = 'on'): RunRecord => ({
  spec: 's', arm, model, effort, harness, task: `${taskClass}/x`, taskClass, taskVersion: 1, rep, piVersion: '1.6.0', harnessSha: 'abc', at: '', ms: 1,
  exit: 0, timedOut: false, pass, checks: [], changed: [], outOfScope: [], answer: '',
  signals: { turns: 2, toolCalls: {}, toolErrors: 0, parallelCalls: 1, input: 10, output: 5, cacheRead: 30, cacheWrite: 10, cost },
  children: { count: 0, cost: 0, turns: 0, ends: {} },
});

test('report: worst–best repetition, threshold, saturation and lineage deltas', () => {
  const records = [
    // a cheap model that passes once of two reps, a dearer one that always passes
    rec('sonnet@medium', 'anthropic/claude-sonnet-5-5', 'medium', 'small-fix', 1, true, 0.1),
    rec('sonnet@medium', 'anthropic/claude-sonnet-5-5', 'medium', 'small-fix', 2, false, 0.1),
    rec('opus@low', 'anthropic/claude-opus-5-5', 'low', 'small-fix', 1, true, 0.2),
    rec('opus@low', 'anthropic/claude-opus-5-5', 'low', 'small-fix', 2, true, 0.2),
    rec('opus@high', 'anthropic/claude-opus-5-5', 'high', 'small-fix', 1, true, 0.5),
    rec('opus@high', 'anthropic/claude-opus-5-5', 'high', 'small-fix', 2, true, 0.5),
    rec('opus5@low', 'anthropic/claude-opus-5', 'low', 'small-fix', 1, true, 0.3),
    rec('opus5@low', 'anthropic/claude-opus-5', 'low', 'small-fix', 2, false, 0.3),
    rec('bare', 'anthropic/claude-sonnet-5-5', 'low', 'small-fix', 1, true, 0.01, 'off'),
  ];
  assert.deepEqual([median([3, 1, 2]), median([1, 3, 2, 10]), median([])], [2, 2.5, 0]);
  const cs = cells(records);
  const sonnet = cs.find(c => c.arm === 'sonnet@medium')!;
  assert.deepEqual([sonnet.passes, sonnet.runs, sonnet.min, sonnet.max], [1, 2, 0, 1]);
  assert.equal(sonnet.cacheHit, 30 / 50);
  assert.equal(thresholds(cs, 0.9).get('small-fix')!.arm, 'opus@low'); // the bare arm is cheaper but harness off
  assert.deepEqual(saturation(cs), [{ taskClass: 'small-fix', model: 'anthropic/claude-opus-5-5', effort: 'low', rate: 1 }]);
  const opus = lineages(cs).find(l => l.lineage === 'claude-opus' && l.effort === 'low')!;
  assert.deepEqual(opus.versions.map(v => [v.model, v.rate, v.delta]), [['anthropic/claude-opus-5', 0.5, undefined], ['anthropic/claude-opus-5-5', 1, 0.5]]);
  const text = formatReport(records, 0.9);
  assert.match(text, /Pi 1\.6\.0 · harness abc · tasks small-fix\/x@v1/);
  assert.match(text, /- small-fix: opus@low at \$0\.20\/run/);
  assert.match(text, /claude-opus-5 50% → claude-opus-5-5 100% \(\+50pp\)/);
  assert.equal(formatReport([], 0.9), 'No runs recorded.');
});

test('a run\'s subagents are counted with their cost and moved out of the registry', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-children-'));
  try {
    const env = { PI_CODING_AGENT_DIR: home };
    const root = path.join(home, 'calliopi-agents'), top = '01a2-run';
    const meta = { root: top, parent: null, depth: 1, role: 'reviewer', model: 'm/x', modelSource: 'inherit', tools: [], cwd: '/', createdAt: 1, call: { task: 't' }, pane: null } as never;
    const a = createAgent(root, meta), b = createAgent(root, meta);
    writeResult(a.dir, { status: 'done', summary: '', usage: { turns: 1, tokens: 1, ms: 1 }, endedAt: 1 } as never);
    writeResult(b.dir, { status: 'stopped', summary: '', usage: { turns: 1, tokens: 1, ms: 1 }, endedAt: 1 } as never);
    fs.writeFileSync(path.join(a.dir, `2026_${a.meta.id}.jsonl`), JSON.stringify({ type: 'message', message: { role: 'assistant', content: [], usage: { cost: { total: 0.25 } } } }) + '\n');
    const into = path.join(home, 'run');
    fs.mkdirSync(into);
    const children = collectChildren(path.join(home, `2026-11-27T00_${top}.jsonl`), into, env);
    assert.deepEqual(children, { count: 2, cost: 0.25, turns: 1, ends: { done: 1, stopped: 1 } });
    assert.ok(!fs.existsSync(treeDir(root, top)));
    assert.ok(fs.existsSync(path.join(into, 'agents', a.meta.id, 'result.json')));
    assert.deepEqual(collectChildren(undefined, into, env), { count: 0, cost: 0, turns: 0, ends: {} });
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
