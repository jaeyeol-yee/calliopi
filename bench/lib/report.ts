// The benchmark report: per arm and task class, the pass rate with its range across repetitions, cost
// and tendency signals; per class, the threshold (cheapest arm whose every repetition reaches the
// target) and the effort saturation point within a model; per lineage, how versions compare.
import { catalogModel, EFFORTS } from './catalog.ts';
import { runCost, type RunRecord } from './run.ts';

export interface Cell {
  arm: string; model: string; effort: string; harness: string; taskClass: string;
  runs: number; passes: number;
  /** Pass rate of the worst and best repetition. */
  min: number; max: number;
  /** Medians per run, with the range: caching makes one run's cost a poor estimate. */
  costPerRun: number; costMin: number; costMax: number;
  turns: number; tokens: number; tokensMin: number; tokensMax: number; cacheHit: number;
  toolErrors: number; parallelShare: number; outOfScope: number; timeouts: number;
  /** Subagents started, and how many were cut off before they ended. */
  delegations: number; childrenStopped: number;
}

export const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b), mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
};

const groupBy = <T>(xs: T[], key: (x: T) => string) => {
  const m = new Map<string, T[]>();
  for (const x of xs) m.set(key(x), [...m.get(key(x)) ?? [], x]);
  return m;
};

export function cells(records: RunRecord[]): Cell[] {
  return [...groupBy(records, r => `${r.arm}\0${r.taskClass}`).values()].map(rs => {
    const r0 = rs[0]!;
    const byRep = [...groupBy(rs, r => String(r.rep)).values()].map(g => g.filter(r => r.pass).length / g.length);
    const sum = (f: (r: RunRecord) => number) => rs.reduce((a, r) => a + f(r), 0);
    const prompt = sum(r => r.signals.input + r.signals.cacheRead + r.signals.cacheWrite);
    const turns = sum(r => r.signals.turns);
    const costs = rs.map(runCost), tokens = rs.map(r => r.signals.input + r.signals.output + r.signals.cacheRead + r.signals.cacheWrite);
    return {
      arm: r0.arm, model: r0.model, effort: r0.effort, harness: r0.harness, taskClass: r0.taskClass,
      runs: rs.length, passes: rs.filter(r => r.pass).length, min: Math.min(...byRep), max: Math.max(...byRep),
      costPerRun: median(costs), costMin: Math.min(...costs), costMax: Math.max(...costs),
      turns: median(rs.map(r => r.signals.turns)),
      tokens: median(tokens), tokensMin: Math.min(...tokens), tokensMax: Math.max(...tokens),
      cacheHit: prompt ? sum(r => r.signals.cacheRead) / prompt : 0,
      toolErrors: sum(r => r.signals.toolErrors), parallelShare: turns ? sum(r => r.signals.parallelCalls) / turns : 0,
      outOfScope: rs.filter(r => r.outOfScope.length).length, timeouts: rs.filter(r => r.timedOut).length,
      delegations: sum(r => r.children?.count ?? 0), childrenStopped: sum(r => r.children?.ends.stopped ?? 0),
    };
  }).sort((a, b) => a.taskClass.localeCompare(b.taskClass) || a.costPerRun - b.costPerRun);
}

/** Per class: the arm (harness on) with the lowest median cost whose worst repetition reaches the target. */
export function thresholds(cs: Cell[], target: number): Map<string, Cell | undefined> {
  const out = new Map<string, Cell | undefined>();
  for (const [cls, g] of groupBy(cs, c => c.taskClass))
    out.set(cls, g.filter(c => c.harness === 'on' && c.min >= target).sort((a, b) => a.costPerRun - b.costPerRun)[0]);
  return out;
}

/** Per class and model with two or more efforts: the lowest effort after which the pass rate no longer rises. */
export function saturation(cs: Cell[]): { taskClass: string; model: string; effort: string; rate: number }[] {
  const out: { taskClass: string; model: string; effort: string; rate: number }[] = [];
  for (const g of groupBy(cs.filter(c => c.harness === 'on'), c => `${c.taskClass}\0${c.model}`).values()) {
    if (g.length < 2) continue;
    const sorted = [...g].sort((a, b) => EFFORTS.indexOf(a.effort as never) - EFFORTS.indexOf(b.effort as never));
    const rate = (c: Cell) => c.passes / c.runs;
    const best = Math.max(...sorted.map(rate));
    const at = sorted.find(c => rate(c) >= best)!;
    out.push({ taskClass: at.taskClass, model: at.model, effort: at.effort, rate: best });
  }
  return out;
}

