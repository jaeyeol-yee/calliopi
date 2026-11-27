import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CATALOG, loadPi, versionAtLeast } from '../lib/catalog.ts';
import { cells, formatReport, lineages, median, saturation, thresholds } from '../lib/report.ts';
import { formatRescore, rescore } from '../rescore.ts';
import { collectChildren, type RunRecord } from '../lib/run.ts';
import { createAgent, treeDir, writeResult } from '@calliopi/core/agents';
import { checkSpec, parseSpec, plan } from '../lib/spec.ts';
import { createRequire } from 'node:module';
import { citedLines, loadTasks, parseTask, runOracle, snapshot, taskGroup, type Task } from '../lib/task.ts';

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
  assert.equal(runs.length, 2 * 20 * 4); // runs × non-smoke tasks × arms
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
  'search/unused-flags': { answer: 'Five flags are only defined, set, or named in comments and tests.\nerrorLog, fastExport, legacyAuth, pushAlerts, strictMode' },
  'search/purge-routes': { answer: 'retention.apply calls it as dropAuditTrail; the nightly job trims the trail; sessions.clear with ?forget=trail.\n`POST /users/:id/anonymize`, `POST /jobs/:name/run`, `DELETE /sessions`' },
  'small-fix/event-order': { edits: [['src/events.js', 'return { seq, type', 'return { seq: Number(seq), type']], answer: 'Sequence numbers were compared as strings.' },
  'small-fix/task-queue': {
    edits: [['src/queue.js', '      fn().then(value => {\n        this.running--;\n        resolve(value);\n        this.next();\n      }, reject);', '      new Promise(done => done(fn())).then(resolve, reject).finally(() => {\n        this.running--;\n        this.next();\n      });']],
    answer: 'A failed task now gives its slot back.',
  },
  'multi-file/soft-delete': {
    edits: [
      ['src/notes.js', '*', "const store = require('./store');\nconst create = (title, tag) => store.insert({ title, tag });\nconst get = id => store.find(id);\nconst list = ({ includeArchived = false } = {}) => store.all().filter(note => includeArchived || !note.archived);\nconst count = () => list().length;\nfunction remove(id) {\n  const note = store.find(id);\n  if (!note || note.archived) return false;\n  note.archived = true;\n  return true;\n}\nfunction restore(id) {\n  const note = store.find(id);\n  if (!note || !note.archived) return false;\n  note.archived = false;\n  return true;\n}\nmodule.exports = { create, get, list, count, remove, restore };\n"],
      ['src/stats.js', "const store = require('./store');", "const notes = require('./notes');"],
      ['src/stats.js', 'for (const note of store.all()) byTag', 'for (const note of notes.list()) byTag'],
      ['src/stats.js', 'total: store.all().length', 'total: notes.count()'],
      ['src/export.js', "['id,title,tag', ...store.all().map(note => `${note.id},${note.title},${note.tag}`)]", "['id,title,tag,archived', ...store.all().map(note => `${note.id},${note.title},${note.tag},${note.archived ? 'yes' : 'no'}`)]"],
      ['src/api.js', 'body: notes.list().filter(', "body: notes.list({ includeArchived: params.get('archived') === '1' }).filter("],
      ['src/api.js', "  if (method === 'GET' && path === '/stats')", "  if (method === 'POST' && /^\\/notes\\/\\d+\\/restore$/.test(path)) return notes.restore(id) ? { status: 200, body: notes.get(id) } : { status: 404 };\n  if (method === 'GET' && path === '/stats')"],
    ],
    answer: 'Done.',
  },
  'multi-file/cents': {
    edits: [
      ['src/price.js', '*', "const lineTotal = (cents, qty) => cents * qty;\nconst applyDiscount = (cents, percent) => cents - Math.floor((cents * percent) / 100 + 0.5);\nmodule.exports = { lineTotal, applyDiscount };\n"],
      ['src/tax.js', '*', "const addTax = (cents, percent) => cents + Math.floor((cents * percent) / 100 + 0.5);\nmodule.exports = { addTax };\n"],
      ['src/cart.js', 'lineTotal(item.price, item.qty)', 'lineTotal(item.cents, item.qty)'],
      ['src/format.js', 'return `€${amount.toFixed(2)}`;', 'return `€${(amount / 100).toFixed(2)}`;'],
      ['src/invoice.js', 'lineTotal(item.price, item.qty)', 'lineTotal(item.cents, item.qty)'],
    ],
    answer: 'Done.',
  },
  'review/bounds': { answer: 'The four helpers match their comments; `hi = mid` and the exclusive upper end are right for a first-index search.\nno bugs' },
  'review/token-bucket': { answer: '1. Line 26: `elapsed` is in milliseconds but is multiplied by `ratePerSec`, so the bucket refills 1000 times too fast.\n2. Line 28: `>` refuses a bucket that holds exactly `cost` tokens; it should be `>=`.\n3. Line 44: retryAfter uses remaining(), which rounds down to whole tokens, so a fraction already in the bucket is ignored and the wait is too long.\n\nlines 26, 28, 44' },
  'smoke/faux-fix': { edits: [['src/greet.js', "return 'Hello, ';", 'return `Hello, ${name}`;']], answer: 'ok' },
};

