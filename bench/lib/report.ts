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
  /** Median over runs of each run's median output tokens per second (end to end), and the share of wall time spent waiting on the model. */
  tokPerSec?: number; modelShare?: number;
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
      ...(() => { const sp = rs.flatMap(r => (r.signals.tokPerSec ? [r.signals.tokPerSec] : [])); return sp.length ? { tokPerSec: median(sp) } : {}; })(),
      ...(() => { const ms = rs.filter(r => r.signals.modelMs && r.ms); return ms.length ? { modelShare: median(ms.map(r => Math.min(1, r.signals.modelMs! / r.ms))) } : {}; })(),
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
/** Lost tasks that count as a drop when no replicate measured the noise. */
export const DROP_MIN = 2;

export interface DropCell {
  effort: string; passes: number; runs: number;
  /** The best effort of the row (highest strict pass, the lowest effort among ties). */
  best: boolean;
  /** Runs passed at the best effort and failed here, paired by task and repetition. */
  lost: number;
  /** Strict pass rate here minus at the best effort. */
  delta: number;
  /** A drop beyond the noise: lost at least max(DROP_MIN, the noise + 1). */
  cliff: boolean;
  /** Dimensions that passed fewer paired runs here than at the best effort, with how many fewer; extra findings and timeouts likewise. */
  worse: string[];
}

export interface DropRow { model: string; taskClass: string; noise?: number; cells: DropCell[] }

/**
 * How far the strict pass falls from each model's best effort, per task class, efforts in order (low →
 * max). Runs are paired by task and repetition, so a drop counts the tasks an effort lost, not a rate of
 * different samples. The noise is the most runs two replicate arms (same model, effort and harness) of
 * the class disagreed on; without replicates a drop needs DROP_MIN lost runs.
 */
