import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadScenario } from '../lib/scenario.ts';
import { buildTape, defaultWait, vhsRegex, vhsString } from '../lib/tape.ts';

test('default wait matches the last words of the final text, regex-escaped', () => {
  assert.equal(defaultWait([{ text: 'first\n바꾸면 됩니다. 진행할까요?' }]), '됩니다\\. 진행할까요\\?');
  assert.equal(defaultWait([{ text: 'see `login()`' }]), undefined);
  assert.equal(defaultWait([{ thinking: 'x' }]), undefined);
});

test('VHS literals pick a free quote and escape slashes in regexes', () => {
  assert.equal(vhsString('say "hi"'), `'say "hi"'`);
  assert.equal(vhsString(`a"b'c`), '`a"b\'c`');
  assert.throws(() => vhsString('"\'`'));
  assert.equal(vhsRegex('a/b'), '/a\\/b/');
});

test('tape types prompts, sends them, and waits for each reply', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'calliopi-demo-test-'));
  const file = path.join(dir, 't.yaml');
  fs.writeFileSync(file, 'turns:\n  - prompt: "line 1\\nline 2"\n    reply: [{ text: all done }]\n');
  const tape = buildTape(loadScenario(file), { output: '/o.gif', workdir: '/w', env: { A: '1' }, pi: 'pi' });
  assert.match(tape, /Output "\/o\.gif"/);
  assert.match(tape, /Env A "1"/);
  assert.match(tape, /Type "line 1"\nShift\+Enter\nType "line 2"\nSleep 400ms\nEnter\nWait\+Screen@60s \/all done\//);
});
