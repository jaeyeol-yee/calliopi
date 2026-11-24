// /cl-preview's file search, run inside Pi's floating overlay (the pane only displays).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { nodePreview, shellQuote } from '@calliopi/core/fzf';
import { runWorkflow } from '@calliopi/core/workflow';
import type { RunProgram } from '@calliopi/core/types';
import type { Tools } from '#lib/preview-render.ts';

const pickPreview = fileURLToPath(new URL('../bin/pick-preview.ts', import.meta.url));

/** State file in the picker's private directory, read by bin/pick-preview.ts. */
export const PICK_STATE = 'pick-state.json';
/** Present while the sidebar shows diffs instead of files; Ctrl+T creates/removes it. */
export const DIFF_MARKER = 'diff-mode';

export interface PickState {
  cwd: string;
  /** Repository root (realpath), or null outside git: then there is no diff mode. */
  root: string | null;
  /** Branch to diff against; undefined until the first diff preview looks it up, null when none. */
  base?: string | null;
  /** bat/delta availability, detected by the first preview. */
  tools?: Tools;
}

export interface PickFileOptions {
  candidates: readonly string[];
  directory: string;
  run: RunProgram;
  cancelled?: () => boolean;
  /** Pre-filled search (the command argument). */
  query?: string;
  /** What the list is limited to, shown before the guide, e.g. 'main에서 갈라진 뒤 변경 3개'. */
  scope?: string;
  cwd: string;
  root: string | null;
  /** Known diff base (--changed); otherwise the preview finds the parent branch on first use. */
  base?: string | null;
  /** Start the sidebar in diff mode (the list is changed files anyway). */
  diffFirst?: boolean;
}

// The preview sidebar starts open (Ctrl+/ hides it); its first line, the mode title, stays put while
// it scrolls. The guide sits at the bottom with the prompt.
export function pickFile({ candidates, directory, run, cancelled, query, scope, cwd, root, base, diffFirst }: PickFileOptions): Promise<string | null> {
  fs.writeFileSync(path.join(directory, 'candidates'), `${candidates.join('\0')}\0`, { mode: 0o600 });
  fs.writeFileSync(path.join(directory, PICK_STATE), JSON.stringify({ cwd, root, base } satisfies PickState), { mode: 0o600 });
  const marker = shellQuote(path.join(directory, DIFF_MARKER));
  if (diffFirst && root) fs.writeFileSync(path.join(directory, DIFF_MARKER), '', { mode: 0o600 });
  // fzf runs bound commands with /bin/sh (fzfEnv): flip the marker, then redraw the sidebar.
  const flip = `ctrl-t:execute-silent(if [ -e ${marker} ]; then rm -f ${marker}; else : > ${marker}; fi)+refresh-preview+preview-top`;
  return runWorkflow<string>({
    name: 'files', prompt: 'File > ', items: candidates, preview: nodePreview(pickPreview, directory), initialQuery: query,
    layout: 'default',
    // Short lines: with the sidebar open the guide only gets the list's 40%. Sidebar keys are in its title.
    header: [scope, 'Enter: 옆 pane에 표시 · Esc: 취소', 'Ctrl+/: 미리보기 사이드바'].filter(Boolean).join('\n'),
    previewWindow: 'right:60%:wrap:~1', bind: ['ctrl-/:toggle-preview', flip, 'alt-up:preview-half-page-up', 'alt-down:preview-half-page-down'],
    onSelect: ({ index }) => ({ done: candidates[index]! }),
  }, { run, directory, cancelled });
}
