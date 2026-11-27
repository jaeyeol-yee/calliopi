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
