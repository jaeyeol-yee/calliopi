// fzf preview for the /cl-preview file picker: the focused file itself, or its diff since HEAD left
// the parent branch. Ctrl+T flips the mode by creating/removing the DIFF_MARKER file in the picker's
// private directory (fzf 0.46 cannot tell a shell command which preview is showing). fzf passes only
// the item index; names come from the candidate list, so they never go through the shell.
import fs from 'node:fs';
import path from 'node:path';
import { renderTarget } from '#lib/preview-pane.ts';
import { detectTools, fitAnsi } from '#lib/preview-render.ts';
import { parentBranch } from '#lib/preview-git.ts';
import { DIFF_MARKER, PICK_STATE, type PickState } from '#lib/preview-pick.ts';

const MAX_LINES = 3000; // past this, open the file in the pane
process.stdout.on('error', () => {}); // fzf closes the pipe when focus moves on
const [dir, index] = process.argv.slice(2);
try {
  const state = JSON.parse(fs.readFileSync(path.join(dir!, PICK_STATE), 'utf8')) as PickState;
  const candidates = fs.readFileSync(path.join(dir!, 'candidates'), 'utf8').split('\0').slice(0, -1);
  const file = /^\d+$/.test(index ?? '') ? candidates[Number(index)] : undefined;
  if (!file) throw new Error('not a candidate');
  const width = Number(process.env.FZF_PREVIEW_COLUMNS) || 80;
  // Looked up once per picker by the first preview that needs them, then cached in the state file.
  // Atomic: fzf may run a newer preview while this one writes.
  const save = () => {
    const tmp = path.join(dir!, `${PICK_STATE}.${process.pid}`);
    fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
    fs.renameSync(tmp, path.join(dir!, PICK_STATE));
  };
  if (!state.tools) { state.tools = detectTools(); save(); }
  const tools = state.tools;
  const diff = fs.existsSync(path.join(dir!, DIFF_MARKER));
  let title: string, lines: string[];
  if (!diff) {
    title = '파일 · Ctrl+T: diff';
    lines = renderTarget(state, file, { mode: 'view' }, width, tools).lines;
  } else if (!state.root) {
    title = 'diff · Ctrl+T: 파일';
    lines = ['(git 저장소가 아니라 diff를 볼 수 없습니다)'];
  } else {
    if (state.base === undefined) { state.base = parentBranch(state.cwd); save(); }
    title = `${state.base ?? '?'}에서 갈라진 뒤 diff · Ctrl+T: 파일`;
    lines = state.base ? renderTarget(state, file, { mode: 'base', ref: state.base }, width, tools).lines
      : ['(비교할 부모 브랜치를 찾지 못했습니다)'];
  }
  // Shift+↑↓ (fzf's default) also scrolls by one line.
  process.stdout.write([`\x1b[7m${fitAnsi(` ${title} · Alt+↑↓: 스크롤 `, width)}\x1b[0m`, ...lines.slice(0, MAX_LINES)].join('\n'));
} catch { process.stdout.write('Preview unavailable.'); }
