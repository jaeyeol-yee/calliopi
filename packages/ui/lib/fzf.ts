import fs from 'node:fs';
import path from 'node:path';

export function shellQuote(value) { return `'${String(value).replaceAll("'", "'\\''")}'`; }

// Display text reaches fzf as a single tab-free, control-free line.
export function cleanDisplay(text) { return String(text).replace(/[\x00-\x1f\x7f-\x9f]/g, ' '); }

// Ignore the user's fzf defaults: they could add --multi, change key bindings or the output format.
export function fzfEnv(extra = {}) {
  return { ...process.env, SHELL: '/bin/sh', FZF_DEFAULT_OPTS: '', FZF_DEFAULT_OPTS_FILE: '', FZF_DEFAULT_COMMAND: '', ...extra };
}

// Each item is "<index>\t<display>"; only the display is shown and searched. The preview and
// the result refer to items by index, so file names and messages never need shell quoting.
export function selectCommand({ listPath, outPath, prompt, preview, query = '', position }) {
  const args = [
    'exec fzf --read0 --print0 --print-query --no-multi --no-mouse --layout=reverse --border=none',
    `--delimiter=${shellQuote('\\t')} --with-nth=2..`,
    `--prompt=${shellQuote(prompt)}`, `--query=${shellQuote(query)}`,
  ];
  if (preview) args.push(`--preview=${shellQuote(preview)}`, `--preview-window=${shellQuote('right:55%:wrap')}`);
  // Restore the cursor when coming back to a step. pos() counts filtered rows, so only without a query.
  if (!query && position > 0) args.push(`--bind=${shellQuote(`load:pos(${position})`)}`);
  args.push(`< ${shellQuote(listPath)} > ${shellQuote(outPath)}`);
  return args.join(' ');
}

export function parseSelectResult(data, count) {
  const [query = '', selection = ''] = data.toString('utf8').split('\0');
  const match = /^(\d+)\t/.exec(selection);
  const index = match ? Number(match[1]) : NaN;
  if (!Number.isInteger(index) || index < 0 || index >= count) throw new Error('올바르지 않은 picker 선택입니다.');
  return { index, query };
}

// Returns { index, query } or null when the user backs out (Esc / Ctrl+C).
export async function fzfSelect({ run, directory, name, items, prompt, preview, query, position }) {
  const listPath = path.join(directory, `${name}.list`);
  const outPath = path.join(directory, `${name}.out`);
  fs.writeFileSync(listPath, items.map((item, i) => `${i}\t${cleanDisplay(item)}\0`).join(''), { mode: 0o600 });
  fs.writeFileSync(outPath, '', { mode: 0o600 });
  const result = await run('/bin/sh', ['-c', selectCommand({ listPath, outPath, prompt, preview, query, position })], fzfEnv());
  if (result.exitCode === 1 || result.exitCode === 130 || result.exitCode === -1) return null;
  if (result.exitCode !== 0) throw new Error(`fzf 종료 코드: ${result.exitCode}`);
  return parseSelectResult(fs.readFileSync(outPath), items.length);
}
