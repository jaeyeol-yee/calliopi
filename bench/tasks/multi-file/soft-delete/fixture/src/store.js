// Notes in memory, by id.
const notes = new Map();
let nextId = 1;

function insert(fields) {
  const note = { id: nextId++, ...fields };
  notes.set(note.id, note);
  return note;
}

function find(id) {
  return notes.get(id);
}

function all() {
  return [...notes.values()];
}

function erase(id) {
  return notes.delete(id);
}

function reset() {
  notes.clear();
  nextId = 1;
}

module.exports = { insert, find, all, erase, reset };
