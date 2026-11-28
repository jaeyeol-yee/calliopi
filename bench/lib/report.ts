// The benchmark report: per arm and task class, the strict pass rate (every dimension of the task passed)
// with its range across repetitions, the pass rate per dimension, extra findings, cost and tendency signals; per class, the threshold (cheapest arm whose every repetition reaches the
// target) and the effort saturation point within a model; per lineage, how versions compare.
import { catalogModel, EFFORTS } from './catalog.ts';
import { runCost, type RunRecord } from './run.ts';
import { DIMENSIONS, type Dimension } from './task.ts';

export interface Cell {
  arm: string; model: string; effort: string; harness: string; taskClass: string;
  /** passes: strict passes. */
  runs: number; passes: number;
  /** Per dimension: the runs it applied to and how many passed it. */
  dimensions: Partial<Record<Dimension, { runs: number; passes: number }>>;
  /** Findings cited beyond the real bugs, and the runs that had any. */
  extraFindings: number; extraRuns: number;
  /** Over runs with a content check: the median of the answer's words, and the share of all their words in needed, allowed and surplus blocks. Undefined without such runs. */
  answerWords?: number; neededShare?: number; allowedShare?: number; surplusShare?: number;
  /** Pass rate of the worst and best repetition. */
  min: number; max: number;
  /** Medians per run, with the range: caching makes one run's cost a poor estimate. */
  costPerRun: number; costMin: number; costMax: number;
  turns: number; tokens: number; tokensMin: number; tokensMax: number; cacheHit: number;
  toolErrors: number; parallelShare: number; outOfScope: number; timeouts: number;
  /** Runs that ended on a provider error; they are left out of pass, cost and the rest. */
  errors: number;
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

/** A record's dimensions; records from before dimensions had one verdict, the outcome. */
export const dimensionsOf = (r: RunRecord): Partial<Record<Dimension, boolean>> => r.dimensions ?? { outcome: r.pass };

/** How the words of the runs' answers split into needed, allowed and surplus blocks (pooled over the runs), with the median answer length. */
export function contentShares(rs: RunRecord[]): { answerWords?: number; neededShare?: number; allowedShare?: number; surplusShare?: number } {
  const cs = rs.flatMap(r => (r.content ? [r.content] : []));
  const words = cs.reduce((a, c) => a + c.words, 0);
  if (!cs.length) return {};
  const share = (f: (c: (typeof cs)[number]) => number) => (words ? cs.reduce((a, c) => a + f(c), 0) / words : 0);
  return { answerWords: median(cs.map(c => c.words)), neededShare: share(c => c.words - (c.allowedWords ?? 0) - c.surplusWords), allowedShare: share(c => c.allowedWords ?? 0), surplusShare: share(c => c.surplusWords) };
}

/** Results of different versions of a task do not mix: only each task's newest recorded version counts. */
export function currentVersions(records: RunRecord[]): RunRecord[] {
  const newest = new Map<string, number>();
  for (const r of records) newest.set(r.task, Math.max(newest.get(r.task) ?? 0, r.taskVersion));
  return records.filter(r => r.taskVersion === newest.get(r.task));
}

export function cells(records: RunRecord[]): Cell[] {
  return [...groupBy(currentVersions(records), r => `${r.arm}\0${r.taskClass}`).values()].flatMap(all => {
    const rs = all.filter(r => !r.error);
    if (!rs.length) return [];
    const r0 = rs[0]!;
    const byRep = [...groupBy(rs, r => String(r.rep)).values()].map(g => g.filter(r => r.pass).length / g.length);
    const sum = (f: (r: RunRecord) => number) => rs.reduce((a, r) => a + f(r), 0);
    const prompt = sum(r => r.signals.input + r.signals.cacheRead + r.signals.cacheWrite);
    const turns = sum(r => r.signals.turns);
    const costs = rs.map(runCost), tokens = rs.map(r => r.signals.input + r.signals.output + r.signals.cacheRead + r.signals.cacheWrite);
    return {
      arm: r0.arm, model: r0.model, effort: r0.effort, harness: r0.harness, taskClass: r0.taskClass,
      runs: rs.length, passes: rs.filter(r => r.pass).length,
      dimensions: Object.fromEntries(DIMENSIONS.flatMap(d => {
        const of = rs.flatMap(r => (dimensionsOf(r)[d] === undefined ? [] : [dimensionsOf(r)[d]!]));
        return of.length ? [[d, { runs: of.length, passes: of.filter(Boolean).length }]] : [];
      })),
      extraFindings: sum(r => r.extraFindings ?? 0), extraRuns: rs.filter(r => r.extraFindings).length,
      ...contentShares(rs),
      min: Math.min(...byRep), max: Math.max(...byRep),
      costPerRun: median(costs), costMin: Math.min(...costs), costMax: Math.max(...costs),
      turns: median(rs.map(r => r.signals.turns)),
      tokens: median(tokens), tokensMin: Math.min(...tokens), tokensMax: Math.max(...tokens),
      cacheHit: prompt ? sum(r => r.signals.cacheRead) / prompt : 0,
      toolErrors: sum(r => r.signals.toolErrors), parallelShare: turns ? sum(r => r.signals.parallelCalls) / turns : 0,
      outOfScope: rs.filter(r => r.outOfScope.length).length, timeouts: rs.filter(r => r.timedOut).length,
      delegations: sum(r => r.children?.count ?? 0), childrenStopped: sum(r => r.children?.ends.stopped ?? 0),
      errors: all.length - rs.length,
    };
  }).sort((a, b) => a.taskClass.localeCompare(b.taskClass) || a.costPerRun - b.costPerRun);
}

/** Per class: the arm (harness on) with the lowest median cost whose worst repetition reaches the target in strict passes. */
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
  const stale = records.length - currentVersions(records).length;
  records = currentVersions(records);
  const errors = records.filter(r => r.error);
  const cs = cells(records);
  const dims = (c: Cell) => DIMENSIONS.flatMap(d => (c.dimensions[d] ? [`${d} ${c.dimensions[d]!.passes}/${c.dimensions[d]!.runs}`] : [])).join(' · ');
  const prov = [...new Set(records.map(r => `Pi ${r.piVersion} · harness ${r.harnessSha}${r.harnessCommit && r.harnessCommit !== r.harnessSha ? ` (arm at ${r.harnessCommit})` : ''} · tasks ${[...new Set(records.map(x => `${x.task}@v${x.taskVersion}`))].join(', ')}`))];
  const lines = [`# Benchmark: ${[...new Set(records.map(r => r.spec))].join(', ')}`, '', ...prov.map(p => `- ${p}`), `- ${records.length} runs, ${usd(records.reduce((a, r) => a + runCost(r), 0))} total`,
    ...(stale ? [`- ${stale} runs of older task versions are left out`] : []),
    ...(errors.length ? [`- ${errors.length} runs ended on a provider error and are left out: ${[...new Set(errors.map(r => r.error!.slice(0, 120)))].join(' · ')}`] : []), '',
    '## By arm and task class', '',
    'Strict pass: every dimension the task has passed (outcome, diagnosis, citation, coverage, scope, hidden tests). Extra findings (review: cited lines that are no bug) are counted beside it and fail nothing; so are the answer\'s words (median) and how they split: needed (blocks with something the task requires), allowed (justification, verification, what is no bug), surplus (neither).',
    'Cost includes subagents. Cost, turns and tokens (the run\'s own) are medians per run; ranges are min–max.', '',
    '| class | arm | harness | strict pass | worst–best rep | by dimension | extra findings (runs) | answer words | needed / allowed / surplus | $/run | $ range | turns | tokens | tokens range | cache hit | tool errors | parallel | out of scope | timeouts | subagents (stopped) | provider errors |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|'];
  for (const c of cs)
    lines.push(`| ${c.taskClass} | ${c.arm} | ${c.harness} | ${c.passes}/${c.runs} | ${pct(c.min)}–${pct(c.max)} | ${dims(c)} | ${c.dimensions.citation ? `${c.extraFindings} (${c.extraRuns})` : '–'} | ${c.answerWords === undefined ? '–' : Math.round(c.answerWords)} | ${c.surplusShare === undefined ? '–' : `${pct(c.neededShare!)} / ${pct(c.allowedShare!)} / ${pct(c.surplusShare)}`} | ${usd(c.costPerRun)} | ${usd(c.costMin)}–${usd(c.costMax)} | ${c.turns.toFixed(1)} | ${Math.round(c.tokens)} | ${Math.round(c.tokensMin)}–${Math.round(c.tokensMax)} | ${pct(c.cacheHit)} | ${c.toolErrors} | ${pct(c.parallelShare)} | ${c.outOfScope} | ${c.timeouts} | ${c.delegations} (${c.childrenStopped}) | ${c.errors} |`);
  lines.push('', `## Threshold per class (lowest median cost among arms whose worst repetition reaches ${pct(target)} in strict passes)`, '');
  for (const [cls, c] of thresholds(cs, target)) lines.push(`- ${cls}: ${c ? `${c.arm} at ${usd(c.costPerRun)}/run` : 'none reaches the target'}`);
  const sat = saturation(cs);
  if (sat.length) { lines.push('', '## Effort saturation (lowest effort with the best strict pass rate)', ''); for (const s of sat) lines.push(`- ${s.taskClass} · ${s.model}: ${s.effort} (${pct(s.rate)})`); }
  const lin = lineages(cs);
  if (lin.length) {
    lines.push('', '## Versions within a lineage', '');
    for (const l of lin) lines.push(`- ${l.lineage} · ${l.taskClass} @${l.effort}: ${l.versions.map(v => `${v.model.split('/')[1]} ${pct(v.rate)}${v.delta !== undefined ? ` (${v.delta >= 0 ? '+' : ''}${Math.round(v.delta * 100)}pp)` : ''}`).join(' → ')}`);
  }
  lines.push('', 'Differences smaller than the spread between replicate arms of the same model are noise.');
  return lines.join('\n');
}
