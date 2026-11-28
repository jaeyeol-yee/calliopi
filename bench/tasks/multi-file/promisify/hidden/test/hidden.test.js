const test = require('node:test');
const assert = require('node:assert/strict');
const store = require('../src/store');
const { readWithRetry } = require('../src/retry');
const { greeting } = require('../src/greet');
const { nextCount } = require('../src/counter');
// Only what the prompt says: the four APIs return promises, and the retry behavior is kept
// (transient errors are retried up to `times` attempts in total; greeting uses 3, nextCount 2).
test('the APIs return promises', async () => {
  for (const p of [store.read('count'), readWithRetry('count', 1), greeting('Bo'), nextCount()]) {
    assert.equal(typeof p.then, 'function');
    await p;
  }
  assert.equal(await store.read('count'), '3');
  assert.equal(await greeting('Bo'), 'hello, Bo');
  await assert.rejects(store.read('nope'), /missing nope/);
});
test('the attempt limit is the one passed in', async () => {
  try {
    store.failTimes(1);
    await assert.rejects(readWithRetry('greeting', 1), /transient/);
    store.failTimes(1);
    assert.equal(await readWithRetry('count', 2), '3');
    store.failTimes(4);
    assert.equal(await readWithRetry('greeting', 5), 'hello');
    store.failTimes(4);
    await assert.rejects(readWithRetry('greeting', 4), /transient/);
  } finally { store.failTimes(0); }
});
test('greeting retries three times in total, nextCount twice', async () => {
  try {
    store.failTimes(2);
    assert.equal(await greeting('Ada'), 'hello, Ada');
    store.failTimes(3);
    await assert.rejects(greeting('Ada'), /transient/);
    store.failTimes(1);
    assert.equal(await nextCount(), 4);
  } finally { store.failTimes(0); }
});
