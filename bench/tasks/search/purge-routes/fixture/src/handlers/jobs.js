const maintenance = require('../maintenance');

const ALLOWED = ['cleanup', 'nightly'];

function run(req) {
  if (!ALLOWED.includes(req.params.name)) return { status: 404 };
  return { status: 200, steps: maintenance.run(req.params.name) };
}

module.exports = { run };
