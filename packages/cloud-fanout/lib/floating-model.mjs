import { reviewSummary } from './github-review.mjs';

export const TABS = ['진행', '검토', '보관'];
export function taskState(a) {
  if (a.localApproval) return { tab: 0, text: '승인 대기', icon: '◷', color: 'warning' };
  if (a.missing || a.phase === 'create_failed' || ['ERROR', 'EXPIRED'].includes(a.status)) return { tab: 0, text: '확인 필요', icon: '!', color: 'warning' };
  if (a.status === 'CANCELLED') return { tab: 2, text: '취소됨', icon: '−', color: 'dim' };
  if (a.status !== 'FINISHED') return { tab: 0, text: a.status === 'WAITING_FOR_BACKGROUND_WORK' ? '작업 대기' : a.status === 'RUNNING' ? '실행 중' : '준비 중', icon: a.status === 'RUNNING' ? '↻' : '◷', color: a.status === 'RUNNING' ? 'accent' : 'dim' };
  const r = reviewSummary(a);
  if (r.state === 'merged') return { tab: 2, text: '병합됨', icon: '✓', color: 'success' };
  if (r.state === 'acknowledged') return { tab: 2, text: '확인함', icon: '✓', color: 'dim' };
  return { tab: 1, text: r.text, icon: '◇', color: 'accent' };
}
export function freshness(a, now = Date.now()) {
  const urls = (a?.git?.branches || []).map(b => b.prUrl).filter(Boolean);
  if (!urls.length) return 'GitHub PR 없음';
  const records = urls.map(url => a.reviews?.[url]);
  if (records.some(r => r?.deferredUntil > now)) return '갱신 대기';
  const stamps = records.map(r => r?.checkedAt).filter(n => n != null);
  const age = stamps.length ? Math.max(0, now - Math.min(...stamps)) : Infinity;
  const label = age < 60_000 ? '방금 확인' : Number.isFinite(age) ? `${Math.floor(age / 60_000)}분 전 확인` : '아직 확인 전';
  return `${label}${records.some(r => r?.lastError) ? ' · 확인 불가' : age > 240_000 ? ' · 오래된 정보' : ''}`;
}
export const plain = s => String(s || '').replace(/[\x00-\x1f\x7f-\x9f]/g, ' ');