export function drops(records: RunRecord[]): DropRow[] {
  const ok = records.filter(r => !r.error && r.harness === 'on');
  const order = (e: string) => EFFORTS.indexOf(e as never);
  const key = (r: RunRecord) => `${r.task}\0${r.rep}`;
  const out: DropRow[] = [];
  for (const g of groupBy(ok, r => `${r.model}\0${r.taskClass}`).values()) {
    const byArm = groupBy(g, r => r.arm);
    // replicates: arms of one effort; the noise is the most paired runs any two disagree on
    let noise: number | undefined;
    for (const same of groupBy([...byArm.values()], rs => rs[0]!.effort).values()) {
      for (let i = 0; i < same.length; i++) for (let j = i + 1; j < same.length; j++) {
        const b = new Map(same[j]!.map(r => [key(r), r.pass]));
        const flips = same[i]!.filter(r => b.has(key(r)) && b.get(key(r)) !== r.pass).length;
        noise = Math.max(noise ?? 0, flips);
      }
    }
    const byEffort = [...groupBy(g, r => r.effort).values()]
      .map(rs => (rs.some(r => r.arm !== rs[0]!.arm) ? rs.filter(r => r.arm === rs[0]!.arm) : rs)) // one arm per effort
      .sort((a, b) => order(a[0]!.effort) - order(b[0]!.effort));
    if (byEffort.length < 2) continue;
    const rate = (rs: RunRecord[]) => rs.filter(r => r.pass).length / rs.length;
    const top = byEffort.reduce((best, rs) => (rate(rs) > rate(best) ? rs : best));
    const at = new Map(top.map(r => [key(r), r]));
    const cells = byEffort.map(rs => {
      const paired = rs.filter(r => at.has(key(r)));
      const lost = paired.filter(r => at.get(key(r))!.pass && !r.pass).length;
      const worse: string[] = [];
      for (const d of DIMENSIONS) {
        const here = paired.filter(r => r.dimensions?.[d] !== undefined);
        const fewer = here.filter(r => at.get(key(r))!.dimensions?.[d] === true).length - here.filter(r => r.dimensions?.[d] === true).length;
        if (here.length && fewer > 0) worse.push(`${d} −${fewer}`);
      }
      const extra = paired.reduce((a, r) => a + (r.extraFindings ?? 0) - (at.get(key(r))!.extraFindings ?? 0), 0);
      if (extra > 0) worse.push(`extra findings +${extra}`);
      const timeouts = paired.filter(r => r.timedOut).length - paired.filter(r => at.get(key(r))!.timedOut).length;
      if (timeouts > 0) worse.push(`timeouts +${timeouts}`);
      const best = rs === top;
      return { effort: rs[0]!.effort, passes: rs.filter(r => r.pass).length, runs: rs.length, best, lost, delta: rate(rs) - rate(top), cliff: !best && lost >= Math.max(DROP_MIN, (noise ?? -1) + 1), worse: best ? [] : worse };
    });
    out.push({ model: g[0]!.model, taskClass: g[0]!.taskClass, ...(noise !== undefined ? { noise } : {}), cells });
  }
  return out.sort((a, b) => a.taskClass.localeCompare(b.taskClass) || a.model.localeCompare(b.model));
}

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
    'Cost includes subagents. Cost, turns and tokens (the run\'s own) are medians per run; ranges are min–max. tok/s: output tokens per second of responses of 50 tokens or more, end to end (it includes the wait for the first token), median per run then over runs; model time: the share of a run\'s wall time spent waiting on the model. Both are slower when runs went at once.', '',
    '| class | arm | harness | strict pass | worst–best rep | by dimension | extra findings (runs) | answer words | needed / allowed / surplus | $/run | $ range | turns | tokens | tokens range | cache hit | tok/s | model time | tool errors | parallel | out of scope | timeouts | subagents (stopped) | provider errors |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|'];
  for (const c of cs)
    lines.push(`| ${c.taskClass} | ${c.arm} | ${c.harness} | ${c.passes}/${c.runs} | ${pct(c.min)}–${pct(c.max)} | ${dims(c)} | ${c.dimensions.citation ? `${c.extraFindings} (${c.extraRuns})` : '–'} | ${c.answerWords === undefined ? '–' : Math.round(c.answerWords)} | ${c.surplusShare === undefined ? '–' : `${pct(c.neededShare!)} / ${pct(c.allowedShare!)} / ${pct(c.surplusShare)}`} | ${usd(c.costPerRun)} | ${usd(c.costMin)}–${usd(c.costMax)} | ${c.turns.toFixed(1)} | ${Math.round(c.tokens)} | ${Math.round(c.tokensMin)}–${Math.round(c.tokensMax)} | ${pct(c.cacheHit)} | ${c.tokPerSec === undefined ? '–' : c.tokPerSec.toFixed(0)} | ${c.modelShare === undefined ? '–' : pct(c.modelShare)} | ${c.toolErrors} | ${pct(c.parallelShare)} | ${c.outOfScope} | ${c.timeouts} | ${c.delegations} (${c.childrenStopped}) | ${c.errors} |`);
  lines.push('', `## Threshold per class (lowest median cost among arms whose worst repetition reaches ${pct(target)} in strict passes)`, '');
  for (const [cls, c] of thresholds(cs, target)) lines.push(`- ${cls}: ${c ? `${c.arm} at ${usd(c.costPerRun)}/run` : 'none reaches the target'}`);
  const dr = drops(records);
  if (dr.length) {
    lines.push('', '## Drops by effort', '', `Strict passes per effort, low → max; ★ the best effort of the row. Against it, paired by task and repetition: the change in pass rate, the runs lost, ▼ when the loss is beyond the noise (replicate arms) or at least ${DROP_MIN} runs without replicates, and what got worse with it.`, '');
    for (const r of dr) {
      const cell = (c: DropCell) => `${c.effort} ${c.passes}/${c.runs}${c.best ? ' ★' : c.lost || c.delta < 0 ? ` (${Math.round(c.delta * 100)}pp, lost ${c.lost}${c.cliff ? ' ▼' : ''}${c.worse.length ? `; ${c.worse.join(', ')}` : ''})` : ''}`;
      lines.push(`- ${r.taskClass} · ${r.model}${r.noise !== undefined ? ` (noise ${r.noise})` : ''}: ${r.cells.map(cell).join(' │ ')}`);
    }
  }
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
