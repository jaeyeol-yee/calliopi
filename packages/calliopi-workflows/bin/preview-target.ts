// fzf preview for the /cl-preview branch list: the file's diff since it diverged from the focused
// branch. fzf passes only the index; refs come from the pane's private state file.
import fs from 'node:fs';
import { renderTarget, type TargetState } from '#lib/preview-pane.ts';
import { detectTools } from '#lib/preview-render.ts';

const [statePath, index] = process.argv.slice(2);
try {
  const state = JSON.parse(fs.readFileSync(statePath!, 'utf8')) as TargetState;
  const i = Number(index);
  if (!Number.isInteger(i) || i < 0 || i >= state.refs.length) throw new Error('bad index');
  const ref = state.refs[i];
  const width = Number(process.env.FZF_PREVIEW_COLUMNS) || 80;
  const { lines } = renderTarget(state, state.file, ref ? { mode: 'base', ref } : { mode: 'view' }, width, detectTools());
  process.stdout.write(lines.slice(0, 500).join('\n'));
} catch { process.stdout.write('Preview unavailable.'); }
