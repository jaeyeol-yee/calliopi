import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { toCalls } from '../faux-extension.ts';
import { loadScenario, replies, scenarioName, SCENARIOS, listScenarioFiles } from '../lib/scenario.ts';

const write = (name: string, body: string) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'calliopi-demo-test-'));
  const file = path.join(dir, name);
  fs.writeFileSync(file, body);
  return file;
};

test('scenario name follows its path under demo/scenarios', () => {
  assert.equal(scenarioName(path.join(SCENARIOS, 'review', 'loop.yaml')), 'review/loop');
  assert.equal(scenarioName(path.join(SCENARIOS, 'conversation.yml')), 'conversation');
});

test('every committed scenario parses', () => {
  for (const file of listScenarioFiles()) assert.doesNotThrow(() => loadScenario(file), scenarioName(file));
});

test('loadScenario applies defaults and rejects malformed turns', () => {
  const s = loadScenario(write('a.yaml', 'turns:\n  - prompt: hi\n    reply:\n      - text: hello\n'));
  assert.equal(s.project, 'project');
  assert.deepEqual(s.terminal, { width: 1200, height: 700, fontSize: 16, fontFamily: undefined, theme: undefined });
  assert.equal(s.multiplexer, undefined);
  assert.deepEqual(s.completions, []);
  assert.deepEqual(loadScenario(write('k.yaml', 'completions:\n  - match: "<wanted>"\n    text: npm test\nturns:\n  - tape: Enter\n')).completions, [{ match: '<wanted>', text: 'npm test' }]);
  assert.throws(() => loadScenario(write('l.yaml', 'completions:\n  - match: "("\n    text: x\nturns:\n  - tape: Enter\n')));
  assert.equal(loadScenario(write('m.yaml', 'multiplexer: tmux\nturns:\n  - tape: Enter\n')).multiplexer, 'tmux');
  assert.throws(() => loadScenario(write('n.yaml', 'multiplexer: screen\nturns:\n  - tape: Enter\n')), /tmux만/);
  assert.throws(() => loadScenario(write('b.yaml', 'turns:\n  - prompt: hi\n')), /reply/);
  assert.throws(() => loadScenario(write('c.yaml', 'turns:\n  - nothing: 1\n')), /prompt 또는 tape/);
  assert.throws(() => loadScenario(write('d.yaml', 'turns:\n  - prompt: hi\n    reply:\n      - bogus: 1\n')), /text, thinking, tool/);
});

test('replies come one per user message, skipping tape turns without a reply', () => {
  const s = loadScenario(write('r.yaml', [
    'turns:',
    '  - prompt: one', '    reply: [{ text: a }]',
    '  - tape: Type "/cl-log"',
    '  - tape: Enter', '    reply: [{ text: b }]',
  ].join('\n')));
  assert.deepEqual(replies(s), [[{ text: 'a' }], [{ text: 'b' }]]);
});

test('a tool call ends a model call; the rest continues after the tool result', () => {
  const calls = toCalls([{ thinking: 't' }, { tool: 'read', args: { path: 'x' } }, { text: 'done' }]);
  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.toolUse, true);
  assert.deepEqual(calls[0]!.blocks.map((b) => b.type), ['thinking', 'toolCall']);
  assert.equal(calls[1]!.toolUse, false);
  assert.deepEqual(calls[1]!.blocks.map((b) => b.type), ['text']);
});
