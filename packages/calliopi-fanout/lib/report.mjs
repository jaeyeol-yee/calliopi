// Aggregator: summaries, PRs and tokens of tracked agents in one report.
import { load } from './registry.mjs';
import { fmtDur, isTerminal, short, cleanResult, keyVerified, understood } from './util.mjs';
import { icon } from './dashboard.mjs';

const TOKEN_KEYS = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'totalTokens'];

export function aggregate(cfg, { batch } = {}) {
  const reg = load(cfg);
  const agents = Object.values(reg.agents)
    .filter((a) => !batch || a.batch === batch)
    .sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
  const totals = Object.fromEntries(TOKEN_KEYS.map((k) => [k, 0]));
  const byStatus = {};
  let durationMs = 0;
  let usageMissing = 0;
  const prs = [];
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
    const cur = a.runs?.[a.runId] || {};
    return {
      label: a.label, agentId: a.agentId, runId: a.runId, status: st, url: a.url,
      durationMs: cur.durationMs ?? null, result: cleanResult(cur.result) ?? null, usage: cur.usage ?? null,
      keyVerified: keyVerified(a, cur.result),
      summary: a.summary || null, understood: understood(cur.result), expectedOutput: a.output || null,
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

export function toMarkdown(agg) {
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
    L.push(`### ${icon(r.status)} ${r.label || short(r.agentId)} — ${r.status}${r.keyVerified === false ? '  ⚠ fanout key mismatch' : ''}`, '');
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
