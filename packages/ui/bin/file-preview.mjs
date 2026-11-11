// Standalone (no imports from lib/) so it runs under any Node that Pi was started with.
// Only files already present in the picker's filtered candidate list can be previewed.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { isUtf8 } from 'node:buffer';

const MAX_BYTES = 1024 * 1024;
const [listPath, file] = process.argv.slice(2);
try {
  const candidates = fs.readFileSync(listPath, 'utf8').split('\0');
  if (!file || !candidates.includes(file)) throw new Error('not a candidate');
  const absolute = path.resolve(process.cwd(), file);
  if (fs.statSync(absolute).size > MAX_BYTES) {
    process.stdout.write('Preview omitted: file over 1 MiB.');
  } else {
    const data = fs.readFileSync(absolute);
    if (data.includes(0) || !isUtf8(data)) process.stdout.write('Preview omitted: binary / non-UTF-8 file.');
    else {
      const bat = spawnSync('bat', ['--color=always', '--style=numbers', '--paging=never', '--line-range=1:200', '--', absolute], {
        stdio: ['ignore', 'inherit', 'ignore'], timeout: 3000,
      });
      if (bat.error || bat.status !== 0) {
        // Do not forward control sequences from arbitrary file contents.
        process.stdout.write(data.toString('utf8').split('\n').slice(0, 200).join('\n').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, ''));
      }
    }
  }
} catch { process.stdout.write('Preview unavailable.'); }
