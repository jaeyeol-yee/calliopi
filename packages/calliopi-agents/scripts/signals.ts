// npm run signals [-- --session <top-level session id>]
// Role lint for the catalog this directory sees, counts over recorded subagent runs, and /cl-note notes.
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import { notesFile, readNotes } from '@calliopi/core/notes';
import { loadCatalog } from '#lib/catalog.ts';
import { registryRoot } from '#lib/parent.ts';
import { collectRuns, signalsReport } from '#lib/signals.ts';

const at = process.argv.indexOf('--session');
const session = at > 0 ? process.argv[at + 1] : undefined;
const { roles } = loadCatalog(process.cwd());
const notes = readNotes(notesFile(getAgentDir())).filter(n => !session || n.session === session);
console.log(signalsReport(roles.values(), collectRuns(registryRoot(getAgentDir()), session), notes));
