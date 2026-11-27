// npm run signals [-- --session <top-level session id>]
// Role lint for the catalog this directory sees, and counts over recorded subagent runs.
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import { loadCatalog } from '#lib/catalog.ts';
import { registryRoot } from '#lib/parent.ts';
import { collectRuns, signalsReport } from '#lib/signals.ts';

const at = process.argv.indexOf('--session');
const session = at > 0 ? process.argv[at + 1] : undefined;
const { roles } = loadCatalog(process.cwd());
console.log(signalsReport(roles.values(), collectRuns(registryRoot(getAgentDir()), session)));
