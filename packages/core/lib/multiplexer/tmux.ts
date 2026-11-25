// tmux (3.1+ for `-l N%`): TMUX is "socket,pid,session" and TMUX_PANE this pane (%N, unique per
// server). split-window runs a command given as several arguments directly, without a shell.
import { run, type MultiplexerStrategy } from '#lib/multiplexer/types.ts';

/** Wait for Enter after the program exits. Setting remain-on-exit after split-window races a fast program. */
export const holdOpen = (command: string[]) =>
  ['sh', '-c', '"$@"; printf "\\n[종료 %s] Enter로 닫기" "$?"; read _', 'sh', ...command];

export const tmux: MultiplexerStrategy = {
  id: 'tmux',
  detect(env) {
    const socket = env.TMUX?.split(',')[0], self = env.TMUX_PANE;
    if (!socket || !self) return null;
    return {
      id: 'tmux',
      name: 'tmux',
      self: { multiplexer: 'tmux', session: socket, pane: self },
      async openSide(exec, { command, cwd, ratio = 50, keepOpen = false, focus = true }) {
        const stdout = await run(exec, 'tmux', ['split-window', '-h', '-t', self, '-l', `${ratio}%`, '-c', cwd, '-P', '-F', '#{pane_id}',
          ...(focus ? [] : ['-d']), '--', ...(keepOpen ? holdOpen(command) : command)], 'tmux pane 열기');
        return { paneId: stdout.trim() || null };
      },
      async moveBeside(exec, pane, ratio) {
        await run(exec, 'tmux', ['join-pane', '-h', '-d', '-l', `${ratio}%`, '-s', pane, '-t', self], 'tmux pane 이동');
      },
      async openBackground(exec, { command, cwd, label }) {
        // new-window takes no pane as its target; without one it opens after the window TMUX_PANE is in.
        const stdout = await run(exec, 'tmux', ['new-window', '-d', '-a', '-n', label, '-c', cwd, '-P', '-F', '#{pane_id}', '--', ...command], 'tmux 창 열기');
        return { paneId: stdout.trim() || null };
      },
      async focus(exec, pane) {
        await run(exec, 'tmux', ['select-window', '-t', pane], 'tmux 창 이동');
        await run(exec, 'tmux', ['select-pane', '-t', pane], 'tmux pane 이동');
      },
      capture: (exec, pane) => run(exec, 'tmux', ['capture-pane', '-p', '-t', pane], 'tmux pane 읽기'),
    };
  },
};
