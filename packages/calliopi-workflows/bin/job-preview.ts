// fzf preview for /cl-jobs: the focused job's state and the end of its output.
// fzf passes only the item index; job directories come from the list the picker wrote.
import fs from 'node:fs';
import path from 'node:path';
import { JOB_LIST, readJob, statusText, tailLog } from '#lib/jobs.ts';

process.stdout.on('error', () => {}); // fzf closes the pipe when focus moves on
const [dir, index] = process.argv.slice(2);
try {
  const dirs = fs.readFileSync(path.join(dir!, JOB_LIST), 'utf8').split('\0').slice(0, -1);
  const job = /^\d+$/.test(index ?? '') ? readJob(dirs[Number(index)] ?? '') : null;
  if (!job) throw new Error('not a job');
  const rows = Number(process.env.FZF_PREVIEW_LINES) || 40;
  const { text } = tailLog(job.dir, Math.max(1, rows - 3));
  process.stdout.write([`\x1b[7m ${job.name} · ${statusText(job)} \x1b[0m`, `\x1b[2m$ ${job.command}\n${job.cwd}\x1b[0m`, text || '(출력 없음)'].join('\n'));
} catch { process.stdout.write('Preview unavailable.'); }
