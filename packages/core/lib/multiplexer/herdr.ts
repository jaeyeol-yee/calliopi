// herdr: HERDR_PANE_ID names this pane (w1:p1, unique per session), HERDR_SOCKET_PATH its session.
// `herdr pane split` takes no command: the new pane starts the user's shell, and `herdr pane run`
// types a line into it. That line only runs a script, so the program and its arguments never meet
// the user's shell (zsh, fish …) and its quoting. A leading space keeps the line out of shell history.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run, type Exec, type MultiplexerStrategy } from '#lib/multiplexer/types.ts';

/** POSIX single quoting. */
export const quote = (arg: string) => `'${arg.replaceAll("'", `'\\''`)}'`;

/** A script that removes itself and then becomes `command`. */
export function writeLauncher(command: string[], dir = fs.mkdtempSync(path.join(os.tmpdir(), 'calliopi-pane-'))) {
  const file = path.join(dir, 'run.sh');
  fs.writeFileSync(file, `rm -rf ${quote(dir)}\nexec ${command.map(quote).join(' ')}\n`, { mode: 0o600 });
  return file;
}

/** herdr's ratio is the share kept by the pane that is split (or moved beside). */
const keep = (percent: number) => String(Math.round(100 - percent) / 100);

const paneId = (stdout: string) => {
  try { return (JSON.parse(stdout) as { result?: { pane?: { pane_id?: string; tab_id?: string } } }).result?.pane ?? null; }
  catch { return null; }
};

export const herdr: MultiplexerStrategy = {
  id: 'herdr',
  detect(env) {
    const self = env.HERDR_PANE_ID;
    if (!self) return null;
    const session = env.HERDR_SOCKET_PATH || env.HERDR_SESSION || 'default';
    const herdrRun = (exec: Exec, args: string[], what: string) => run(exec, 'herdr', args, what);
    return {
      id: 'herdr',
      name: 'herdr',
      self: { multiplexer: 'herdr', session, pane: self },
      async openSide(exec, { command, cwd, label, ratio = 50, keepOpen = false, focus = true }) {
        const pane = paneId(await herdrRun(exec, ['pane', 'split', self, '--direction', 'right', '--ratio', keep(ratio), '--cwd', cwd,
          focus ? '--focus' : '--no-focus'], 'herdr pane 열기'))?.pane_id;
        if (!pane) throw new Error('herdr가 새 pane id를 알려주지 않았습니다.');
        const launcher = writeLauncher(command);
        try {
          // keepOpen: the user's shell stays once the program exits; otherwise the program replaces it.
          await herdrRun(exec, ['pane', 'run', pane, ` ${keepOpen ? '' : 'exec '}sh ${quote(launcher)}`], 'herdr pane 실행');
        } catch (error) {
          fs.rmSync(path.dirname(launcher), { recursive: true, force: true });
          await exec('herdr', ['pane', 'close', pane], { timeout: 10_000 });
          throw error;
        }
        await exec('herdr', ['pane', 'rename', pane, label], { timeout: 10_000 }); // cosmetic: a failure is fine
        return { paneId: pane };
      },
      async moveBeside(exec, pane, ratio) {
        // HERDR_TAB_ID is where this pane started; it may have moved since.
        const tab = paneId(await herdrRun(exec, ['pane', 'get', self], 'herdr pane 조회'))?.tab_id;
        if (!tab) throw new Error('herdr에서 현재 탭을 찾지 못했습니다.');
        await herdrRun(exec, ['pane', 'move', pane, '--tab', tab, '--split', 'right', '--target-pane', self, '--ratio', keep(ratio), '--no-focus'], 'herdr pane 이동');
      },
    };
  },
};
