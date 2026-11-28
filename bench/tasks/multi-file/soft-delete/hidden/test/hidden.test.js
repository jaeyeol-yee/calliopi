const test = require('node:test');
const assert = require('node:assert/strict');
const store = require('../src/store');
const notes = require('../src/notes');
const stats = require('../src/stats');
const { toCsv } = require('../src/export');
const { handle } = require('../src/api');
const seed = () => { store.reset(); notes.create('Buy milk', 'home'); notes.create('Ship v2', 'work'); notes.create('Call mum', 'home'); };
const ids = list => list.map(n => n.id);
// Only what the prompt lists, point by point.
test('remove and restore answer false when there is nothing to do', () => {
  seed();
  assert.equal(notes.remove(3), true);
  assert.equal(notes.remove(3), false);      // already archived
  assert.equal(notes.restore(1), false);     // not archived
  assert.equal(notes.restore(99), false);    // unknown
  assert.equal(notes.restore(3), true);
  assert.equal(notes.restore(3), false);
  assert.equal(Boolean(notes.get(3).archived), false);
});
test('list and count leave archived notes out; includeArchived shows them', () => {
  seed();
  notes.remove(1);
  assert.deepEqual([ids(notes.list()), notes.count()], [[2, 3], 2]);
  assert.deepEqual(ids(notes.list({ includeArchived: true })), [1, 2, 3]);
  assert.deepEqual(ids(notes.list({ includeArchived: false })), [2, 3]);
  assert.deepEqual([notes.get(1).id, notes.get(1).archived, notes.get(1).title], [1, true, 'Buy milk']);
});
test('the summary counts only notes that are not archived', () => {
  seed();
  notes.remove(1);
  assert.deepEqual(stats.summary(), { total: 2, byTag: { home: 1, work: 1 } });
  notes.remove(2);
  assert.deepEqual(stats.summary(), { total: 1, byTag: { home: 1 } });
  notes.restore(1);
  assert.deepEqual(stats.summary(), { total: 2, byTag: { home: 2 } });
});
test('the export has every note and an archived column', () => {
  seed();
  notes.remove(2);
  assert.equal(toCsv(), 'id,title,tag,archived\n1,Buy milk,home,no\n2,Ship v2,work,yes\n3,Call mum,home,no');
  notes.restore(2);
  assert.equal(toCsv(), 'id,title,tag,archived\n1,Buy milk,home,no\n2,Ship v2,work,no\n3,Call mum,home,no');
});
test('the API: delete twice, restore, and ?archived=1', () => {
  seed();
  assert.equal(handle('DELETE', '/notes/2').status, 204);
  assert.equal(handle('DELETE', '/notes/2').status, 404);
  assert.equal(handle('DELETE', '/notes/99').status, 404);
  assert.deepEqual(ids(handle('GET', '/notes').body), [1, 3]);
  assert.deepEqual(ids(handle('GET', '/notes?archived=1').body), [1, 2, 3]);
  assert.deepEqual(ids(handle('GET', '/notes?tag=work').body), []);
  assert.deepEqual(ids(handle('GET', '/notes?tag=work&archived=1').body), [2]);
  assert.deepEqual(handle('GET', '/stats').body, { total: 2, byTag: { home: 2 } });
  const restored = handle('POST', '/notes/2/restore');
  assert.deepEqual([restored.status, restored.body.id, Boolean(restored.body.archived)], [200, 2, false]);
  assert.equal(handle('POST', '/notes/2/restore').status, 404);
  assert.equal(handle('POST', '/notes/99/restore').status, 404);
  assert.deepEqual(ids(handle('GET', '/notes').body), [1, 2, 3]);
});
test('what was there before still works', () => {
  seed();
  const made = handle('POST', '/notes', { title: 'New', tag: 'work' });
  assert.deepEqual([made.status, made.body.id, made.body.title], [201, 4, 'New']);
  assert.equal(handle('GET', '/notes/4').body.title, 'New');
  assert.equal(handle('GET', '/notes/99').status, 404);
  assert.equal(handle('GET', '/nothing').status, 404);
});
