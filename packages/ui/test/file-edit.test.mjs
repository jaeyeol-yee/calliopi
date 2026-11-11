import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { changeMessage, snapshot, resolveProjectFile, sensitivePath, parseSelection, listFiles, MAX_FILE_BYTES } from '../lib/file-edit.ts';
import { editOneFile } from '../lib/editor-flow.ts';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'calliopi-ui-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('compare against the pre-editor snapshot, not Git HEAD; no-op produces no message', t => {
  const dir = fixture(t), file = "한글 ' spaces.txt";
  fs.writeFileSync(path.join(dir, file), 'already dirty\n');
  const before = snapshot(dir, file);
  assert.equal(changeMessage(file, before, snapshot(dir, file)), null);
  fs.writeFileSync(path.join(dir, file), 'new edit\n');
  const message = changeMessage(file, before, snapshot(dir, file));
  assert.match(message, /-already dirty/);
  assert.match(message, /\+new edit/);
  assert.match(message, /Do not start work solely/);
  assert.doesNotMatch(message, /calliopi-diff-/);
});

test('deletion is reported and binary/large/non-UTF-8 content is not attached', t => {
  const dir = fixture(t), absolute = path.join(dir, 'file');
  fs.writeFileSync(absolute, 'before\n');
  const before = snapshot(dir, 'file');
  fs.unlinkSync(absolute);
  assert.match(changeMessage('file', before, snapshot(dir, 'file')), /deleted/);
  for (const data of [Buffer.from([0, 255]), Buffer.from([255]), Buffer.alloc(MAX_FILE_BYTES + 1, 65)]) {
    fs.writeFileSync(absolute, data);
    const after = snapshot(dir, 'file');
    assert.equal(after.text, null);
    assert.match(changeMessage('file', before, after), /Diff omitted/);
  }
});

test('large diffs are summarized, not truncated into misleading patches', t => {
  const dir = fixture(t), file = path.join(dir, 'file');
  fs.writeFileSync(file, 'before\n');
  const before = snapshot(dir, 'file');
  fs.writeFileSync(file, 'after\n'.repeat(500));
  assert.match(changeMessage('file', before, snapshot(dir, 'file')), /over 24 KiB or 400 lines/);
});

test('sensitive names, traversal and symlinks outside project are rejected', t => {
  const dir = fixture(t), outside = fixture(t);
  fs.writeFileSync(path.join(outside, 'secret'), 'secret');
  fs.writeFileSync(path.join(dir, '.env.local'), 'secret');
  fs.symlinkSync(path.join(outside, 'secret'), path.join(dir, 'alias'));
  fs.symlinkSync(path.join(dir, '.env.local'), path.join(dir, 'env-alias'));
  for (const file of ['alias', 'env-alias', '.env.local', '../outside']) assert.throws(() => resolveProjectFile(dir, file));
  for (const file of ['.env', '.env.production', '.aws/config', 'config/credentials.json', 'cert.pem']) assert.equal(sensitivePath(file), true);
  assert.equal(sensitivePath('src/environment.ts'), false);
});

test('NUL selection preserves whitespace/newlines and must belong to candidate list', () => {
  const file = "한글 '\n spaced.txt";
  assert.equal(parseSelection(Buffer.from(`${file}\0`), [file]), file);
  assert.throws(() => parseSelection(Buffer.from('other\0'), [file]));
  assert.throws(() => parseSelection(Buffer.from('a\0b\0'), ['a', 'b']));
});

test('rg respects ignore rules and filters sensitive files before preview', t => {
  if (spawnSync('rg', ['--version']).status !== 0) return t.skip('rg not installed');
  const dir = fixture(t);
  fs.mkdirSync(path.join(dir, '.git'));
  fs.writeFileSync(path.join(dir, '.gitignore'), 'ignored.txt\n');
  for (const file of ['normal.txt', 'ignored.txt', 'secret.key', '.env', '.hidden']) fs.writeFileSync(path.join(dir, file), 'data');
  assert.deepEqual(listFiles(dir), ['normal.txt']);
});

test('flow returns on fzf cancellation and only launches Vim after valid selection', async t => {
  const dir = fixture(t), temp = fixture(t);
  fs.writeFileSync(path.join(dir, '-file with spaces'), 'before\n');
  let calls = 0;
  const result = await editOneFile({ cwd: dir, candidates: ['-file with spaces'], directory: temp, run: async (command, args) => {
    calls++;
    if (calls === 1) {
      assert.equal(command, '/bin/sh');
      assert.match(args[1], /--read0 --print0 --no-multi/);
      fs.writeFileSync(path.join(temp, 'selection'), '-file with spaces\0');
    } else {
      assert.equal(command, 'vim');
      assert.deepEqual(args, ['--', path.join(fs.realpathSync(dir), '-file with spaces')]);
      fs.writeFileSync(path.join(dir, '-file with spaces'), 'after\n');
    }
    return { exitCode: 0 };
  } });
  assert.equal(calls, 2);
  assert.match(result.content, /\+after/);
  calls = 0;
  assert.equal(await editOneFile({ cwd: dir, candidates: ['-file with spaces'], directory: temp, run: async () => { calls++; return { exitCode: 130 }; } }), null);
  assert.equal(calls, 1);
});

test('failed editor still reports saved changes; lifecycle cancellation skips reporting', async t => {
  const dir = fixture(t), temp = fixture(t);
  fs.writeFileSync(path.join(dir, 'file'), 'before\n');
  let calls = 0;
  const run = async () => {
    if (++calls === 1) fs.writeFileSync(path.join(temp, 'selection'), 'file\0');
    else fs.writeFileSync(path.join(dir, 'file'), 'saved before failure\n');
    return { exitCode: calls === 1 ? 0 : 1 };
  };
  const result = await editOneFile({ cwd: dir, candidates: ['file'], directory: temp, run });
  assert.equal(result.exitCode, 1);
  assert.match(result.content, /saved before failure/);
  assert.equal(await editOneFile({ cwd: dir, candidates: ['file'], directory: temp, run: async () => ({ exitCode: 0 }), cancelled: () => true }), null);
});
