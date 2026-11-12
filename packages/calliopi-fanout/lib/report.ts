// Aggregator: summaries, PRs and tokens of tracked agents in one report.
import { load } from '#lib/registry.ts';
import { fmtDur, isTerminal, short, cleanResult, keyVerifiedRuns, understoodRuns } from '#lib/util.ts';
import { icon } from '#lib/dashboard.ts';
import type { AgentView, FanoutConfig, GitBranch, UsageStats } from '#lib/types.ts';

const TOKEN_KEYS = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'totalTokens'] as const;

export interface ReportRow {
  label: string | null | undefined;
  agentId: string | null | undefined;
  runId: string | null | undefined;
  status: string;
  url: string | null | undefined;
  durationMs: number | null;
  result: string | null;
  usage: UsageStats | null;
  keyVerified: boolean | null;
  ack: string | null;
  summary: string | null;
  understood: string | null;
  expectedOutput: string | null;
  branches: GitBranch[];
  runCount: number;
  error: string | null;
}

export interface Report {
  generatedAt: string;
  batch: string | null;
  title: string | null;
  agents: number;
  done: number;
  allDone: boolean;
  byStatus: Record<string, number>;
  tokens: Record<(typeof TOKEN_KEYS)[number], number>;
  usageMissingRuns: number;
  totalRunDurationMs: number;
  prs: { label: string | null | undefined; agentId: string | null | undefined; prUrl: string; branch?: string | null }[];
  rows: ReportRow[];
}

export function aggregate(cfg: { registryPath: string }, { batch }: { batch?: string } = {}): Report {
  const reg = load(cfg);
  const agents = Object.values(reg.agents)
    .filter((a) => !batch || a.batch === batch)
    .sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
  const totals = Object.fromEntries(TOKEN_KEYS.map((k) => [k, 0])) as Report['tokens'];
  const byStatus: Record<string, number> = {};
  let durationMs = 0;
  let usageMissing = 0;
  const prs: Report['prs'] = [];
  const rows = agents.map((a) => {
    const st = a.missing ? 'MISSING' : a.phase === 'create_failed' ? 'CREATE_FAILED' : a.phase === 'planned' ? 'PLANNED' : a.status || 'PENDING';
    byStatus[st] = (byStatus[st] || 0) + 1;
    const runs = Object.entries(a.runs || {}).map(([id, r]) => ({ id, ...r }));
    for (const r of runs) {
      if (r.usage) for (const k of TOKEN_KEYS) totals[k] += r.usage[k] || 0;
      else if (isTerminal(r.status)) usageMissing += 1;
      if (r.durationMs) durationMs += r.durationMs;
    }
    for (const b of a.git?.branches || []) if (b.prUrl) prs.push({ label: a.label, agentId: a.agentId, prUrl: b.prUrl, branch: b.branch });
    const cur = a.runs?.[a.runId as string] || {};
    return {
      label: a.label, agentId: a.agentId, runId: a.runId, status: st, url: a.url,
      durationMs: cur.durationMs ?? null, result: cleanResult(cur.result) ?? null, usage: cur.usage ?? null,
      keyVerified: keyVerifiedRuns(a), ack: a.ack?.status ?? null,
      summary: a.summary || null, understood: understoodRuns(a, cur.result), expectedOutput: a.output || null,
      branches: a.git?.branches || [], runCount: runs.length, error: a.createError?.message || a.lastError?.message || null,
    };
  });
  const done = rows.filter((r) => isTerminal(r.status)).length;
  return {
    generatedAt: new Date().toISOString(),
    batch: batch || null,
    title: batch ? reg.batches?.[batch]?.title ?? null : null,
    agents: rows.length,
    done,
    allDone: rows.length > 0 && rows.every((r) => isTerminal(r.status) || ['MISSING', 'CREATE_FAILED'].includes(r.status)),
    byStatus,
    tokens: totals,
    usageMissingRuns: usageMissing,
    totalRunDurationMs: durationMs,
    prs,
    rows,
  };
}

export function toMarkdown(agg: Report): string {
  const L = [];
  L.push(`# ${agg.title ? `${agg.title} — ` : ''}Cursor Cloud fan-out report${agg.batch ? ` (${agg.batch})` : ''}`, '');
  L.push(`Generated ${agg.generatedAt} · ${agg.done}/${agg.agents} terminal · ${Object.entries(agg.byStatus).map(([k, v]) => `${k} ${v}`).join(', ')}`, '');
  L.push(`**Tokens** total ${agg.tokens.totalTokens.toLocaleString()} (in ${agg.tokens.inputTokens.toLocaleString()}, out ${agg.tokens.outputTokens.toLocaleString()}, cache read ${agg.tokens.cacheReadTokens.toLocaleString()}, cache write ${agg.tokens.cacheWriteTokens.toLocaleString()})${agg.usageMissingRuns ? ` — ${agg.usageMissingRuns} terminal run(s) without usage data` : ''}`);
  L.push(`**Run time** ${fmtDur(agg.totalRunDurationMs)} summed · cost: not computed (per-token pricing for Cloud Agents is not documented by the API)`, '');
  if (agg.prs.length) {
    L.push('## Pull requests', '');
    for (const p of agg.prs) L.push(`- **${p.label}** ${p.prUrl} (${p.branch || '-'})`);
    L.push('');
  }
  L.push('## Agents', '', '| | label | agent | status | time | tokens | PR |', '|---|---|---|---|---|---|---|');
  for (const r of agg.rows) {
    const pr = r.branches.map((b) => b.prUrl).filter(Boolean).join(' ');
    L.push(`| ${icon(r.status)} | ${r.label || ''} | ${short(r.agentId)} | ${r.status} | ${fmtDur(r.durationMs)} | ${r.usage?.totalTokens ?? '-'} | ${pr || '-'} |`);
  }
  L.push('');
  for (const r of agg.rows) {
    const ack = r.ack && r.ack !== 'ok' ? `  ⚠ prompt ack ${r.ack}` : '';
    L.push(`### ${icon(r.status)} ${r.label || short(r.agentId)} — ${r.status}${r.keyVerified === false ? '  ⚠ fanout key mismatch' : ''}${ack}`, '');
    if (r.summary) L.push(`- **planned:** ${r.summary}`);
    if (r.understood) L.push(`- **agent understood:** ${r.understood}`);
    if (r.expectedOutput) L.push(`- **expected output:** ${r.expectedOutput}`);
    if (r.summary || r.understood || r.expectedOutput) L.push('');
    if (r.url) L.push(`<${r.url}>`, '');
    if (r.error && !isTerminal(r.status)) L.push(`> error: ${r.error}`, '');
    L.push(r.result ? r.result : '_(no summary yet)_', '');
  }
  return L.join('\n');
}

export type { AgentView };
