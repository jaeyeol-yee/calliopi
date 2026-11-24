import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectMultiplexer, openSidePane, NoMultiplexerError, type Exec } from '#lib/pane.ts';

test('no multiplexer outside Rex; openSidePane refuses instead of falling back to an overlay', async () => {
  assert.equal(detectMultiplexer({}), null);
  assert.equal(detectMultiplexer({ REX_SESSION: 's' }), null);
  await assert.rejects(openSidePane(async () => ({ code: 0, stdout: '', stderr: '' }), { command: ['x'], cwd: '/', label: 'l' }, {}), NoMultiplexerError);
});

test('Rex: split right of this pane, command after --, block id from JSON', async () => {
  const calls: [string, string[]][] = [];
  const exec: Exec = async (command, args) => { calls.push([command, args]); return { code: 0, stdout: '{"block_ids":["blk-new"]}', stderr: '' }; };
  const env = { REX_SESSION: 'sess', REX_BLOCK: 'blk' };
  assert.deepEqual(await openSidePane(exec, { command: ['node', 'a b.ts', '--x'], cwd: '/repo', label: 'preview', ratio: 45 }, env), { multiplexer: 'Rex', paneId: 'blk-new' });
  assert.deepEqual(calls[0], ['rex', ['split', '-s', 'sess', '-b', 'blk', '--split=right', '--ratio', '45', '--label', 'preview', '-c', '/repo', '--json', '--', 'node', 'a b.ts', '--x']]);
  await openSidePane(exec, { command: ['x'], cwd: '/', label: 'l', keepOpen: true, focus: false }, env);
  const args = calls[1]![1];
  assert.deepEqual(args.slice(args.indexOf('-c') + 2, args.indexOf('--')), ['--keep-open', '--focus=false', '--json']);
  const failing: Exec = async () => ({ code: 1, stdout: '', stderr: 'no such block\n' });
  await assert.rejects(openSidePane(failing, { command: ['x'], cwd: '/', label: 'l' }, env), /no such block/);
});
