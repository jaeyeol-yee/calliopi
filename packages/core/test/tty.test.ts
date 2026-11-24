import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ttyRun } from '#lib/tty.ts';

test('ttyRun reports exit codes and passes the environment; a missing program is -1', async () => {
  assert.deepEqual(await ttyRun('/bin/sh', ['-c', 'exit 3']), { exitCode: 3 });
  assert.deepEqual(await ttyRun('/bin/sh', ['-c', '[ "$X" = 1 ]'], { ...process.env, X: '1' }), { exitCode: 0 });
  assert.deepEqual(await ttyRun('/nonexistent/program', []), { exitCode: -1 });
});
