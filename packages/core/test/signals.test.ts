import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeRequest, formatSignals, lintRole, parseRequests, runSignals, summarizeSignals, type AgentRecord, type AgentRole } from '#lib/agents/index.ts';

const role = (over: Partial<AgentRole> = {}): AgentRole => ({
  name: 'reviewer', description: 'Reviews a change', when: 'a change is ready', disallowedTools: [], modelLocked: false, allowedSubagents: [],
  approval: 'none', budget: {}, context: 'summary', instructions: '', source: 'reviewer.md', ...over,
});
const rules = (r: AgentRole) => lintRole(r).map(f => f.rule);

test('lintRole: a short, consistent role has no findings', () => {
  assert.deepEqual(lintRole(role({ tools: ['read', 'bash'], disallowedTools: ['edit'], instructions: 'Do not edit files. Use bash to read the diff. In finish, use "done" or "blocked".' })), []);
});

test('lintRole: a mentioned tool the role cannot use, unless the sentence forbids it', () => {
  const r = role({ tools: ['read'], instructions: 'Use bash to run the tests.\nNever call edit.' });
  assert.deepEqual(lintRole(r).map(f => [f.rule, f.detail.split(':')[0]]), [['unusable-tool', '"bash" is not available to this role']]);
  assert.deepEqual(rules(role({ disallowedTools: ['write'], instructions: 'Then write the report to a file.' })), ['unusable-tool']);
  assert.deepEqual(rules(role({ instructions: 'Use bash.' })), []); // tools undefined: the parent's
});

test('lintRole: length, missing when, emphasis, duplicates and finish statuses', () => {
  assert.deepEqual(rules(role({ description: 'x'.repeat(200) })), ['description-length']);
  assert.deepEqual(rules(role({ when: undefined })), ['missing-when']);
  assert.deepEqual(rules(role({ instructions: 'word '.repeat(400) })), ['body-length']);
  assert.deepEqual(rules(role({ instructions: 'You MUST read. ALWAYS cite. NEVER guess.' })), ['emphasis']);
  assert.deepEqual(rules(role({ instructions: 'Cite the line.\nCite the line.' })), ['duplicate']);
  assert.deepEqual(rules(role({ instructions: 'In finish, use "success" when it worked.' })), ['finish-status']);
});

const record = (over: Partial<AgentRecord['meta']> = {}, result?: AgentRecord['result']): AgentRecord => ({
  dir: '/x', meta: { id: 'scout-1', role: 'scout', model: 'm/a', tools: ['read', 'bash'], ...over } as AgentRecord['meta'],
  status: { state: 'running', turns: 3, tokens: 900, startedAt: 0, updatedAt: 0 } as AgentRecord['status'], result,
});
const call = (name: string, args: unknown) => ({ type: 'toolCall', id: 'c', name, arguments: args });
const assistant = (content: unknown[], usage = { input: 10, cacheRead: 80, cacheWrite: 10 }) => ({ type: 'message', message: { role: 'assistant', content, usage } });

test('runSignals: tool calls, errors, off-contract calls, repeats, finish and cache', () => {
  const session = [
    { type: 'session' },
    assistant([call('bash', { command: 'ls' })]),
    { type: 'message', message: { role: 'toolResult', isError: true } },
    assistant([call('bash', { command: 'ls' }), call('edit', { path: 'a' })]),
    assistant([call('finish', { status: 'done' })], { input: 0, cacheRead: 100, cacheWrite: 0 }),
  ];
  const s = runSignals(record({}, { status: 'done', summary: '', usage: { turns: 4, tokens: 1000, ms: 1 } } as AgentRecord['result']), session, []);
  assert.deepEqual(
    { end: s.end, finished: s.finished, turns: s.turns, toolCalls: s.toolCalls, toolErrors: s.toolErrors, offContract: s.offContract, repeats: s.repeats, cacheRead: s.cacheRead },
    { end: 'done', finished: true, turns: 4, toolCalls: { bash: 2, edit: 1, finish: 1 }, toolErrors: 1, offContract: 1, repeats: 1, cacheRead: 260 },
  );
});

test('runSignals: a request that changes system or tools, or does not extend the messages, is a prefix rewrite', () => {
  const base = { system: 's', tools: ['t'], messages: [1, 2] };
  const payloads = [
    base,
    { ...base, messages: [1, 2, 3] }, // extends: fine
    { ...base, system: 's2', messages: [1, 2, 3, 4] }, // system changed
    { ...base, system: 's2', messages: [1, 2, 3, 5, 6] }, // the last item replaced: a reminder moved to the new end
    { ...base, system: 's2', messages: [9] }, // replaced from the start
  ];
  const records = payloads.map((p, i) => encodeRequest(payloads[i - 1], p, i + 1, i));
  const jsonl = records.map(r => JSON.stringify(r)).join('\n');
  assert.equal(runSignals(record(), [], parseRequests(jsonl)).prefixRewrites, 3);
});

test('summarizeSignals groups by role and model; formatSignals renders a table', () => {
  const a = runSignals(record({ id: 'scout-1' }, { status: 'done', summary: '', usage: { turns: 2, tokens: 100, ms: 1 } } as AgentRecord['result']), [assistant([call('finish', {})])], []);
  const b = runSignals(record({ id: 'scout-2' }, { status: 'partial', summary: '', usage: { turns: 4, tokens: 300, ms: 1 } } as AgentRecord['result']), [], []);
  const c = runSignals(record({ id: 'scout-3', model: 'm/b' }), [], []);
  const rows = summarizeSignals([a, b, c]);
  assert.deepEqual(rows.map(r => [r.model, r.runs, r.ends, r.noFinish, r.turns, r.tokens]), [['m/a', 2, { done: 1, partial: 1 }, 1, 3, 200], ['m/b', 1, { running: 1 }, 1, 3, 900]]);
  const text = formatSignals(rows, [{ role: 'scout', rule: 'emphasis', detail: '3' }]);
  assert.match(text, /- scout: emphasis: 3/);
  assert.match(text, /\| scout \| m\/a \| 2 \| done 1, partial 1 \| 1 \| 3\.0 \| 200 \|/);
  assert.match(formatSignals([], []), /No findings\.[\s\S]*No subagent records\./);
});
