const store = require('./store');

function create(title, tag) {
  return store.insert({ title, tag });
}

function get(id) {
  return store.find(id);
}

function list() {
  return store.all();
}

function count() {
  return store.all().length;
}

// Deletes the note. True when there was one.
function remove(id) {
  return store.erase(id);
}

module.exports = { create, get, list, count, remove };
