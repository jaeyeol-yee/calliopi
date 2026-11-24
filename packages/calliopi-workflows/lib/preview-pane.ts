// Runs inside the multiplexer pane (a separate process with its own terminal, not inside Pi).
// Pi picks the file (fzf in its overlay); this pane only displays it: a scrolling viewer that follows
// edits, switches file when Pi asks, and compares with a branch on demand (b: fzf branch list).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fzfSelect, nodePreview } from '@calliopi/core/fzf';
import { ttyRun } from '@calliopi/core/tty';
import { listBranches, diffFile, type BranchRecord, type DiffMode } from '#lib/preview-git.ts';
import { detectTools, renderDiff, renderFile, stripAnsi, type Tools } from '#lib/preview-render.ts';
import { bodyRows, clamp, find, frame, parseInput, scroll, type KeyHint, type ViewerState } from '#lib/preview-viewer.ts';
import { CLOSED_MARKER, PANE_PID_FILE, REQUEST_FILE, takeRequest, writeShare, type PreviewShare } from '#lib/preview-share.ts';

const targetPreview = fileURLToPath(new URL('../bin/preview-target.ts', import.meta.url));

export interface PaneConfig {
  /** Pi's working directory; file paths are relative to it. */
  cwd: string;
  /** Repository root (realpath), or null outside git: then branch comparison is unavailable. */
  root: string | null;
  /** File to show first (cwd-relative); later files arrive as requests. */
  file: string;
  /** Private directory: fzf lists, preview state, outbox/. */
  dir: string;
  piPid: number;
}

export interface TargetState { cwd: string; root: string | null; file: string; refs: (string | null)[] }

export type Target = { mode: 'view' } | { mode: DiffMode; ref: string; name?: string };

export const rootRelative = (root: string, cwd: string, file: string) =>
  path.relative(fs.realpathSync(root), fs.realpathSync(path.resolve(cwd, file))).split(path.sep).join('/');

/** Display lines for one target at a width, plus the plain text that 's' would share. */
export function renderTarget(config: Pick<PaneConfig, 'cwd' | 'root'>, file: string, target: Target, width: number, tools: Tools): { lines: string[]; share: string | null; base?: string } {
  const absolute = path.resolve(config.cwd, file);
  if (target.mode === 'view') {
    const read = () => { try { const b = fs.readFileSync(absolute); return b.includes(0) || b.length > 1024 * 1024 ? null : b.toString('utf8'); } catch { return null; } };
    if (!fs.existsSync(absolute)) return { lines: ['(파일이 없습니다. 삭제되었거나 이름이 바뀌었습니다)'], share: null };
    return { lines: renderFile(absolute, width, tools, read), share: null };
  }
  const d = diffFile(config.root!, rootRelative(config.root!, config.cwd, file), target.ref, target.mode);
  if (d.status === 'no-base') return { lines: [`(${target.name ?? target.ref}와 공통 조상이 없습니다. m으로 브랜치 끝과 비교할 수 있습니다)`], share: null };
  if (d.status === 'changed') return { lines: renderDiff(d.text, width, tools), share: d.text, base: d.base };
  const why = { same: '변경 없음', missing: '양쪽 모두 파일이 없습니다', binary: '바이너리이거나 1 MiB를 넘는 파일입니다' }[d.status];
  const name = target.name ?? target.ref;
  return { lines: [`(${why}: ${target.mode === 'base' ? `${name}에서 갈라진 지점` : name} 대비)`], share: null, base: d.base };
}

// Lists start without the preview sidebar; the guide sits at the bottom with the prompt.
const look = (guide: string) => ({
  layout: 'default' as const, header: `${guide} · Ctrl+/: 미리보기 사이드바`,
  previewWindow: 'right:60%:wrap:hidden', bind: ['ctrl-/:toggle-preview'],
});

const piAlive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const clock = () => new Date().toTimeString().slice(0, 8);

/**
 * Interactive viewer on the pane's terminal, starting with the file itself; resolves when closed
 * (q, Esc, Ctrl+C). `pickBranch` borrows the terminal for an fzf branch list and returns the choice.
 */
