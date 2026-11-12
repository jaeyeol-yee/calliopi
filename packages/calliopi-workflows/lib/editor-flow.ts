import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { nodePreview } from '@calliopi/core/fzf';
import { runWorkflow } from '@calliopi/core/workflow';
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

// file list → Vim. Changes are measured around the Vim run, not against git.
export async function editOneFile({ cwd, candidates, directory, run, cancelled = () => false }: EditOneFileOptions): Promise<EditResult | null> {
  // fzf shows sanitized names; the preview and the result refer to candidates by index.
  const list = path.join(directory, 'candidates');
  fs.writeFileSync(list, `${candidates.join('\0')}\0`, { mode: 0o600 });
  return runWorkflow<EditResult>({
    name: 'files', prompt: 'File > ', items: candidates, preview: nodePreview(preview, list),
    async onSelect({ index }, io) {
      const file = candidates[index]!;
      const absolute = resolveProjectFile(cwd, file);
      const before = snapshot(cwd, file);
      const editor = await io.run('vim', ['--', absolute]);
      return { done: { file, content: changeMessage(file, before, snapshot(cwd, file)), exitCode: editor.exitCode } };
    },
  }, { run, directory, cancelled });
}
