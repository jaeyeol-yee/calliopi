// How an agent ended, and what its parent is told. A child that calls finish gives its own verdict;
// one that stops without it is an exception the parent should notice, not a quiet success.
import type { AgentMeta, AgentResult, EndStatus } from '#lib/agents/types.ts';

export interface EndFacts {
  finish?: Pick<AgentResult, 'status' | 'summary' | 'evidence' | 'artifacts'>;
  error?: string;
  drifted?: string;
  /** The budget dimension it used up. */
  exceeded?: string;
  idle?: boolean;
  stopped?: boolean;
  /** Its last answer, when it ended without finish. */
  lastText?: string;
}

/** The end status: its own finish first, then what the harness saw, in order of how much it explains. */
export function classifyEnd(facts: EndFacts): { status: EndStatus; reason?: string } {
  if (facts.finish) return { status: facts.finish.status };
  if (facts.error) return { status: 'error', reason: facts.error };
  if (facts.drifted) return { status: 'drifted', reason: facts.drifted };
  if (facts.exceeded) return { status: 'budget_exceeded', reason: facts.exceeded };
  if (facts.idle) return { status: 'idle', reason: '응답 없이 시간이 지났습니다' };
  if (facts.stopped) return { status: 'stopped' };
  return { status: 'unanswered', reason: 'finish 없이 끝났습니다' };
}

export const MARK: Record<EndStatus | 'running' | 'starting', string> = {
  done: '✓', partial: '◐', blocked: '✗', error: '✗', unanswered: '?', budget_exceeded: '⏱', idle: '⏱', stopped: '■', drifted: '⚠', running: '●', starting: '○',
};

export const STATUS_TEXT: Record<EndStatus, string> = {
  done: '완료', partial: '일부 완료', blocked: '막힘', error: '오류', unanswered: 'finish 없이 끝남',
  budget_exceeded: '예산 초과', idle: '무응답', stopped: '중지됨', drifted: '목적 이탈',
};

/** What the parent model reads: the contract it gave and the result, as the subagent tool's output or a wake-up. */
export function resultForParent(meta: AgentMeta, result: AgentResult): string {
  const lines = [
    `Subagent "${meta.id}" (role ${meta.role}, model ${meta.model}) ended: ${result.status}${result.reason ? ` (${result.reason})` : ''}.`,
    `Task: ${meta.call.task}`,
    ...(meta.call.done ? [`Done when: ${meta.call.done}`] : []),
    `Used: ${result.usage.turns} turns, ${result.usage.tokens} tokens, ${Math.round(result.usage.ms / 1000)}s.`,
    '',
    result.summary || '(no summary)',
    ...(result.evidence ? ['', 'Evidence:', result.evidence] : []),
    ...(result.artifacts?.length ? ['', `Artifacts: ${result.artifacts.join(', ')}`] : []),
  ];
  if (!['done', 'partial', 'blocked'].includes(result.status)) {
    lines.push('', 'It did not report through finish: treat the summary as its last words, not as a checked result.');
  }
  return lines.join('\n');
}
