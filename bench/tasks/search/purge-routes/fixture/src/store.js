const tables = { users: new Map(), sessions: new Map(), searchIndex: new Map() };

function get(table, id) {
  return tables[table].get(id);
}

function put(table, id, row) {
  tables[table].set(id, row);
}

// Empties one table.
function purge(table) {
  tables[table].clear();
}

function remove(table, id) {
  return tables[table].delete(id);
}

module.exports = { get, put, purge, remove, tables };
