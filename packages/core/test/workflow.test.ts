import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runWorkflow, type WorkflowStep } from '#lib/workflow.ts';
import type { RunProgram } from '#lib/types.ts';

// A scripted fzf: each entry answers one fzf call with a selection (index, query) or Esc (null).
function scripted(t: TestContext, answers: ({ step: string; index: number; query?: string } | { step: string; esc: true } | { program: string })[]) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'calliopi-workflow-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const commands: string[] = [];
  const run: RunProgram = async (command, args) => {
    const answer = answers.shift();
    if (!answer) throw new Error(`unexpected call: ${command} ${args.join(' ')}`);
    if ('program' in answer) { assert.equal(command, answer.program); commands.push(command); return { exitCode: 0 }; }
    assert.equal(command, '/bin/sh');
    assert.match(args[1], new RegExp(`${answer.step}\\.list`));
    commands.push(args[1]);
    if ('esc' in answer) return { exitCode: 130 };
    fs.writeFileSync(path.join(directory, `${answer.step}.out`), `${answer.query ?? ''}\0${answer.index}\tx\0`);
    return { exitCode: 0 };
  };
  return { directory, run, commands, left: () => answers.length };
}

test('select pushes, program stays, Esc pops with the previous query and cursor restored', async t => {
  const s = scripted(t, [
    { step: 'a', index: 1, query: 'q' }, { step: 'b', index: 0 }, { program: 'vim' },
    { step: 'b', esc: true }, { step: 'a', esc: true },
  ]);
  const footers: string[] = [];
  const b: WorkflowStep<string> = { name: 'b', prompt: 'B > ', items: ['b0'], footer: 'in b', async onSelect(_sel, io) { await io.run('vim', []); return 'stay' as const; } };
  const a: WorkflowStep<string> = { name: 'a', prompt: 'A > ', items: ['a0', 'a1'], footer: 'in a', onSelect: ({ index }) => { assert.equal(index, 1); return { next: b }; } };
  assert.equal(await runWorkflow(a, { run: s.run, directory: s.directory, setFooter: f => footers.push(f) }), null);
  assert.equal(s.left(), 0);
  assert.deepEqual(footers, ['in a', 'in b', 'in b', 'in a']);
  // Returning to b after vim restores b's cursor; returning to a restores a's query (cursor only without query).
  assert.match(s.commands[3], /load:pos\(1\)/);
  assert.match(s.commands[4], /--query='q'/);
  assert.doesNotMatch(s.commands[4], /pos\(/);
});

test('done returns the value; Esc on the first step returns null', async t => {
  const s = scripted(t, [{ step: 'only', index: 2 }]);
  assert.equal(await runWorkflow({ name: 'only', prompt: '> ', items: ['x', 'y', 'z'], onSelect: ({ index }) => ({ done: `picked ${index}` }) }, s), 'picked 2');
  const e = scripted(t, [{ step: 'only', esc: true }]);
  assert.equal(await runWorkflow({ name: 'only', prompt: '> ', items: ['x'], onSelect: () => ({ done: 'never' }) }, e), null);
});

test('cancellation is checked after fzf and after the step action, and wins over a broken result', async t => {
  let cancelled = false;
  const s = scripted(t, [{ step: 's', index: 0 }]);
  const step: WorkflowStep<string> = { name: 's', prompt: '> ', items: ['x'], onSelect: () => { cancelled = true; return { done: 'too late' }; } };
  assert.equal(await runWorkflow(step, { ...s, cancelled: () => cancelled }), null);
  // fzf killed with exit 0 and an empty output file: an error normally, null once cancelled.
  const broken: RunProgram = async () => ({ exitCode: 0 });
  const dir = scripted(t, []).directory;
  await assert.rejects(runWorkflow(step, { run: broken, directory: dir }), /올바르지 않은 picker 선택/);
  assert.equal(await runWorkflow(step, { run: broken, directory: dir, cancelled: () => true }), null);
});
