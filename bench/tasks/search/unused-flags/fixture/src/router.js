const { isEnabled } = require('./flags');
const routes = require('./routes.json');

function resolve(path) {
  const route = routes.find(r => r.path === path);
  if (!route) return { status: 404 };
  if (route.blockedBy && isEnabled(route.blockedBy)) return { status: 503 };
  return { status: 200, handler: route.handler };
}

module.exports = { resolve };