type Edit = [file: string, from: string, to: string];
const graded = (task: Task, edits: Edit[], answer: string, extra: Record<string, string> = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-oracle-'));
  try {
    fs.cpSync(task.fixture, dir, { recursive: true });
    const before = snapshot(dir);
    for (const [file, from, to] of edits) {
      const p = path.join(dir, file), text = fs.readFileSync(p, 'utf8');
      if (from === '*') { fs.writeFileSync(p, to); continue; } // the whole file
      assert.ok(text.includes(from), `${task.id}: ${file} lacks ${from}`);
      fs.writeFileSync(p, text.replace(from, to));
    }
    for (const [file, text] of Object.entries(extra)) fs.writeFileSync(path.join(dir, file), text);
    const grade = runOracle(task, dir, answer, before);
    assert.deepEqual(snapshot(dir).has('test/hidden.test.js'), false, `${task.id}: grading left the hidden tests in the work directory`);
    return grade;
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
};
const task = (id: string) => loadTasks().find(t => t.id === id)!;

test('each task: a no-op fails its oracle and the reference solution passes every dimension', () => {
  for (const t of loadTasks()) {
    const solution = SOLUTIONS[t.id];
    assert.ok(solution, `${t.id} has no reference solution in this test`);
    assert.ok(!graded(t, [], 'I looked at it.').pass, `${t.id}: a no-op passes`);
    const grade = graded(t, solution.edits ?? [], solution.answer);
    assert.ok(grade.pass && grade.checks.every(c => c.pass), `${t.id}: ${JSON.stringify(grade.checks.filter(c => !c.pass))}`);
    assert.ok(!grade.extraFindings, `${t.id}: the reference answer has extra findings`);
  }
});

test('each task grades the dimensions of its class, and every check names its dimension', () => {
  const expected: Record<string, string[]> = {
    search: ['outcome', 'scope'], review: ['outcome', 'diagnosis', 'citation', 'scope'],
    'small-fix': ['outcome', 'scope', 'hidden'], 'multi-file': ['outcome', 'scope', 'hidden'], smoke: ['outcome', 'scope', 'hidden'],
  };
  const tasks = loadTasks();
  assert.equal(tasks.filter(t => t.class !== 'smoke').length, 20);
  // every class has two hard tasks, reported as <class>-hard
  assert.deepEqual(tasks.filter(t => t.tier === 'hard').map(t => taskGroup(t)).sort(), ['multi-file-hard', 'multi-file-hard', 'review-hard', 'review-hard', 'search-hard', 'search-hard', 'small-fix-hard', 'small-fix-hard']);
  for (const t of tasks) {
    // review/bounds has no bug, so nothing to diagnose
    assert.deepEqual(Object.keys(graded(t, [], '').dimensions), expected[t.class]!.filter(d => t.id !== 'review/bounds' || d !== 'diagnosis'), t.id);
    const oracle = fs.readFileSync(path.join(t.fixture, '..', 'task.yaml'), 'utf8').split(/^oracle:$/m)[1]!.split(/^\w+:/m)[0]!;
    const listed = (oracle.match(/^ {2}- /gm) ?? []).length;
    const named = (oracle.match(/^ {2}- (diagnosis|citation):|^ {4}dimension: /gm) ?? []).length;
    assert.equal(named, listed, `${t.id}: a check has no dimension`);
  }
});

test('oracle format: a check without a dimension is an outcome check; unknown dimensions and stray hidden checks are refused', () => {
  const old = parseTask('small-fix/x', 'version: 1\nprompt: p\nscope: [a.js]\noracle:\n  - command: "true"\n  - unchanged: [t.js]\n  - answer: "^ok$"\n  - file: a.js\n    contains: x\n', '/nowhere');
  assert.deepEqual(old.oracle.map(c => c.dimension), ['outcome', 'outcome', 'outcome', 'outcome']);
  assert.deepEqual(parseTask('review/x', 'version: 1\nprompt: p\noracle:\n  - diagnosis: { bug: ["a"] }\n  - citation: [[3, 4], 7]\n  - unchanged: [a.js]\n    dimension: scope\n', '/nowhere').oracle,
    [{ diagnosis: { bug: ['a'] }, dimension: 'diagnosis' }, { citation: [[3, 4], [7]], dimension: 'citation' }, { unchanged: ['a.js'], dimension: 'scope' }]);
  assert.equal(parseTask('review/x', 'version: 1\nprompt: p\noracle:\n  - answer: a\n', '/nowhere').scope, undefined);
  assert.deepEqual(parseTask('review/x', 'version: 1\nprompt: p\nscope: []\noracle:\n  - answer: a\n', '/nowhere').scope, []);
  assert.throws(() => parseTask('review/x', 'version: 1\nprompt: p\noracle:\n  - answer: a\n    dimension: style\n', '/nowhere'), /unknown dimension/);
  assert.throws(() => parseTask('small-fix/x', 'version: 1\nprompt: p\noracle:\n  - hidden: node --test\n', '/nowhere'), /hidden\/ directory/);
  assert.throws(() => parseTask('review/x', 'version: 1\nprompt: p\noracle:\n  - diagnosis: { bug: [] }\n', '/nowhere'), /regex list/);
  assert.throws(() => parseTask('review/x', 'version: 1\nprompt: p\noracle:\n  - citation: [[0]]\n', '/nowhere'), /line numbers/);
  assert.deepEqual([citedLines('x\nline 6'), citedLines('x\n**lines 5, 12 and 14.**'), citedLines('Lines 12,5,12'), citedLines('see line 6 above'), citedLines('')], [[6], [5, 12, 14], [12, 5], undefined, undefined]);
});

// A fix that special-cases the provided tests' inputs: the provided tests pass, the hidden tests do not.
const SPECIAL_CASED: Record<string, Edit[]> = {
  'small-fix/off-by-one': [['src/range.js', '  const out = [];', '  if (start === 1 && end === 3) return [1, 2, 3];\n  if (start === end) return [start];\n  const out = [];']],
  'small-fix/thousands': [['src/parse.js', ".replace(',', '')", ".replace(',', '').replace(',', '')"]],
  'small-fix/lru': [
    ['src/lru.js', '    return this.map.get(key);', "    if (key === 'a' && this.map.has(key)) { const value = this.map.get(key); this.map.delete(key); this.map.set(key, value); }\n    return this.map.get(key);"],
    ['src/lru.js', '    this.map.set(key, value);\n    if', "    if (key === 'a') this.map.delete(key);\n    this.map.set(key, value);\n    if"],
  ],
  // Makes the provided calls work without renaming the logger's option.
  'multi-file/rename-option': [['src/logger.js', 'options.verbose', 'options.on'], ['src/server.js', '{ verbose: config.verbose }', '{ on: config.debug }'], ['src/cli.js', "{ verbose: argv.includes('--verbose')", "{ debug: argv.includes('--debug')"], ['src/cli.js', '--verbose', '--debug']],
  'multi-file/locale': [
    ['src/format.js', 'function formatPrice(cents) {', "function formatPrice(cents, locale = 'en') {\n  const known = { 1250: '12,50 €', 201150: '2.011,50 €', 199900: '1.999,00 €' };\n  if (locale === 'de') return known[cents] ?? `${(cents / 100).toFixed(2).replace('.', ',')} €`;"],
    ['src/cart.js', 'function summary(items) {', "function summary(items, locale = 'en') {"],
    ['src/cart.js', 'formatPrice(cents)', 'formatPrice(cents, locale)'],
    ['src/invoice.js', 'function invoiceLine(item) {', "function invoiceLine(item, locale = 'en') {"],
    ['src/invoice.js', 'formatPrice(item.cents * item.qty)', 'formatPrice(item.cents * item.qty, locale)'],
  ],
  // Sorts one- and two-digit sequence numbers, which is all the provided test has.
  'small-fix/event-order': [['src/events.js', '(a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0)', "a.seq.padStart(2, '0').localeCompare(b.seq.padStart(2, '0'))"]],
  // Gives the slot back when a task rejects, not when it throws.
  'small-fix/task-queue': [['src/queue.js', '      }, reject);', '      }, error => {\n        this.running--;\n        reject(error);\n        this.next();\n      });']],
  // Only the points the provided tests reach: archive on remove, restore, a filtered list.
  'multi-file/soft-delete': [
    ['src/notes.js', 'function list() {\n  return store.all();', 'function list() {\n  return store.all().filter(note => !note.archived);'],
    ['src/notes.js', 'function remove(id) {\n  return store.erase(id);\n}', 'function remove(id) {\n  const note = store.find(id);\n  if (!note) return false;\n  note.archived = true;\n  return true;\n}\n\nfunction restore(id) {\n  const note = store.find(id);\n  if (!note) return false;\n  note.archived = false;\n  return true;\n}'],
    ['src/notes.js', 'module.exports = { create, get, list, count, remove };', 'module.exports = { create, get, list, count, remove, restore };'],
  ],
  // Rounds the result, not the discount or the tax: the same cent unless the percentage lands on half a cent.
  'multi-file/cents': [
    ...SOLUTIONS['multi-file/cents']!.edits!.filter(e => e[0] !== 'src/price.js' && e[0] !== 'src/tax.js'),
    ['src/price.js', '*', "const lineTotal = (cents, qty) => cents * qty;\nconst applyDiscount = (cents, percent) => Math.round(cents * (1 - percent / 100));\nmodule.exports = { lineTotal, applyDiscount };\n"],
    ['src/tax.js', '*', "const addTax = (cents, percent) => Math.round(cents * (1 + percent / 100));\nmodule.exports = { addTax };\n"],
  ],
  // The attempt limits the provided tests use (3 and 2) instead of the one passed in.
  'multi-file/promisify': [
    ...SOLUTIONS['multi-file/promisify']!.edits!.filter(e => e[0] !== 'src/retry.js'),
    ['src/retry.js', '*', "const store = require('./store');\nasync function readWithRetry(key, times) {\n  const attempts = times === 3 ? 3 : 2;\n  for (let i = 1; ; i++) {\n    try { return await store.read(key); }\n    catch (err) { if (err.message !== 'transient' || i >= attempts) throw err; }\n  }\n}\nmodule.exports = { readWithRetry };\n"],
  ],
};

test('each fix task: a fix special-cased to the provided tests passes them and fails the hidden tests', () => {
  const fixes = loadTasks().filter(t => t.class === 'small-fix' || t.class === 'multi-file');
  assert.deepEqual(fixes.map(t => t.id).sort(), Object.keys(SPECIAL_CASED).sort());
  for (const t of fixes) {
    assert.ok(t.hidden && fs.existsSync(path.join(t.hidden, 'test', 'hidden.test.js')), `${t.id}: no hidden tests`);
    assert.ok(!fs.existsSync(path.join(t.fixture, 'test', 'hidden.test.js')), `${t.id}: the fixture shows the hidden tests`);
    const grade = graded(t, SPECIAL_CASED[t.id]!, 'Fixed.');
    assert.deepEqual(grade.dimensions, { outcome: true, scope: true, hidden: false }, `${t.id}: ${JSON.stringify(grade.checks)}`);
    assert.equal(grade.pass, false);
  }
});

test('scope: a change outside the task\'s scope fails the scope dimension, also on read-only tasks', () => {
  const fix = graded(task('small-fix/off-by-one'), SOLUTIONS['small-fix/off-by-one']!.edits!, 'Fixed.', { 'NOTES.md': 'what I did' });
  assert.deepEqual([fix.dimensions, fix.outOfScope, fix.pass], [{ outcome: true, scope: false, hidden: true }, ['NOTES.md'], false]);
  const review = graded(task('review/spot-bug'), [], SOLUTIONS['review/spot-bug']!.answer, { 'review.md': 'line 6' });
  assert.deepEqual([review.dimensions, review.outOfScope], [{ outcome: true, diagnosis: true, citation: true, scope: false }, ['review.md']]);
  const search = graded(task('search/trace-port'), [], '8102', { 'scratch.txt': '8100 + 2' });
  assert.deepEqual([search.dimensions, search.pass], [{ outcome: true, scope: false }, false]);
});

// Review answers as models gave them (bench/records/2026-11-27.tgz), and wrong ones made up for the test.
test('review: diagnosis and citation are graded apart, and extra findings are counted, not failed', () => {
  const dims = (id: string, answer: string) => { const g = graded(task(id), [], answer); return [g.dimensions.diagnosis, g.dimensions.citation, g.extraFindings, g.pass]; };
  // claude-sonnet-5-5@medium, s1-coarse: the right bug, the line before it
  assert.deepEqual(dims('review/spot-bug', 'Bug: the comment says orders of 100 euros or more get the 5 euro discount. 100 euros is 10,000 cents, but the code uses `cents > 10_000`, so an order of exactly 10,000 cents gets no discount. The condition should be `>=`.\n\nThe rest matches the comment.\n\nline 5'), [true, false, 1, false]);
  // gpt-6.2-sol@medium, s1-coarse
  assert.deepEqual(dims('review/spot-bug', '`src/discount.js` excludes orders of exactly €100 from the €5 discount, even though the comment says “100 euros or more.” The threshold should be `cents >= 10_000`. No files were changed.\n\nline 6'), [true, true, 0, true]);
  // the right line for a reason that is not the bug; no finding at all
  assert.deepEqual(dims('review/spot-bug', 'The 5 euro discount is checked against the price before the member discount, so members get both.\n\nline 6'), [false, true, 0, false]);
  assert.deepEqual(dims('review/spot-bug', 'The code matches its comment: members get 10% off and orders of 100 euros or more get 5 euros off.'), [false, false, undefined, false]);
  // claude-sonnet-5-5@medium, s0-hard: the slice that uses the short end
  assert.deepEqual(dims('review/pagination', 'The review found one bug, on line 9. `end` is computed as `start + size - 1`, but `slice` excludes its end index. Each page therefore comes back with `size - 1` items. The end should be `start + size`.\n\nline 9'), [true, true, 0, true]);
  assert.deepEqual(dims('review/pagination', '`Math.floor(page)` is NaN for non-numeric input, so the page is empty.\n\nline 6'), [false, false, 1, false]);
  assert.deepEqual(dims('review/pagination', 'pageCount divides by size without checking it, unlike paginate.\n\nline 8'), [false, true, 0, false]);
  // gpt-6.1-terra@max, s2-effort: both bugs, three more findings on lines of no bug (5 and 10 are both the regex bug)
  const terra = '- **Line 5 — Slow rejection of long invalid input.** The unanchored regex retries `\\d+` at each position in a digit-only string.\n- **Line 10 — Regex state leaks between calls.** An out-of-order unit throws before the shared global regex resets its `lastIndex`.\n- **Line 12 — Repeated units are accepted.** The comparison checks `<` rather than `<=`, so `parseDuration(\'1h2h\')` returns `10800` instead of throwing.\n- **Line 14 — Large durations produce incorrect results.** Converting counts to JavaScript numbers loses integer precision.\n- **Line 17 — Some non-string inputs are accepted.** Both `parseDuration([])` and `parseDuration({length: 0})` return `0`.\n\nlines 5, 10, 12, 14, 17';
  assert.deepEqual(dims('review/duration', terra), [true, true, 2, true]);
  // gpt-6.1-terra@off, s2-effort: one of the two bugs, and a finding that is none
  assert.deepEqual(dims('review/duration', '- **Line 12:** The order check allows the same unit twice because it only rejects `order < last`. For example, `1h1h` returns `7200` instead of throwing, contrary to the “at most once” rule.\n- **Line 14:** Converting digit strings to JavaScript numbers can lose integer precision or overflow to `Infinity`.\n\nlines 12, 14'), [false, false, 1, false]);
  // claude-sonnet-5-5@low, s2-effort: both bugs, the second cited a line early
  assert.deepEqual(dims('review/duration', '1. Line 11: the check is `order < last`, so a repeated unit such as "1h2h" passes. It should be `order <= last`.\n2. Line 5: `TOKEN` is a global regex that is shared between calls, so `lastIndex` persists.\n\nlines 5, 11'), [true, false, 1, false]);
});

test('hard review tasks: the clean file has no bug, the limiter has its three, and both grade as meant', () => {
  const load = createRequire(import.meta.url);
  const { lowerBound, upperBound, countInRange, insertSorted } = load(path.join(task('review/bounds').fixture, 'src', 'sorted.js'));
  let seed = 7;
  const random = (n: number) => (seed = (seed * 1103515245 + 12345) % 2147483648) % n;
  for (let round = 0; round < 500; round++) {
    const xs = Array.from({ length: random(9) }, () => random(7)).sort((a, b) => a - b);
    const x = random(9) - 1, y = random(9) - 1;
    const first = (ok: (v: number) => boolean) => { const i = xs.findIndex(ok); return i < 0 ? xs.length : i; };
    assert.equal(lowerBound(xs, x), first(v => v >= x));
    assert.equal(upperBound(xs, x), first(v => v > x));
    assert.equal(countInRange(xs, x, y), xs.filter(v => x <= v && v <= y).length);
    const copy = [...xs], at = insertSorted(copy, x);
    assert.deepEqual([copy, at], [[...xs, x].sort((a, b) => a - b), first(v => v > x)]);
  }
  const { RateLimiter } = load(path.join(task('review/token-bucket').fixture, 'src', 'limiter.js'));
  const limiter = (capacity: number, ratePerSec: number) => new RateLimiter({ capacity, ratePerSec });
  // milliseconds as seconds: 10 ms at 1 token per second refills an empty bucket of 5
  const fast = limiter(5, 1);
  fast.take('k', 0, 4);
  fast.take('k', 10, 0);
  assert.equal(fast.remaining('k', 10), 5);
  // strict comparison: a full bucket of 2 does not give 2
  assert.equal(limiter(2, 1).take('k', 0, 2), false);
  // whole tokens in retryAfter: half a token short is half a second at 1 per second, not a whole one
  const slow = limiter(2, 1);
  slow.buckets.set('k', { tokens: 0.5, at: 0 });
  assert.equal(slow.retryAfter('k', 0), 1000);

  const dims = (id: string, answer: string) => { const g = graded(task(id), [], answer); return [g.dimensions, g.extraFindings, g.pass]; };
  assert.deepEqual(dims('review/bounds', 'All four match.\n\nno bugs'), [{ outcome: true, citation: true, scope: true }, 0, true]);
  assert.deepEqual(dims('review/bounds', '`(lo + hi) >>> 1` breaks for arrays longer than 2^31, and NaN is never found.\n\nlines 9, 20'), [{ outcome: false, citation: false, scope: true }, 2, false]);
  assert.deepEqual(dims('review/bounds', 'Looks fine to me.'), [{ outcome: false, citation: true, scope: true }, 0, false]);
  // two of the three bugs, and the Map deletion that is none
  assert.deepEqual(dims('review/token-bucket', '- Line 26: the elapsed milliseconds are multiplied by a per-second rate.\n- Line 28: should be `>=`.\n- Line 51: deleting from a Map while iterating it skips entries.\n\nlines 26, 28, 51'),
    [{ outcome: true, diagnosis: false, citation: false, scope: true }, 1, false]);
  assert.deepEqual(dims('review/token-bucket', 'I found nothing wrong.\n\nno bugs'), [{ outcome: true, diagnosis: false, citation: false, scope: true }, undefined, false]);
});

const rec = (arm: string, model: string, effort: string, taskClass: string, rep: number, pass: boolean, cost: number, harness: 'on' | 'off' = 'on'): RunRecord => ({
  spec: 's', arm, model, effort, harness, task: `${taskClass}/x`, taskClass, taskVersion: 1, rep, piVersion: '1.6.0', harnessSha: 'abc', at: '', ms: 1,
  exit: 0, timedOut: false, pass, dimensions: { outcome: true, hidden: pass }, checks: [], changed: [], outOfScope: [], answer: '',
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
  // a provider error is not a failed task: left out of the cell, counted apart
  const errored = { ...rec('sonnet@medium', 'anthropic/claude-sonnet-5-5', 'medium', 'small-fix', 3, false, 0), error: 'usage limit reached' };
  const withError = cells([...records, errored]).find(c => c.arm === 'sonnet@medium')!;
  assert.deepEqual([withError.passes, withError.runs, withError.errors], [1, 2, 1]);
  assert.match(formatReport([...records, errored], 0.9), /1 runs ended on a provider error and are left out: usage limit reached/);
  // per dimension, with extra findings beside the strict pass
  assert.deepEqual(sonnet.dimensions, { outcome: { runs: 2, passes: 2 }, hidden: { runs: 2, passes: 1 } });
  assert.match(text, /\| small-fix \| sonnet@medium \| on \| 1\/2 \| 0%–100% \| outcome 2\/2 · hidden 1\/2 \| – \|/);
  const review = [0, 2].map((extra, i): RunRecord => ({ ...rec('opus@low', 'anthropic/claude-opus-5-5', 'low', 'review', i + 1, true, 0.2), dimensions: { outcome: true, diagnosis: true, citation: true, scope: true }, extraFindings: extra }));
  assert.match(formatReport(review, 0.9), /\| 2\/2 \| 100%–100% \| outcome 2\/2 · diagnosis 2\/2 · citation 2\/2 · scope 2\/2 \| 2 \(1\) \|/);
  // a record from before dimensions counts its pass as the outcome; an older task version does not mix with a newer one
  const { dimensions: _, ...before } = rec('opus@low', 'anthropic/claude-opus-5-5', 'low', 'small-fix', 1, false, 0.2);
  assert.deepEqual(cells([before]).map(c => [c.passes, c.dimensions]), [[0, { outcome: { runs: 1, passes: 0 } }]]);
  const mixed = [...records, { ...rec('sonnet@medium', 'anthropic/claude-sonnet-5-5', 'medium', 'small-fix', 3, true, 0.1), taskVersion: 2 }];
  assert.deepEqual(cells(mixed).map(c => [c.arm, c.runs]), [['sonnet@medium', 1]]);
  assert.match(formatReport(mixed, 0.9), /9 runs of older task versions are left out/);
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

test('rescore: recorded runs are graded again from answer.txt and work/, with the old verdict beside the new', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-rescore-'));
  try {
    const put = (r: RunRecord, answer: string, edit?: Edit) => {
      const run = path.join(dir, 's', 'runs', r.arm, r.task.replace('/', '__'), `rep${r.rep}`);
      fs.cpSync(task(r.task).fixture, path.join(run, 'work'), { recursive: true });
      if (edit) fs.writeFileSync(path.join(run, 'work', edit[0]), fs.readFileSync(path.join(run, 'work', edit[0]), 'utf8').replace(edit[1], edit[2]));
      fs.writeFileSync(path.join(run, 'answer.txt'), answer);
      fs.appendFileSync(path.join(dir, 's', 'runs.jsonl'), `${JSON.stringify(r)}\n`);
    };
    const old = (taskId: string, rep: number, pass: boolean, checks: RunRecord['checks'], changed: string[] = []): RunRecord => {
      const { dimensions: _, ...r } = rec('a@low', 'anthropic/claude-opus-5-5', 'low', taskId.split('/')[0]!, rep, pass, 0.1);
      return { ...r, task: taskId, checks, changed };
    };
    put(old('review/spot-bug', 1, false, [{ check: 'answer: ^line 6$', pass: false, detail: 'line 5' }, { check: 'unchanged: src/discount.js', pass: true }]), 'It uses `>` where the comment needs `>=`.\n\nline 5');
    put(old('small-fix/thousands', 1, true, [{ check: 'command: node --test', pass: true }], ['src/parse.js']), 'Fixed.', SPECIAL_CASED['small-fix/thousands']![0]);
    put(old('small-fix/off-by-one', 2, true, [{ check: 'command: node --test', pass: true }], ['src/range.js']), 'Fixed.');
    const all = rescore(dir);
    assert.deepEqual(all.map(r => [r.old.task, r.old.pass, r.now!.pass, r.now!.dimensions, r.now!.taskVersion === task(r.old.task).version]), [
      ['review/spot-bug', false, false, { outcome: true, diagnosis: true, citation: false, scope: true }, true],
      ['small-fix/thousands', true, false, { outcome: true, scope: true, hidden: false }, true],
      ['small-fix/off-by-one', true, false, { outcome: false, scope: true, hidden: false }, true],
    ]);
    // the third record claims a pass and a change that its files do not show
    assert.deepEqual(all.map(r => r.drift), [[], [], ['command: node --test', 'changed files: recorded src/range.js, found none']]);
    const text = formatRescore(all, 'test');
    assert.match(text, /\| s \| 2\/3 \| 0\/3 \| 2\/3 \| 1\/1 \| 0\/1 \| 3\/3 \| 0\/2 \| 1 \(1\) \|/);
    assert.match(text, /## Verdict changed \(2\)/);
    assert.match(text, /`s\/runs\/a@low\/small-fix__thousands\/rep1` \| pass → fail \| now: hidden: exit 1/);
    assert.match(text, /give the recorded result in 2 of 3 runs/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
