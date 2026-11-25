// Which scenarios CI should record for a pull request. Pure git, so it runs before `npm ci` finishes
// installing anything native, and takes the repository root so tests can use a scratch repository.
import { execFileSync, spawnSync } from 'node:child_process';

const SCENARIO_DIR = 'demo/scenarios';
const ASSET_DIR = 'assets/scenarios';

const git = (root: string, args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();

/** Scenarios added (not modified; a rename counts as an add) between <base> and HEAD. */
export function addedScenarios(root: string, base: string): string[] {
  return git(root, ['diff', '--name-only', '--diff-filter=A', '--no-renames', `${base}...HEAD`, '--', SCENARIO_DIR])
    .split('\n').filter((f) => /\.ya?ml$/.test(f))
    .map((f) => f.slice(SCENARIO_DIR.length + 1).replace(/\.ya?ml$/, '')).sort();
}

const lastCommit = (root: string, file: string) => git(root, ['log', '-1', '--format=%H', '--', file]) || undefined;

/**
 * A scenario is recorded when its GIF was committed no earlier than the scenario's last change.
 * Commit ancestry, not timestamps: rebases and clock skew do not matter, and a scenario committed
 * together with its GIF counts as recorded.
 */
export function isRecorded(root: string, name: string): boolean {
  const gif = lastCommit(root, `${ASSET_DIR}/${name}.gif`);
  if (!gif) return false;
  const scenario = lastCommit(root, `${SCENARIO_DIR}/${name}.yaml`) ?? lastCommit(root, `${SCENARIO_DIR}/${name}.yml`);
  if (!scenario) return true;
  return spawnSync('git', ['merge-base', '--is-ancestor', scenario, gif], { cwd: root }).status === 0;
}

/**
 * Scenarios a pull request adds that still need a GIF. Recording commits the GIF, so the next run
 * plans nothing: CI does not record the same scenario twice or loop on its own commits.
 */
export function planScenarios(root: string, base: string): string[] {
  return addedScenarios(root, base).filter((name) => !isRecorded(root, name));
}
