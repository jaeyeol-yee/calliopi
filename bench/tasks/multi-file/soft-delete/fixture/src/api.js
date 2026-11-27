const notes = require('./notes');
const stats = require('./stats');
const { toCsv } = require('./export');

// handle('GET', '/notes') -> { status, body }. Query strings look like '/notes?tag=home'.
function handle(method, url, body) {
  const [path, query = ''] = url.split('?');
  const params = new URLSearchParams(query);
  const id = Number(path.split('/')[2]);

  if (method === 'GET' && path === '/notes') {
    const tag = params.get('tag');
    return { status: 200, body: notes.list().filter(note => !tag || note.tag === tag) };
  }
  if (method === 'POST' && path === '/notes') return { status: 201, body: notes.create(body.title, body.tag) };
  if (method === 'GET' && /^\/notes\/\d+$/.test(path)) {
    const note = notes.get(id);
    return note ? { status: 200, body: note } : { status: 404 };
  }
  if (method === 'DELETE' && /^\/notes\/\d+$/.test(path)) return { status: notes.remove(id) ? 204 : 404 };
  if (method === 'GET' && path === '/stats') return { status: 200, body: stats.summary() };
  if (method === 'GET' && path === '/export') return { status: 200, body: toCsv() };
  return { status: 404 };
}

module.exports = { handle };
