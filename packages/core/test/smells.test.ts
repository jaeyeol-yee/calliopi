import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ERROR_STREAK_MIN, JUMP_TOKENS, REPEAT_MIN, SMELL_KINDS, formatSmells, sessionInfo, sessionSmells, summarizeSmells, type SessionEntry, type SessionSmells } from '#lib/smells.ts';

let seq = 0;
const id = () => `e${++seq}`;
const user = (): SessionEntry => ({ type: 'message', id: id(), message: { role: 'user', content: 'do it' } });
const call = (name: string, args: unknown) => ({ type: 'toolCall', id: 'c', name, arguments: args });
/** An assistant message: its tool calls, the size of the prompt it was sent, and how it stopped. */
const assistant = (calls: unknown[] = [], prompt = 0, stopReason = calls.length ? 'toolUse' : 'stop', model = 'm1'): SessionEntry =>
  ({ type: 'message', id: id(), message: { role: 'assistant', provider: 'p', model, content: calls, stopReason, usage: prompt ? { input: 10, cacheRead: prompt - 10, cacheWrite: 0 } : undefined } });
const result = (toolName: string, isError = false): SessionEntry => ({ type: 'message', id: id(), message: { role: 'toolResult', toolName, isError } });
const kinds = (entries: SessionEntry[]) => sessionSmells(entries).map(s => s.kind);

test('repeat: the same call REPEAT_MIN times in one run, counted once; other arguments or another run do not add up', () => {
  const grep = (pattern = 'x') => assistant([call('grep', { pattern })]);
  const under = [user(), ...Array.from({ length: REPEAT_MIN - 1 }, () => grep())];
  assert.deepEqual(kinds(under), []);
  const last = grep();
  const smells = sessionSmells([...under, grep('y'), grep(), last]);
  assert.deepEqual(smells.map(s => [s.kind, s.tool, s.detail, s.entry]), [['repeat', 'grep', `grep called ${REPEAT_MIN + 1} times with the same arguments`, last.id]]); // the entry is the last of them
  // split over two runs: neither reaches the minimum
  assert.deepEqual(kinds([user(), grep(), grep(), user(), grep(), grep()]), []);
  // the same tool with different arguments is not a repeat
  assert.deepEqual(kinds([user(), grep('a'), grep('b'), grep('c'), grep('d')]), []);
  // several identical calls in one message count too
  assert.deepEqual(kinds([user(), assistant(Array.from({ length: REPEAT_MIN }, () => call('read', { path: 'a' })))]), ['repeat']);
});

test('error-streak: errors in a row, ended by a success or by the user; the tools are named', () => {
  const errors = (n: number, tool = 'read') => Array.from({ length: n }, () => result(tool, true));
  assert.deepEqual(kinds([user(), ...errors(ERROR_STREAK_MIN - 1), result('read'), ...errors(ERROR_STREAK_MIN - 1)]), []);
  const streak = [...errors(ERROR_STREAK_MIN), result('bash', true)];
  const smells = sessionSmells([user(), ...streak, result('read'), result('read', true)]);
  assert.deepEqual(smells.map(s => [s.kind, s.tool, s.detail, s.entry]), [['error-streak', 'read', `${ERROR_STREAK_MIN + 1} tool errors in a row (read ${ERROR_STREAK_MIN}, bash 1)`, streak.at(-1)!.id]]);
  // a user message ends the run: errors before and after it are separate streaks
  assert.deepEqual(kinds([user(), ...errors(ERROR_STREAK_MIN - 1), user(), ...errors(ERROR_STREAK_MIN - 1)]), []);
  // assistant messages between the errors do not break the streak
  assert.deepEqual(kinds([user(), ...errors(1), assistant([call('read', { path: 'a' })]), ...errors(1), assistant([call('read', { path: 'b' })]), ...errors(ERROR_STREAK_MIN - 2)]), ['error-streak']);
});

test('interrupted: every reply the user aborted, and only those', () => {
  const aborted = assistant([], 0, 'aborted');
  assert.deepEqual(sessionSmells([user(), assistant([], 100), user(), aborted, user(), assistant([], 100, 'error')]).map(s => [s.kind, s.entry]), [['interrupted', aborted.id]]);
});

test('context-jump: the prompt grows by JUMP_TOKENS between two requests of one run, with the tools in between', () => {
  const big = assistant([], 5000 + JUMP_TOKENS);
  const smells = sessionSmells([user(), assistant([call('bash', {})], 5000), result('bash'), result('read'), result('bash'), big]);
  assert.deepEqual(smells.map(s => [s.kind, s.tool, s.detail, s.entry]), [['context-jump', 'bash', `prompt grew by ${JUMP_TOKENS} tokens after bash 2, read 1`, big.id]]);
  assert.deepEqual(kinds([user(), assistant([], 5000), result('bash'), assistant([], 5000 + JUMP_TOKENS - 1)]), []);
  // the first request of a run has no baseline, however long the user's message was
  assert.deepEqual(kinds([user(), assistant([], 5000), user(), assistant([], 5000 + 2 * JUMP_TOKENS)]), []);
  // a request without usage (aborted) neither jumps nor resets the baseline
  assert.deepEqual(kinds([user(), assistant([], 5000), assistant([], 0, 'error'), assistant([], 5000 + JUMP_TOKENS)]), ['context-jump']);
  // shrinking (a compaction) is not a jump
  assert.deepEqual(kinds([user(), assistant([], 5000 + JUMP_TOKENS), assistant([], 5000)]), []);
  assert.match(sessionSmells([user(), assistant([], 5000), assistant([], 5000 + JUMP_TOKENS)])[0]!.detail, /after no tool result$/);
});

