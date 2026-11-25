// Rex: REX_SESSION and REX_BLOCK name this pane; `rex split` runs a command without a shell.
import { run, type MultiplexerStrategy } from '#lib/multiplexer/types.ts';

export const rex: MultiplexerStrategy = {
  id: 'rex',
  detect(env) {
    const session = env.REX_SESSION, block = env.REX_BLOCK;
    if (!session || !block) return null;
    return {
      id: 'rex',
      name: 'Rex',
      self: { multiplexer: 'rex', session, pane: block },
      async openSide(exec, { command, cwd, label, ratio = 50, keepOpen = false, focus = true }) {
        const stdout = await run(exec, 'rex', ['split', '-s', session, '-b', block, '--split=right', '--ratio', String(ratio), '--label', label, '-c', cwd,
          ...(keepOpen ? ['--keep-open'] : []), ...(focus ? [] : ['--focus=false']), '--json', '--', ...command], 'Rex pane 열기');
        try { return { paneId: (JSON.parse(stdout) as { block_ids?: string[] }).block_ids?.[0] ?? null }; }
        catch { return { paneId: null }; }
      },
      async moveBeside(exec, pane, ratio) {
        await run(exec, 'rex', ['move', '-s', session, pane, 'right', block, '--ratio', String(ratio)], 'Rex pane 이동');
      },
    };
  },
};
