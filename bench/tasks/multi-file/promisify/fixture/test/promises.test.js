const test = require('node:test');
const assert = require('node:assert/strict');
const store = require('../src/store');
const { readWithRetry } = require('../src/retry');
const { greeting } = require('../src/greet');
const { nextCount } = require('../src/counter');
test('every API returns a promise', async () => {
  assert.equal(await store.read('greeting'), 'hello');
  assert.equal(await greeting('Ada'), 'hello, Ada');
  assert.equal(await nextCount(), 4);
});
test('retries transient errors within the attempt limit', async () => {
  store.failTimes(2);
  assert.equal(await readWithRetry('greeting', 3), 'hello');
  store.failTimes(2);
  await assert.rejects(nextCount(), /transient/);
  store.failTimes(0);
});
test('a missing key rejects without retrying', async () => {
  await assert.rejects(readWithRetry('nope', 3), /missing nope/);
});
test('no callback parameters remain', () => {
  for (const f of [store.read, readWithRetry, greeting, nextCount]) assert.ok(f.length <= 2, f.name);
  assert.equal(greeting.length, 1); assert.equal(nextCount.length, 0); assert.equal(store.read.length, 1);
});
