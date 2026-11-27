// npm run signals [-- --session <top-level session id>] [--days <n>]
// Role lint for the catalog this directory sees, counts over recorded subagent runs, smells of the
// top-level sessions (--days: only those started in the last n days), background debriefs, and
// /cl-note notes.
import path from 'node:path';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import { listDebriefs } from '@calliopi/core/debrief';
import { notesFile, readNotes } from '@calliopi/core/notes';
import { loadCatalog } from '#lib/catalog.ts';
import { debriefRoot } from '#lib/debrief.ts';
import { registryRoot } from '#lib/parent.ts';
import { collectRuns, collectSessions, signalsReport } from '#lib/signals.ts';

const option = (name: string) => { const at = process.argv.indexOf(name); return at > 0 ? process.argv[at + 1] : undefined; };
const session = option('--session');
const days = Number(option('--days'));
const sinceMs = Number.isFinite(days) && days > 0 ? Date.now() - days * 86_400_000 : undefined;
const { roles } = loadCatalog(process.cwd());
const notes = readNotes(notesFile(getAgentDir())).filter(n => (!session || n.session === session) && (sinceMs === undefined || n.at >= sinceMs));
const sessions = collectSessions(path.join(getAgentDir(), 'sessions'), { session, sinceMs });
const debriefs = listDebriefs(debriefRoot(getAgentDir())).filter(d => (!session || d.record.session === session) && (sinceMs === undefined || d.record.startedAt >= sinceMs));
console.log(signalsReport(roles.values(), collectRuns(registryRoot(getAgentDir()), session), notes, sessions, debriefs));
