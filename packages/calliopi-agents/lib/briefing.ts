// The background a child gets with context "summary": the parent's own summary at the moment it
// delegates. It is not made on every turn — only when a task is handed over — and only the part
// since the last one is summarized: Pi's summarizer (the one compaction uses) updates the previous
// summary when given it. It runs alongside the children starting; each child gets its slice in its
// inbox and takes it before its task, or as a late message if the task has already gone.
import { generateSummaryWithUsage, type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { postInbox, type AgentRecord, type AgentRole } from '@calliopi/core/agents';

export const SUMMARY_ENTRY = 'calliopi-summary';

export interface SummaryEntryData {
  summary: string;
  /** The last entry the summary covers. */
  upTo: string | null;
  reason: 'spawn';
  agents: string[];
  at: number;
}

type Entry = { type: string; id: string; customType?: string; data?: unknown; summary?: string; message?: unknown };

/**
 * What to summarize, from the active context (compaction applied): the messages after the latest
 * delegation summary, or after the latest compaction (whose summary is then the previous one), or
 * all of them. `previous` alone, with no messages, needs no request.
 */
export function summaryInput(entries: readonly Entry[]): { previous?: string; messages: unknown[]; upTo: string | null } {
  let start = 0, previous: string | undefined;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!;
    if (e.type === 'custom' && e.customType === SUMMARY_ENTRY) {
      // The summary covers the context up to its `upTo` entry, not up to where it was written: messages
      // that came while it was being made are after `upTo` and must be in the next one.
      const data = e.data as SummaryEntryData;
      previous = data.summary;
      const covered = data.upTo ? entries.findIndex(x => x.id === data.upTo) : -1;
      start = covered >= 0 && covered < i ? covered + 1 : i + 1;
      break;
    }
    if (e.type === 'compaction' && e.summary) { previous = e.summary; start = i + 1; break; }
  }
  const messages = entries.slice(start).flatMap(e => (e.type === 'message' && e.message ? [e.message] : []));
  return { previous, messages, upTo: entries.at(-1)?.id ?? null };
}

/** Sections of Pi's summary format a role gets. Roles that may change files also get Progress. */
export function sectionsFor(role: Pick<AgentRole, 'tools' | 'disallowedTools'>): string[] {
  const writes = (role.tools ?? ['edit', 'write']).some(t => (t === 'edit' || t === 'write') && !role.disallowedTools.includes(t));
  return ['Goal', 'Constraints & Preferences', ...(writes ? ['Progress'] : []), 'Key Decisions', 'Critical Context'];
}

/** The `## Heading` sections of a summary that are named; the whole summary when none of them is there. */
export function sliceSummary(summary: string, sections: string[]): string {
  const parts = summary.split(/^(?=## )/m);
  const kept = parts.filter(p => sections.some(s => p.startsWith(`## ${s}\n`) || p.trim() === `## ${s}`));
  return (kept.length ? kept.join('') : summary).trim();
}

/**
 * Summarize and brief the children that asked for it. Not awaited by the tool: the children start
 * meanwhile. A failure briefs them with nothing, so they stop waiting at once.
 */
export async function brief(pi: ExtensionAPI, ctx: ExtensionContext, records: AgentRecord[], roles: Map<string, AgentRole>): Promise<void> {
  const wanting = records.filter(r => r.meta.call.context === 'summary');
  if (!wanting.length) return;
  const send = (text: string) => {
    for (const r of wanting) {
      const role = roles.get(r.meta.role);
      postInbox(r.dir, { id: `briefing-${r.meta.id}`, kind: 'briefing', text: text && role ? sliceSummary(text, sectionsFor(role)) : text, at: Date.now() });
    }
  };
  try {
    const input = summaryInput(ctx.sessionManager.buildContextEntries() as Entry[]);
    let summary = input.previous ?? '';
    if (input.messages.length) {
      const model = ctx.model;
      if (!model) throw new Error('요약할 모델이 없습니다');
      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
      if (!auth.ok) throw new Error(auth.error);
      const result = await generateSummaryWithUsage(
        input.messages as never, model, undefined, auth.apiKey, auth.headers as Record<string, string> | undefined, undefined, undefined, input.previous,
        undefined, (m, c, o) => ctx.modelRegistry.streamSimple(m, c, o), auth.env,
      );
      summary = result.text;
      pi.appendEntry<SummaryEntryData>(SUMMARY_ENTRY, { summary, upTo: input.upTo, reason: 'spawn', agents: records.map(r => r.meta.id), at: Date.now() });
    }
    send(summary);
  } catch (error) {
    send('');
    ctx.ui.notify(`서브에이전트 배경 요약 실패: ${error instanceof Error ? error.message : String(error)} — 과제만으로 진행합니다.`, 'warning');
  }
}
