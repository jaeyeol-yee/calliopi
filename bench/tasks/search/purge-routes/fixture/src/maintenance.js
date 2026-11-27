const audit = require('./audit');
const store = require('./store');
const retention = require('./retention');

function vacuum() {
  store.purge('searchIndex');
}

function expireSessions() {
  retention.sweep(Date.now());
}

function trimAudit() {
  audit.purge(1000);
}

const TASKS = {
  cleanup: [vacuum, expireSessions],
  nightly: [vacuum, expireSessions, trimAudit],
};

function run(name) {
  const steps = TASKS[name];
  if (!steps) throw new Error(`unknown task: ${name}`);
  for (const step of steps) step();
  return steps.length;
}

module.exports = { run, TASKS };
