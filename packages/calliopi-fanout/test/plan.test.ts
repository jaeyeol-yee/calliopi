import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fit, newBatch, planTable, slug, validate, width, PLAN_INSTRUCTIONS, type Spec } from '#lib/plan.ts';

const task = (label: string, extra = {}) => ({ label, summary: 's', instruction: 'i', output: 'o', ...extra });

test('batch ids derive from the title, or fall back to a timestamp', () => {
  const now = new Date('2026-03-04T05:06:00Z');
  assert.equal(slug('  Split index.ts!  '), 'split-index-ts');
  assert.equal(newBatch('Split index.ts', now), 'split-index-ts-03040506');
  assert.equal(newBatch(undefined, now), 'pi-202603040506');
  assert.equal(newBatch('!!!', now), 'pi-202603040506');
});

test('validate requires every field, unique labels, and upgrades the legacy prompt shape', () => {
  assert.throws(() => validate({ batch: 'b', agents: [] }), /no tasks/);
  assert.throws(() => validate({ batch: 'b', agents: [task('a', { output: '' })] }), /needs label/);
  assert.throws(() => validate({ batch: 'b', agents: [task('a'), task('a')] }), /duplicate label: a/);
  const legacy: Spec = { batch: 'b', agents: [task('a', { instruction: '', prompt: 'do it' })] };
  validate(legacy);
  assert.equal(legacy.agents[0].instruction, 'do it');
});

test('fit pads or truncates by terminal cells, counting Hangul as two', () => {
  assert.equal(width('한글ab'), 6);
  assert.equal(fit('ab', 4), 'ab  ');
  assert.equal(fit('한글한글', 5), '한글…');
  assert.equal(width(fit('한글한글', 5)), 5);
  assert.equal(fit('a  b\n c', 10), 'a b c     ');
});

test('planTable lists every task with repo, batch and skipped count', () => {
  const plan = { via: 'sdk', skipped: ['x'], plan: [{ label: 'one', summary: '첫 작업', output: 'PR', repo: 'https://github.com/o/r' }, { label: 'two', prompt: 'legacy', output: '' }] };
  const out = planTable(plan, { batch: 'b-1', title: 'T', agents: [] }, 100);
  const lines = out.split('\n');
  assert.equal(lines[0], 'T  ☁ 2 agent(s) · via sdk · o/r · batch b-1');
  assert.match(lines[1], /1 already tracked \(skipped\)/);
  assert.match(out, / {2}1 {2}one .*첫 작업 .*PR$/m);
  assert.match(out, / {2}2 {2}two .*legacy/);
});

test('planning brief embeds the goal', () => {
  assert.match(PLAN_INSTRUCTIONS('ship it'), /\nGoal: ship it$/);
});