export function view(config: PaneConfig, tools: Tools, pickBranch: (file: string) => Promise<BranchRecord | null>): Promise<void> {
  const out = process.stdout, input = process.stdin;
  let file = config.file;
  let target: Target = { mode: 'view' };
  const s: ViewerState = { lines: [], offset: 0, query: '', prompt: null };
  let shareText: string | null = null, base: string | undefined, note = '';
  const size = () => ({ cols: out.columns || 80, rows: out.rows || 24 });
  const compute = () => {
    const r = renderTarget(config, file, target, size().cols, tools);
    s.lines = r.lines; shareText = r.share; base = r.base;
    clamp(s, size().rows);
  };
  const modeLabel = () => target.mode === 'view' ? '파일' : target.mode === 'base' ? `${target.name}에서 갈라진 뒤` : `${target.name} 끝과 비교`;
  const draw = () => {
    const { cols, rows } = size();
    const last = Math.min(s.lines.length, s.offset + bodyRows(rows));
    const left = ` ${file} · ${modeLabel()} · ${s.lines.length ? `${s.offset + 1}-${last}/${s.lines.length}` : '0/0'}${note ? ` · ${note}` : ''}`;
    out.write(frame(s, cols, rows, left, '', keyHints()));
  };
  // Most used first: keyMap drops hints from the end when the pane is narrow.
  const keyHints = (): KeyHint[] => {
    if (s.prompt !== null) return [{ key: 'Enter', label: '찾기' }, { key: 'Esc', label: '취소' }];
    const mode: KeyHint[] = target.mode === 'view'
      ? [{ key: 'b', label: '브랜치와 비교' }]
      : [{ key: 'b', label: '브랜치' }, { key: 'm', label: target.mode === 'base' ? '브랜치 끝' : '갈라진 지점' }, { key: 'v', label: '파일' }];
    return [
      { key: '↑↓', label: '스크롤' }, { key: '/', label: '찾기' }, ...mode, { key: 's', label: '대화로' }, { key: 'q', label: '닫기' },
      ...(s.query ? [{ key: 'n/N', label: '다음/이전' }] : []),
    ];
  };
  const share = () => {
    if (!piAlive(config.piPid) || !fs.existsSync(path.join(config.dir, 'outbox'))) { note = 'Pi 세션이 없어 보내지 못했습니다'; return; }
    const visible = s.lines.slice(s.offset, s.offset + bodyRows(size().rows)).map(stripAnsi).join('\n');
    const payload: PreviewShare = target.mode === 'view' ? { file, mode: 'view', text: visible }
      : { file, mode: target.mode, ref: target.name ?? target.ref, base, text: shareText ?? visible };
    writeShare(path.join(config.dir, 'outbox'), payload);
    note = '다음 대화에 전달합니다';
  };
  compute();
  return new Promise(resolve => {
    let debounce: NodeJS.Timeout | undefined;
    let active = false;
    // Watch the file's directory: editors often save by writing a new file and renaming it over the old one.
    let watcher: fs.FSWatcher | undefined;
    const watchFile = () => {
      watcher?.close(); watcher = undefined;
      try {
        watcher = fs.watch(path.dirname(path.resolve(config.cwd, file)), (_e, name) => {
          if (name && name !== path.basename(file)) return;
          clearTimeout(debounce);
          debounce = setTimeout(() => { compute(); note = `↻ ${clock()}`; if (active) draw(); }, 150);
        });
      } catch { note = '파일 변경 감시를 시작하지 못했습니다'; }
    };
    watchFile();
    // Pi asks for another file by writing a request into our private directory.
    let pending: string | null = null;
    const applyRequest = () => {
      if (pending === null) return;
      file = pending; pending = null;
      target = { mode: 'view' }; s.offset = 0; s.query = ''; note = '';
      watchFile(); compute(); draw();
    };
    let requests: fs.FSWatcher | undefined;
    try {
      requests = fs.watch(config.dir, (_e, name) => {
        if (name !== REQUEST_FILE) return;
        const next = takeRequest(config.dir);
        if (next) { pending = next; if (active) applyRequest(); }
      });
    } catch { /* requests unavailable: the pane still works for its first file */ }
    const onResize = () => { compute(); draw(); };
    const enter = () => {
      out.write('\x1b[?1049h\x1b[?25l\x1b[?1000h\x1b[?1006h'); // alternate screen, no cursor, wheel reports
      if (input.isTTY) input.setRawMode(true);
      input.resume();
      input.on('data', onData);
      out.on('resize', onResize);
      active = true;
      if (pending !== null) applyRequest(); else draw();
    };
    const leave = () => {
      active = false;
      input.off('data', onData); out.off('resize', onResize);
      if (input.isTTY) input.setRawMode(false);
      input.pause();
      out.write('\x1b[?1000l\x1b[?1006l\x1b[?25h\x1b[?1049l');
    };
    const finish = () => { clearTimeout(debounce); watcher?.close(); requests?.close(); leave(); resolve(); };
    const chooseBranch = async () => {
      if (!config.root) { note = 'git 저장소가 아니라 브랜치와 비교할 수 없습니다'; draw(); return; }
      leave(); // fzf takes the terminal
      const branch = await pickBranch(file).catch(() => null);
      if (branch) { target = { mode: 'base', ref: branch.ref, name: branch.name }; s.offset = 0; note = ''; compute(); }
      enter();
    };
    function onData(chunk: Buffer) {
      const { rows } = size();
      for (const ev of parseInput(chunk.toString('utf8'))) {
        if (ev.kind === 'wheel') { scroll(s, ev.delta * 3, rows); continue; }
        const k = ev.key;
        if (s.prompt !== null) {
          if (k === 'enter') { s.query = s.prompt; s.prompt = null; const i = find(s, s.query, s.offset, 1); if (i >= 0) s.offset = i; else note = `찾을 수 없음: ${s.query}`; clamp(s, rows); }
          else if (k === 'esc' || k === 'ctrl-c') s.prompt = null;
          else if (k === 'backspace') s.prompt = s.prompt.slice(0, -1);
          else if ([...k].length === 1) s.prompt += k;
          continue;
        }
        note = note.startsWith('↻') ? note : '';
        if (k === 'q' || k === 'esc' || k === 'ctrl-c') return finish();
        if (k === 'b') { void chooseBranch(); return; }
        if (k === 'up' || k === 'k') scroll(s, -1, rows);
        else if (k === 'down' || k === 'j' || k === 'enter') scroll(s, 1, rows);
        else if (k === 'pageup' || k === 'u') scroll(s, -(bodyRows(rows) - 1), rows);
        else if (k === 'pagedown' || k === ' ' || k === 'd') scroll(s, bodyRows(rows) - 1, rows);
        else if (k === 'home' || k === 'g') s.offset = 0;
        else if (k === 'end' || k === 'G') { s.offset = s.lines.length; clamp(s, rows); }
        else if (k === '/') s.prompt = '';
        else if ((k === 'n' || k === 'N') && s.query) { const i = find(s, s.query, s.offset, k === 'n' ? 1 : -1); if (i >= 0) { s.offset = i; clamp(s, rows); } }
        else if (k === 'm' && target.mode !== 'view') { target = { ...target, mode: target.mode === 'base' ? 'tip' : 'base' }; s.offset = 0; compute(); }
        else if (k === 'v' && target.mode !== 'view') { target = { mode: 'view' }; s.offset = 0; compute(); }
        else if (k === 's') share();
      }
      draw();
    }
    enter();
  });
}

