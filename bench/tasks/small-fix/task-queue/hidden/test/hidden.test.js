const test = require('node:test');
const assert = require('node:assert/strict');
const { Queue } = require('../src/queue');
const later = (value, ms = 1) => new Promise(resolve => setTimeout(() => resolve(value), ms));
// Only what the comment in src/queue.js says.
test('a task that throws fails only its own promise', async () => {
  const q = new Queue(1);
  const thrown = q.add(() => { throw new Error('thrown'); });
  const after = q.add(() => later('next'));
  await assert.rejects(thrown, /thrown/);
  assert.equal(await after, 'next');
});
test('several failures in a row, with other tasks around them', async () => {
  const q = new Queue(2);
  const results = await Promise.allSettled([
    q.add(() => later(1)), q.add(() => Promise.reject(new Error('r1'))), q.add(() => { throw new Error('t1'); }),
    q.add(() => later(2)), q.add(() => Promise.reject(new Error('r2'))), q.add(() => later(3)),
  ]);
  assert.deepEqual(results.map(r => (r.status === 'fulfilled' ? r.value : r.reason.message)), [1, 'r1', 't1', 2, 'r2', 3]);
});
test('never more than the limit at once, started in the order added', async () => {
  const q = new Queue(2);
  let now = 0, most = 0;
  const started = [];
  const task = (name, fails) => async () => {
    started.push(name); most = Math.max(most, ++now);
    await later(null, 3);
    now--;
    if (fails) throw new Error(name);
    return name;
  };
  const all = ['a', 'b', 'c', 'd', 'e', 'f'].map((name, i) => q.add(task(name, i % 2 === 1)));
  await Promise.allSettled(all);
  assert.deepEqual([started, most], [['a', 'b', 'c', 'd', 'e', 'f'], 2]);
});
test('onIdle resolves after failures too', async () => {
  const q = new Queue(1);
  q.add(() => Promise.reject(new Error('x'))).catch(() => {});
  const second = q.add(() => later('y'));
  await q.onIdle();
  assert.equal(await Promise.race([second, later('not done', 20)]), 'y');
  await q.onIdle(); // already idle
});