/** Same lineage, same effort and harness: versions side by side, newest last, with the change in pass rate. */
export function lineages(cs: Cell[]): { lineage: string; taskClass: string; effort: string; versions: { model: string; rate: number; delta?: number }[] }[] {
  const known = cs.filter(c => catalogModel(c.model));
  const out = [];
  for (const g of groupBy(known, c => `${catalogModel(c.model)!.lineage}\0${c.taskClass}\0${c.effort}\0${c.harness}`).values()) {
    const models = [...groupBy(g, c => c.model).values()];
    if (models.length < 2) continue;
    const versions = models.map(m => ({ model: m[0]!.model, order: catalogModel(m[0]!.model)!.order, rate: m.reduce((a, c) => a + c.passes, 0) / m.reduce((a, c) => a + c.runs, 0) }))
      .sort((a, b) => a.order - b.order)
      .map((v, i, all) => ({ model: v.model, rate: v.rate, ...(i ? { delta: v.rate - all[i - 1]!.rate } : {}) }));
    out.push({ lineage: catalogModel(g[0]!.model)!.lineage, taskClass: g[0]!.taskClass, effort: g[0]!.effort, versions });
  }
  return out;
}

const pct = (x: number) => `${Math.round(x * 100)}%`;
const usd = (x: number) => `$${x.toFixed(x < 0.1 ? 4 : 2)}`;

export function formatReport(records: RunRecord[], target: number): string {
  if (!records.length) return 'No runs recorded.';
  const cs = cells(records);
  const prov = [...new Set(records.map(r => `Pi ${r.piVersion} · harness ${r.harnessSha}${r.harnessCommit && r.harnessCommit !== r.harnessSha ? ` (arm at ${r.harnessCommit})` : ''} · tasks ${[...new Set(records.map(x => `${x.task}@v${x.taskVersion}`))].join(', ')}`))];
  const lines = [`# Benchmark: ${[...new Set(records.map(r => r.spec))].join(', ')}`, '', ...prov.map(p => `- ${p}`), `- ${records.length} runs, ${usd(records.reduce((a, r) => a + runCost(r), 0))} total`, '',
    '## By arm and task class', '',
    'Cost includes subagents. Cost, turns and tokens (the run\'s own) are medians per run; ranges are min–max.', '',
    '| class | arm | harness | pass | worst–best rep | $/run | $ range | turns | tokens | tokens range | cache hit | tool errors | parallel | out of scope | timeouts | subagents (stopped) |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|'];
  for (const c of cs)
    lines.push(`| ${c.taskClass} | ${c.arm} | ${c.harness} | ${c.passes}/${c.runs} | ${pct(c.min)}–${pct(c.max)} | ${usd(c.costPerRun)} | ${usd(c.costMin)}–${usd(c.costMax)} | ${c.turns.toFixed(1)} | ${Math.round(c.tokens)} | ${Math.round(c.tokensMin)}–${Math.round(c.tokensMax)} | ${pct(c.cacheHit)} | ${c.toolErrors} | ${pct(c.parallelShare)} | ${c.outOfScope} | ${c.timeouts} | ${c.delegations} (${c.childrenStopped}) |`);
  lines.push('', `## Threshold per class (lowest median cost among arms whose worst repetition reaches ${pct(target)})`, '');
  for (const [cls, c] of thresholds(cs, target)) lines.push(`- ${cls}: ${c ? `${c.arm} at ${usd(c.costPerRun)}/run` : 'none reaches the target'}`);
  const sat = saturation(cs);
  if (sat.length) { lines.push('', '## Effort saturation (lowest effort with the best pass rate)', ''); for (const s of sat) lines.push(`- ${s.taskClass} · ${s.model}: ${s.effort} (${pct(s.rate)})`); }
  const lin = lineages(cs);
  if (lin.length) {
    lines.push('', '## Versions within a lineage', '');
    for (const l of lin) lines.push(`- ${l.lineage} · ${l.taskClass} @${l.effort}: ${l.versions.map(v => `${v.model.split('/')[1]} ${pct(v.rate)}${v.delta !== undefined ? ` (${v.delta >= 0 ? '+' : ''}${Math.round(v.delta * 100)}pp)` : ''}`).join(' → ')}`);
  }
  lines.push('', 'Differences smaller than the spread between replicate arms of the same model are noise.');
  return lines.join('\n');
}