export async function runPane(config: PaneConfig): Promise<void> {
  fs.writeFileSync(path.join(config.dir, PANE_PID_FILE), String(process.pid), { mode: 0o600 });
  const tools = detectTools();
  const branches: BranchRecord[] = config.root ? listBranches(config.root) : [];
  // The branch list remembers its query and cursor across openings within this pane.
  let branchView = { query: '', position: 0 };
  const pickBranch = async (file: string): Promise<BranchRecord | null> => {
    if (!branches.length) return null;
    const state = path.join(config.dir, 'branches.json');
    fs.writeFileSync(state, JSON.stringify({ cwd: config.cwd, root: config.root, file, refs: branches.map(b => b.ref) } satisfies TargetState), { mode: 0o600 });
    const picked = await fzfSelect({
      run: ttyRun, directory: config.dir, name: 'branches', items: branches.map(b => b.display), prompt: '비교할 브랜치 > ',
      preview: nodePreview(targetPreview, state), ...look('Enter: 갈라진 뒤 변경 보기 · Esc: 돌아가기'), ...branchView,
    });
    if (!picked) return null;
    branchView = { query: picked.query, position: picked.index + 1 };
    return branches[picked.index]!;
  };
  await view(config, tools, pickBranch);
}

/** Tell the extension this pane is gone so it can remove the private directory. */
export function markClosed(dir: string): void {
  try { fs.writeFileSync(path.join(dir, CLOSED_MARKER), '', { mode: 0o600 }); } catch { /* already cleaned up */ }
}
