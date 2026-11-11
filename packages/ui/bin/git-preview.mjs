// fzf preview for /calliopi-log. Standalone (no lib/ imports): runs under whatever Node started Pi.
// Only items from the picker's state file can be previewed; fzf passes just the item index.
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const [statePath, index] = process.argv.slice(2);
try {
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  const i = Number(index);
  if (!Number.isInteger(i) || i < 0) throw new Error('bad index');
  let args;
  if (state.kind === 'commits' && state.hashes[i]) {
    args = ['show', '--stat', '--format=fuller', '--color=always', '--no-ext-diff', state.hashes[i]];
  } else if (state.kind === 'files' && state.paths[i]) {
    args = ['diff', '--color=always', '--no-ext-diff', '-M', state.base, state.hash, '--', ...state.paths[i]];
  } else throw new Error('unknown item');
  spawnSync('git', ['--no-pager', ...args], {
    stdio: ['ignore', 'inherit', 'ignore'], timeout: 5000,
    env: { ...process.env, GIT_LITERAL_PATHSPECS: '1', GIT_OPTIONAL_LOCKS: '0' },
  });
} catch { process.stdout.write('Preview unavailable.'); }
