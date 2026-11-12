// fzf preview for /calliopi-log. Standalone (no lib/ imports): runs under whatever Node started Pi.
// Only items from the picker's state file can be previewed; fzf passes just the item index.
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

interface PreviewState {
  kind: string;
  hashes: string[];
  paths: string[][];
  base: string;
  hash: string;
}

const [statePath, index] = process.argv.slice(2);
try {
  if (!statePath) throw new Error('bad index');
  // Written by lib/git-log.ts; a bad file falls through to the catch below.
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8')) as PreviewState;
  const i = Number(index);
  if (!Number.isInteger(i) || i < 0) throw new Error('bad index');
  let args: string[];
  const hash = state.hashes?.[i];
  const paths = state.paths?.[i];
  if (state.kind === 'commits' && hash) {
    args = ['show', '--stat', '--format=fuller', '--color=always', '--no-ext-diff', hash];
  } else if (state.kind === 'files' && paths) {
    args = ['diff', '--color=always', '--no-ext-diff', '-M', state.base, state.hash, '--', ...paths];
  } else throw new Error('unknown item');
  spawnSync('git', ['--no-pager', ...args], {
    stdio: ['ignore', 'inherit', 'ignore'], timeout: 5000,
    env: { ...process.env, GIT_LITERAL_PATHSPECS: '1', GIT_OPTIONAL_LOCKS: '0' },
  });
} catch { process.stdout.write('Preview unavailable.'); }
