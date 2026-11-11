// Offline end-to-end smoke test against an installed Pi. Never sends a prompt to a model.
// PI_BINARY=/path/to/pi npm run smoke --workspace @calliopi/ui
import pty from 'node-pty';
import xterm from '@xterm/headless';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const extension = fileURLToPath(new URL('../extensions/file-picker.ts', import.meta.url));
const logExtension = fileURLToPath(new URL('../extensions/git-log.ts', import.meta.url));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

for (const mode of ['fullscreen', 'regular']) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'calliopi-pi-smoke-'));
  const term = new xterm.Terminal({ cols: 110, rows: 38, allowProposedApi: true, scrollback: 3000, logLevel: 'off' });
  let child;
  const screen = () => Array.from({ length: term.rows }, (_, y) => term.buffer.active.getLine(term.buffer.active.viewportY + y)?.translateToString(true) || '').join('\n');
  const wait = async (predicate, label) => {
    const start = Date.now();
    while (!predicate()) {
      if (Date.now() - start > 12_000) throw new Error(`${mode}: ${label}\n${screen()}`);
      await sleep(40);
    }
  };
  try {
    fs.writeFileSync(path.join(cwd, 'sample.txt'), 'original-marker\n');
    child = pty.spawn(process.env.PI_BINARY || 'pi', [
      '--offline', '--verbose', '--no-session', '--no-extensions', '--no-skills', '--no-prompt-templates',
      '--no-context-files', '--no-mcp', '--no-approve', '--tui-mode', mode, '-e', extension, '-e', logExtension,
    ], { cwd, cols: 110, rows: 38, env: { ...process.env, TERM: 'xterm-256color' } });
    child.onData(data => term.write(data));
    term.onData(data => child.write(data));
    await wait(() => screen().includes(path.basename(cwd)) && screen().includes('git-log.ts'), 'Pi startup');
    child.write('/calliopi-edit\r');
    await wait(() => screen().includes('File >') && screen().includes('sample.txt'), 'fzf overlay');
    child.write('\r');
    await wait(() => screen().includes('original-marker'), 'Vim overlay');
    child.write('gg0Cedited-marker\x1b:wq\r');
    await wait(() => screen().includes('변경 사항을 다음 대화에 전달'), 'Pi return / change notification');
    if (fs.readFileSync(path.join(cwd, 'sample.txt'), 'utf8') !== 'edited-marker\n') throw new Error('File not saved');
    // Reopen and cancel; this also checks focus returns to Pi's command editor.
    child.write('/calliopi-edit\r');
    await wait(() => screen().includes('File >'), 'reopened picker');
    child.write('\x1b');
    await wait(() => !screen().includes('Calliopi · fzf'), 'cancel returns to Pi');
    console.log(`${mode}: fzf → Vim → save → Pi notification → reopen → Esc: OK`);

    // /calliopi-log: commit → file → pager → q → Esc → Esc back to Pi.
    const git = (...args) => spawnSync('git', args, { cwd, stdio: 'ignore' });
    git('init', '-q'); git('-c', 'user.name=t', '-c', 'user.email=t@e', 'add', 'sample.txt');
    git('-c', 'user.name=t', '-c', 'user.email=t@e', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'smoke commit');
    // Split view (110 columns ≥ 100): commits left, files + diff right.
    child.write('/calliopi-log\r');
    await wait(() => screen().includes('Commits') && screen().includes('smoke com') && screen().includes('File >') && screen().includes('sample.txt'), 'split view');
    child.write('\t');
    await wait(() => screen().includes('Enter: diff'), 'focus files');
    child.write('\r');
    await wait(() => screen().includes('edited-marker') && !screen().includes('Commit >'), 'split → pager');
    child.write('q');
    await wait(() => screen().includes('Commit >') && screen().includes('File >'), 'pager → split');
    child.write('\x1b');
    await wait(() => screen().includes('Tab/Enter'), 'focus commits');
    child.write('\x1b');
    await wait(() => !screen().includes('Calliopi · git log') && !screen().includes('Commit >'), 'split → Pi');
    console.log(`${mode}: split commits ↔ files → pager → q → Esc → Esc: OK`);

    child.write('/calliopi-log --steps\r');
    await wait(() => screen().includes('Commit >') && screen().includes('smoke commit'), 'commit list');
    child.write('\r');
    await wait(() => screen().includes('sample.txt') && /\b[0-9a-f]{7} >/.test(screen()), 'file list');
    child.write('\r');
    await wait(() => screen().includes('edited-marker') && !screen().includes('Commit >'), 'pager');
    child.write('q');
    await wait(() => /\b[0-9a-f]{7} >/.test(screen()), 'back to file list');
    child.write('\x1b');
    await wait(() => screen().includes('Commit >'), 'back to commit list');
    child.write('\x1b');
    await wait(() => !screen().includes('Calliopi · git log'), 'close to Pi');
    console.log(`${mode}: --steps commit → file → pager → q → Esc → Esc: OK`);
  } finally {
    child?.kill();
    term.dispose();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}
