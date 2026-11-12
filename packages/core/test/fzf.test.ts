import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { selectCommand, parseSelectResult, fzfSelect, fzfEnv, cleanDisplay, shellQuote, nodePreview } from '#lib/fzf.ts';

test('fzf command hides the index column, ignores user defaults and restores cursor only without query', () => {
  const cmd = selectCommand({ listPath: "/tmp/it's", outPath: '/tmp/o', prompt: 'Commit > ', preview: 'p {1}', query: '', position: 3 });
  assert.match(cmd, /--read0 --print0 --print-query --no-multi/);
  assert.match(cmd, /--with-nth=2\.\./);
  assert.match(cmd, /load:pos\(3\)/);
  assert.match(cmd, /'\/tmp\/it'\\''s'/);
  assert.doesNotMatch(selectCommand({ listPath: 'l', outPath: 'o', prompt: '>', query: 'fix', position: 3 }), /pos\(/);
  assert.deepEqual(parseSelectResult(Buffer.from('fix\x002\tdisplay\0'), 3), { index: 2, query: 'fix' });
  for (const bad of ['q\x003\tx\0', 'q\x00-1\tx\0', 'q\x00\0', 'q\x00x\ty\0']) assert.throws(() => parseSelectResult(Buffer.from(bad), 3));
});

test('quoting, display cleaning, env reset and node preview', () => {
  assert.equal(shellQuote("a'b"), `'a'\\''b'`);
  assert.equal(cleanDisplay('a\tb\nc\x1b'), 'a b c ');
  const env = fzfEnv({ X: '1' });
  assert.equal(env.FZF_DEFAULT_OPTS, '');
  assert.equal(env.SHELL, '/bin/sh');
  assert.equal(env.X, '1');
  assert.equal(nodePreview('/s.ts', '/state'), `${shellQuote(process.execPath)} '/s.ts' '/state' {1}`);
});

test('fzfSelect writes indexed items, maps exit codes and parses the selection', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'calliopi-fzf-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let code = 0;
  const run = async (_c: string, args: string[]) => {
    assert.match(args[1], /exec fzf /);
    fs.writeFileSync(path.join(dir, 'pick.out'), 'q\x001\tb\0');
    return { exitCode: code };
  };
  assert.deepEqual(await fzfSelect({ run, directory: dir, name: 'pick', items: ['a', 'b\tx'], prompt: '> ' }), { index: 1, query: 'q' });
  assert.equal(fs.readFileSync(path.join(dir, 'pick.list'), 'utf8'), '0\ta\x001\tb x\0');
  for (code of [1, 130, -1]) assert.equal(await fzfSelect({ run, directory: dir, name: 'pick', items: ['a'], prompt: '> ' }), null);
  code = 2;
  await assert.rejects(fzfSelect({ run, directory: dir, name: 'pick', items: ['a'], prompt: '> ' }), /fzf 종료 코드: 2/);
});
