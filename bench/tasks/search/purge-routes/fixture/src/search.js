const store = require('./store');

function rebuild() {
  store.purge('searchIndex');
  for (const [id, user] of store.tables.users) store.put('searchIndex', id, String(user.name).toLowerCase());
  return store.tables.searchIndex.size;
}

module.exports = { rebuild };
