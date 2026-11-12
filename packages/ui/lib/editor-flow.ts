import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pickerCommand, parseSelection, snapshot, changeMessage, resolveProjectFile } from './file-edit.ts';
import type { RunProgram } from './types.ts';

const preview = fileURLToPath(new URL('../bin/file-preview.ts', import.meta.url));

export interface EditResult {
  file: string;
  content: string | null;
  exitCode: number;
}

export interface EditOneFileOptions {
  cwd: string;
  candidates: readonly string[];
  directory: string;
  run: RunProgram;
  cancelled?: () => boolean;
}

export async function editOneFile({ cwd, candidates, directory, run, cancelled = () => false }: EditOneFileOptions): Promise<EditResult | null> {
  const list = path.join(directory, 'files');
  const selection = path.join(directory, 'selection');
  fs.writeFileSync(list, `${candidates.join('\0')}\0`, { mode: 0o600 });
  fs.writeFileSync(selection, '', { mode: 0o600 });
  const result = await run('/bin/sh', ['-c', pickerCommand(list, selection, preview)], {
    ...process.env, SHELL: '/bin/sh', FZF_DEFAULT_OPTS: '', FZF_DEFAULT_OPTS_FILE: '', FZF_DEFAULT_COMMAND: '',
  });
  if (cancelled()) return null;
  if (result.exitCode === 1 || result.exitCode === 130) return null;
  if (result.exitCode !== 0) throw new Error(`fzf 종료 코드: ${result.exitCode}`);
  const file = parseSelection(fs.readFileSync(selection), candidates);
  const absolute = resolveProjectFile(cwd, file);
  const before = snapshot(cwd, file);
  const editor = await run('vim', ['--', absolute]);
  if (cancelled()) return null;
  const after = snapshot(cwd, file);
  return { file, content: changeMessage(file, before, after), exitCode: editor.exitCode };
}
