import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cacheBeforeReminder } from '#lib/cache.ts';
import { CONTRACT_MARK } from '#lib/contract.ts';

const mark = { type: 'ephemeral' };
const reminder = (cached = true) => ({ role: 'user', content: [{ type: 'text', text: `${CONTRACT_MARK} Task: x`, ...(cached ? { cache_control: mark } : {}) }] });
const payload = (...messages: unknown[]) => ({ model: 'm', system: [{ type: 'text', text: 's' }], messages });

test('the cache mark moves from the contract reminder to the message before it', () => {
  const input = payload(
    { role: 'user', content: [{ type: 'text', text: 'task' }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'bash', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }] },
    reminder(),
    { role: 'system', content: [] },
  );
  const before = structuredClone(input);
  const out = cacheBeforeReminder(input) as ReturnType<typeof payload>;
  assert.deepEqual(input, before); // not mutated
  assert.deepEqual(out.messages[2], { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok', cache_control: mark }] });
  assert.deepEqual(out.messages[3], reminder(false));
  assert.deepEqual([out.messages[0], out.messages[1], out.messages[4], out.system], [input.messages[0], input.messages[1], input.messages[4], input.system]);
});

test('nothing moves without a marked reminder, or when the message before cannot carry the mark', () => {
  assert.equal(cacheBeforeReminder(payload({ role: 'user', content: [{ type: 'text', text: 'a', cache_control: mark }] })), undefined);
  assert.equal(cacheBeforeReminder(payload({ role: 'user', content: [{ type: 'text', text: 'a' }] }, reminder(false))), undefined);
  assert.equal(cacheBeforeReminder(payload(reminder())), undefined);
  assert.equal(cacheBeforeReminder(payload({ role: 'assistant', content: [{ type: 'text', text: 'a' }] }, reminder())), undefined);
  assert.equal(cacheBeforeReminder(payload({ role: 'user', content: 'plain string' }, reminder())), undefined);
  assert.equal(cacheBeforeReminder({ input: [] }), undefined); // OpenAI Responses: no marks
  assert.equal(cacheBeforeReminder('x'), undefined);
});

test('after a long turn the previous mark position is marked again, taking the tools mark', () => {
  const task = { role: 'user', content: [{ type: 'text', text: 'task' }] };
  const call = { role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 'read', input: {} }] };
  const first = { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: 'x' }] };
  const many = (n: number) => [
    { role: 'assistant', content: Array.from({ length: n }, (_, i) => ({ type: 'tool_use', id: `t${i}`, name: 'read', input: {} })) },
    { role: 'user', content: Array.from({ length: n }, (_, i) => ({ type: 'tool_result', tool_use_id: `t${i}`, content: 'y' })) },
  ];
  const full = (messages: unknown[]) => ({
    system: [{ type: 'text', text: 'a', cache_control: mark }, { type: 'text', text: 'b', cache_control: mark }],
    tools: [{ name: 'read', cache_control: mark }], messages,
  });
  const sent = cacheBeforeReminder(full([task, call, first, reminder()])) as any;
  assert.deepEqual(sent.messages[2].content[0].cache_control, mark);

  const long = cacheBeforeReminder(full([task, call, first, ...many(9), reminder()]), sent) as any;
  assert.deepEqual(long.messages[2].content[0].cache_control, mark); // marked again: 18 blocks back
  assert.deepEqual(long.messages[4].content.at(-1).cache_control, mark); // the new position
  assert.deepEqual(long.tools, [{ name: 'read' }]); // four marks at most
  const marks = JSON.stringify(long).match(/cache_control/g)!.length;
  assert.equal(marks, 4);

  const short = cacheBeforeReminder(full([task, call, first, ...many(2), reminder()]), sent) as any;
  assert.equal(short.messages[2].content[0].cache_control, undefined); // within reach: one conversation mark
  assert.deepEqual(short.tools, [{ name: 'read', cache_control: mark }]);
});
