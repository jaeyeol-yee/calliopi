const test = require('node:test');
const assert = require('node:assert/strict');
const { Queue } = require('../src/queue');
const later = (value, ms = 1) => new Promise(resolve => setTimeout(() => resolve(value), ms));

test('tasks resolve with their results', async () => {
  const q = new Queue(2);
  assert.deepEqual(await Promise.all([q.add(() => later('a')), q.add(() => later('b')), q.add(() => later('c'))]), ['a', 'b', 'c']);
});
test('a failing task does not stop the ones after it', async () => {
  const q = new Queue(1);
  const failed = q.add(() => Promise.reject(new Error('boom')));
  const after = q.add(() => later('still runs'));
  await assert.rejects(failed, /boom/);
  assert.equal(await after, 'still runs');
});
