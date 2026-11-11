// Local display retention is independent of Cursor archive/delete operations.
export const ARCHIVE_RETENTION_MS = 24 * 60 * 60 * 1000;

export function archiveTime(value) {
  if (value == null || value === '') return null;
  const time = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

/** Record explicit archive time once per run. Repeating archive must not reset the clock. */
export function stampArchive(agent, now = Date.now()) {
  if (!agent.runId) return;
  if (agent.archivedRunId !== agent.runId || archiveTime(agent.archivedAt) == null) {
    agent.archivedAt = new Date(now).toISOString();
    agent.archivedRunId = agent.runId;
  }
}
