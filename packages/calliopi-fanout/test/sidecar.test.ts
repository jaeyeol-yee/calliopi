import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { attach, detach, owner, enqueue, drain } from '../lib/sidecar.ts';
import type { SidecarMessage } from '../lib/types.ts';

test('dedicated session mailbox: exclusive, targeted, durable across reload, no duplicate delivery', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fanout-sidecar-'));
  try {
    assert.throws(() => enqueue(dir, { goal: 'test' }), /No live/);
    const a = attach(dir, { sessionId: 'side' });
    assert.equal(owner(dir)!.sessionId, 'side');
    assert.throws(() => attach(dir, { sessionId: 'other' }), /already attached/);
    detach(dir, 'wrong-token');
    assert.equal(owner(dir)!.token, a.token);
    enqueue(dir, { goal: 'parallel analysis' });
    const received: SidecarMessage[] = [];
    drain(dir, 'wrong-token', value => received.push(value));
    assert.equal(received.length, 0);
    detach(dir, a.token);
    const resumed = attach(dir, { sessionId: 'side', token: a.token });
    drain(dir, resumed.token, value => received.push(value));
    drain(dir, resumed.token, value => received.push(value));
    assert.deepEqual(received as unknown, [{ goal: 'parallel analysis' }]);
    enqueue(dir, { goal: 'retry after callback failure' });
    assert.throws(() => drain(dir, a.token, () => { throw new Error('busy'); }), /busy/);
    drain(dir, a.token, (value) => { received.push(value); });
    assert.equal(received.length, 2);
    detach(dir, a.token);
    assert.equal(owner(dir), null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
