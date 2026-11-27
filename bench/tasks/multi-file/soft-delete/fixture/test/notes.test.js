const test = require('node:test');
const assert = require('node:assert/strict');
const store = require('../src/store');
const notes = require('../src/notes');
const { handle } = require('../src/api');
const seed = () => { store.reset(); notes.create('Buy milk', 'home'); notes.create('Ship v2', 'work'); notes.create('Call mum', 'home'); };

test('a removed note is kept, archived and left out of the list', () => {
  seed();
  assert.equal(notes.remove(2), true);
  assert.deepEqual(notes.list().map(n => n.id), [1, 3]);
  assert.equal(notes.get(2).archived, true);
  assert.equal(notes.remove(99), false);
});
test('restore brings it back', () => {
  seed();
  notes.remove(2);
  assert.equal(notes.restore(2), true);
  assert.deepEqual(notes.list().map(n => n.id), [1, 2, 3]);
});
test('DELETE archives over the API', () => {
  seed();
  assert.equal(handle('DELETE', '/notes/1').status, 204);
  assert.deepEqual(handle('GET', '/notes').body.map(n => n.id), [2, 3]);
  assert.equal(handle('GET', '/notes/1').status, 200);
});
