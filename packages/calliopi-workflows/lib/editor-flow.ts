import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fzfSelect, nodePreview } from '@calliopi/core/fzf';
import type { RunProgram } from '@calliopi/core/types';
import { snapshot, changeMessage, resolveProjectFile } from '#lib/file-edit.ts';

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
  // fzf shows sanitized names; the preview and the result refer to candidates by index.
  const list = path.join(directory, 'candidates');
  fs.writeFileSync(list, `${candidates.join('\0')}\0`, { mode: 0o600 });
  // A closed overlay kills fzf mid-way: cancellation wins over whatever it left in the output.
  const picked = await fzfSelect({ run, directory, name: 'files', items: candidates, prompt: 'File > ', preview: nodePreview(preview, list) })
    .catch((error: unknown) => { if (cancelled()) return null; throw error; });
  if (!picked || cancelled()) return null;
  const file = candidates[picked.index]!;
  const absolute = resolveProjectFile(cwd, file);
  const before = snapshot(cwd, file);
  const editor = await run('vim', ['--', absolute]);
  if (cancelled()) return null;
  const after = snapshot(cwd, file);
  return { file, content: changeMessage(file, before, after), exitCode: editor.exitCode };
}
