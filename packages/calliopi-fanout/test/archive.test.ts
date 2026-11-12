import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ARCHIVE_RETENTION_MS, archiveTime, stampArchive } from '../lib/archive.ts';
import type { AgentView } from '../lib/types.ts';
import { defaultTasks, visibleByDefault, taskState } from '../lib/floating-model.ts';

const now = Date.parse('2026-01-02T12:00:00Z');
const archived = (extra = {}) => ({ agentId: 'a', runId: 'run-a', status: 'FINISHED', reviewAckRunId: 'run-a', archivedRunId: 'run-a', archivedAt: new Date(now - ARCHIVE_RETENTION_MS).toISOString(), ...extra });

test('archived entries expire at exactly 24h, not from creation/completion time', () => {
  const a = archived();
  assert.equal(visibleByDefault(a, now - 1), true);
  assert.equal(visibleByDefault(a, now), false);
  assert.equal(visibleByDefault(a, now + 1), false);
  assert.equal(visibleByDefault(archived({ archivedAt: new Date(now - 60_000).toISOString(), createdAt: '2000-01-01', statusChangedAt: '2000-01-01' }), now), true);
});

test('default list and counts omit expired archives without deleting history', () => {
  const history = [archived(), archived({ agentId: 'b', archivedAt: new Date(now).toISOString() }), { agentId: 'c', status: 'RUNNING' }];
  assert.deepEqual(defaultTasks(history, now).map(a => a.agentId), ['b', 'c']);
  assert.equal(defaultTasks(history, now).filter(a => taskState(a).tab === 2).length, 1);
  assert.equal(history.length, 3);
  assert.equal(history[0].agentId, 'a');
});

test('legacy archives without valid timestamps remain visible; never invent an archive date', () => {
  for (const value of [null, undefined, '', 'invalid']) {
    assert.equal(visibleByDefault(archived({ archivedAt: value }), now), true);
    assert.equal(archiveTime(value), null);
  }
  assert.equal(visibleByDefault(archived({ archivedAt: now + ARCHIVE_RETENTION_MS }), now), true);
  assert.equal(visibleByDefault(archived({ archivedRunId: undefined }), now), true);
});

test('a new run, unreviewed output, active work, and unresolved errors never age out', () => {
  assert.equal(visibleByDefault(archived({ runId: 'run-b', status: 'RUNNING' }), now), true);
  assert.equal(visibleByDefault(archived({ runId: 'run-b' }), now), true);
  assert.equal(visibleByDefault(archived({ reviewAckRunId: undefined }), now), true);
  for (const status of ['RUNNING', 'WAITING_FOR_BACKGROUND_WORK', 'ERROR', 'EXPIRED']) {
    assert.equal(visibleByDefault(archived({ status }), now), true);
  }
  assert.equal(visibleByDefault(archived({ missing: true }), now), true);
  assert.equal(visibleByDefault(archived({ git: { branches: [{ prUrl: 'https://github.com/test/repo/pull/1' }] } }), now), true);
});

test('merged and cancelled entries require explicit archive before their 24h retention starts', () => {
  const url = 'https://github.com/test/repo/pull/1';
  const merged = archived({ reviewAckRunId: undefined, git: { branches: [{ prUrl: url }] }, reviews: { [url]: { state: 'merged' } } });
  assert.equal(visibleByDefault(merged, now), false);
  assert.equal(visibleByDefault({ ...merged, archivedAt: undefined }, now), true);
  assert.equal(visibleByDefault(archived({ status: 'CANCELLED' }), now), false);
});

test('archive time is idempotent per run and resets only for an explicitly archived new run', () => {
  const a: AgentView = { runId: 'run-a' };
  stampArchive(a, now);
  assert.equal(a.archivedAt, new Date(now).toISOString());
  stampArchive(a, now + 60_000);
  assert.equal(a.archivedAt, new Date(now).toISOString());
  a.runId = 'run-b';
  stampArchive(a, now + 120_000);
  assert.equal(a.archivedRunId, 'run-b');
  assert.equal(a.archivedAt, new Date(now + 120_000).toISOString());
  const withoutRun: AgentView = {};
  stampArchive(withoutRun, now);
  assert.deepEqual(withoutRun, {});
});
