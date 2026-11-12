import { reviewSummary } from '#lib/github-review.ts';
import { ARCHIVE_RETENTION_MS, archiveTime } from '#lib/archive.ts';
import type { AgentView } from '#lib/types.ts';

/** Hide only explicitly archived, resolved entries of the same run after a full 24h. */
export function visibleByDefault(agent: AgentView, now = Date.now()): boolean {
  const archivedAt = archiveTime(agent.archivedAt);
  return taskState(agent).tab !== 2 || !agent.runId || agent.archivedRunId !== agent.runId || archivedAt == null || now - archivedAt < ARCHIVE_RETENTION_MS;
}

export const defaultTasks = (agents: AgentView[], now = Date.now()): AgentView[] => agents.filter((a) => visibleByDefault(a, now));

export const TABS = ['진행', '검토', '보관'];
export function taskState(a: AgentView): { tab: number; text: string; icon: string; color: string } {
  if (a.localApproval) return { tab: 0, text: '승인 대기', icon: '◷', color: 'warning' };
  if (a.missing || a.phase === 'create_failed' || ['ERROR', 'EXPIRED'].includes(a.status || '')) return { tab: 0, text: '확인 필요', icon: '!', color: 'warning' };
  if (a.status === 'CANCELLED') return { tab: 2, text: '취소됨', icon: '−', color: 'dim' };
  if (a.status !== 'FINISHED') return { tab: 0, text: a.status === 'WAITING_FOR_BACKGROUND_WORK' ? '작업 대기' : a.status === 'RUNNING' ? '실행 중' : '준비 중', icon: a.status === 'RUNNING' ? '↻' : '◷', color: a.status === 'RUNNING' ? 'accent' : 'dim' };
  const r = reviewSummary(a);
  if (r.state === 'merged') return { tab: 2, text: '병합됨', icon: '✓', color: 'success' };
  if (r.state === 'acknowledged') return { tab: 2, text: '확인함', icon: '✓', color: 'dim' };
  return { tab: 1, text: r.text, icon: '◇', color: 'accent' };
}
export function freshness(a: AgentView | null | undefined, now = Date.now()): string {
  const urls = (a?.git?.branches || []).map((b) => b.prUrl).filter((u): u is string => Boolean(u));
  if (!urls.length) return 'GitHub PR 없음';
  const records = urls.map((url) => a?.reviews?.[url]);
  if (records.some((r) => (r?.deferredUntil as number) > now)) return '갱신 대기';
  const stamps = records.map((r) => r?.checkedAt).filter((n): n is number => n != null);
  const age = stamps.length ? Math.max(0, now - Math.min(...stamps)) : Infinity;
  const label = age < 60_000 ? '방금 확인' : Number.isFinite(age) ? `${Math.floor(age / 60_000)}분 전 확인` : '아직 확인 전';
  return `${label}${records.some((r) => r?.lastError) ? ' · 확인 불가' : age > 240_000 ? ' · 오래된 정보' : ''}`;
}
export const plain = (s: string | null | undefined): string => String(s || '').replace(/[\x00-\x1f\x7f-\x9f]/g, ' ');