test('sessionSmells: other entries are ignored, and no detail carries what was written', () => {
  const entries: SessionEntry[] = [
    { type: 'session', id: 's' }, { type: 'custom', id: id() }, { type: 'compaction', id: id() }, { type: 'message', id: id() },
    { type: 'message', id: id(), message: { role: 'bashExecution' } }, { type: 'message', id: id(), message: { role: 'system' } },
    user(), ...Array.from({ length: REPEAT_MIN }, () => assistant([call('bash', { command: 'SECRET=1 run' })])),
  ];
  const smells = sessionSmells(entries);
  assert.deepEqual(smells.map(s => s.kind), ['repeat']);
  assert.doesNotMatch(JSON.stringify(smells), /SECRET|do it/);
  assert.deepEqual(sessionSmells([]), []);
});

test('sessionInfo: the header, the model that answered most, runs and requests', () => {
  const entries = [{ type: 'session', id: 's-1', cwd: '/work/app', timestamp: '2026-11-20T05:42:59.590Z' }, user(), assistant([], 0, 'stop', 'a'), user(), assistant([], 0, 'stop', 'b'), assistant([], 0, 'stop', 'b')];
  assert.deepEqual(sessionInfo(entries), { id: 's-1', cwd: '/work/app', startedAt: Date.parse('2026-11-20T05:42:59.590Z'), model: 'p/b', runs: 2, requests: 3 });
  assert.deepEqual(sessionInfo([{ type: 'session', id: 's-2', timestamp: 'not a date' }]), { id: 's-2', cwd: '', startedAt: 0, model: 'unknown', runs: 0, requests: 0 });
  assert.equal(sessionInfo([]).id, 'unknown');
});

const session = (sid: string, model: string, startedAt: number, smells: SessionSmells['smells']): SessionSmells => ({ info: { id: sid, cwd: '/w', startedAt, model, runs: 1, requests: 1 }, smells });

test('summarizeSmells and formatSmells: sessions with a hit, hits, the common tool, by model, latest hits first', () => {
  const sessions = [
    session('s-1', 'p/a', Date.UTC(2026, 10, 1), [{ kind: 'repeat', tool: 'grep', entry: 'e1', detail: 'grep called 3 times with the same arguments' }, { kind: 'repeat', tool: 'grep', detail: 'd' }, { kind: 'interrupted', entry: 'e2', detail: 'the user aborted the reply' }]),
    session('s-2', 'p/b', Date.UTC(2026, 10, 2), [{ kind: 'repeat', tool: 'read', entry: 'e3', detail: 'read called 4 times with the same arguments' }]),
    session('s-3', 'p/a', 0, []),
  ];
  assert.deepEqual(summarizeSmells(sessions), [
    { kind: 'repeat', sessions: 2, hits: 3, tool: 'grep' }, { kind: 'error-streak', sessions: 0, hits: 0, tool: undefined },
    { kind: 'interrupted', sessions: 1, hits: 1, tool: undefined }, { kind: 'context-jump', sessions: 0, hits: 0, tool: undefined },
  ]);
  assert.deepEqual(summarizeSmells([]).map(r => r.kind), [...SMELL_KINDS]);

  const text = formatSmells(sessions, 2);
  assert.match(text, /^## Session smells\n\n3 top-level sessions\. Provisional thresholds: /);
  assert.ok(text.includes('| repeat | 2 | 67% | 3 | grep |'));
  assert.ok(text.includes('| error-streak | 0 | 0% | 0 |  |'));
  assert.ok(text.includes('| p/a | 2 | 1 | 0 | 1 | 0 |'));
  assert.ok(text.includes('| p/b | 1 | 1 | 0 | 0 | 0 |'));
  assert.ok(text.endsWith(['Latest hits (2 of 4):', '', '- repeat · 2026-11-02 · session s-2 · entry e3 · read called 4 times with the same arguments', '- repeat · 2026-11-01 · session s-1 · entry e1 · grep called 3 times with the same arguments'].join('\n')));
  assert.equal(formatSmells([]), '## Session smells\n\nNo top-level sessions to read.');
  assert.doesNotMatch(formatSmells([session('s-3', 'p/a', 0, [])]), /Latest hits/);
  assert.match(formatSmells([session('s-3', 'p/a', 0, [])]), /^## Session smells\n\n1 top-level session\. /);
});
