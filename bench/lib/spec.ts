// An experiment spec (bench/specs/<name>.yaml): the arms to compare, the tasks, and how many times
// each pair runs. Arms are listed, not crossed: a sweep names only the combinations it needs. An arm
// whose effort is a list expands to one arm per effort.
//
//   name: s1-coarse
//   runs: 3
//   target: 0.9            # pass rate a class threshold must reach in every repetition
//   timeoutMinutes: 10
//   budgetUsd: 30          # stop starting runs once this invocation has spent this much
//   tasks: all             # or a list of task ids (class/name)
//   arms:
//     - { model: anthropic/claude-opus-5-5, effort: medium }
//     - { model: anthropic/claude-opus-5-5, effort: medium, label: opus-5-5-replicate }
//     - { model: openai/gpt-6.2-sol, effort: [low, medium, high] }
//     - { model: anthropic/claude-fable-5-2, effort: medium, harness: off }
//     - { model: openai/gpt-6.2-sol, effort: medium, harnessRef: main }   # Calliopi as of a git ref
import YAML from 'yaml';
import { EFFORTS, catalogModel, type PiCatalog } from './catalog.ts';
import type { Task } from './task.ts';

export type Harness = 'on' | 'off';

export interface Arm {
  id: string;
  model: string;
  effort: string;
  /** on: Calliopi's extensions loaded; off: bare Pi. */
  harness: Harness;
  /** With harness on: run Calliopi as of this git ref (a worktree) instead of the working tree. */
  harnessRef?: string;
  /** For faux/* models: the scripted replies (see bench/faux-extension.ts). */
  faux?: unknown[];
}

export interface Spec {
  name: string;
  runs: number;
  target: number;
  timeoutMinutes: number;
  /** Dollars this invocation may spend; no new run starts once it is reached. */
  budgetUsd?: number;
  /** 'all' or task ids. */
  tasks: 'all' | string[];
  arms: Arm[];
}

export interface PlannedRun { arm: Arm; task: Task; rep: number }

export const FAUX_PROVIDER = 'faux/';
export const isFaux = (model: string) => model.startsWith(FAUX_PROVIDER);
const short = (model: string) => model.slice(model.indexOf('/') + 1);

export function parseSpec(text: string): Spec {
  const raw = YAML.parse(text) as Record<string, unknown> | null;
  if (!raw || typeof raw !== 'object') throw new Error('spec: not a mapping');
  const name = String(raw.name ?? '');
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(name)) throw new Error('spec: name must be a plain identifier');
  const num = (v: unknown, fallback: number, what: string) => {
    if (v === undefined) return fallback;
    if (typeof v !== 'number' || !(v > 0)) throw new Error(`spec: ${what} must be a positive number`);
    return v;
  };
  const runs = num(raw.runs, 1, 'runs');
  const target = num(raw.target, 0.9, 'target');
  if (target > 1) throw new Error('spec: target is a rate between 0 and 1');
  const tasks = raw.tasks === undefined || raw.tasks === 'all' ? 'all'
    : Array.isArray(raw.tasks) ? raw.tasks.map(String) : (() => { throw new Error('spec: tasks must be "all" or a list'); })();
  if (!Array.isArray(raw.arms) || !raw.arms.length) throw new Error('spec: arms must be a non-empty list');
  const arms: Arm[] = [];
  for (const [i, a] of (raw.arms as Record<string, unknown>[]).entries()) {
    if (!a || typeof a.model !== 'string') throw new Error(`spec: arms[${i}] needs a model`);
    const harness = a.harness === undefined || a.harness === 'on' ? 'on' : a.harness === 'off' ? 'off' : (() => { throw new Error(`spec: arms[${i}].harness must be on or off`); })();
    const ref = a.harnessRef === undefined ? undefined : String(a.harnessRef);
    if (ref !== undefined && (harness === 'off' || !/^[\w./-]+$/.test(ref) || ref.startsWith('-'))) throw new Error(`spec: arms[${i}].harnessRef must be a plain git ref, with harness on`);
    const efforts = (Array.isArray(a.effort) ? a.effort : [a.effort ?? 'medium']).map(String);
    for (const effort of efforts) {
      if (!(EFFORTS as readonly string[]).includes(effort)) throw new Error(`spec: arms[${i}]: unknown effort "${effort}" (${EFFORTS.join(', ')})`);
      const base = a.label ? String(a.label) : `${short(a.model)}@${effort}${harness === 'off' ? '-bare' : ''}${ref ? `@${ref}` : ''}`;
      const id = a.label && efforts.length > 1 ? `${base}@${effort}` : base;
      if (arms.some(x => x.id === id)) throw new Error(`spec: arm "${id}" appears twice; give a replicate a label`);
      arms.push({ id, model: a.model, effort, harness, ...(ref ? { harnessRef: ref } : {}), ...(Array.isArray(a.faux) ? { faux: a.faux } : {}) });
    }
  }
  return { name, runs, target, timeoutMinutes: num(raw.timeoutMinutes, 10, 'timeoutMinutes'), ...(raw.budgetUsd !== undefined ? { budgetUsd: num(raw.budgetUsd, 0, 'budgetUsd') } : {}), tasks, arms };
}

/** Problems that would make runs fail or mean something else than the spec says. */
export function checkSpec(spec: Spec, pi: PiCatalog, tasks: Task[]): string[] {
  const problems: string[] = [];
  for (const arm of spec.arms) {
    if (isFaux(arm.model)) { if (arm.effort !== 'off') problems.push(`${arm.id}: faux models take effort off`); continue; }
    const model = pi.get(arm.model);
    if (!model) { problems.push(`${arm.id}: Pi ${pi.version} does not know ${arm.model}`); continue; }
    // Pi would clamp an unsupported level to a neighbour: the arm would silently measure another effort.
    if (!model.efforts.includes(arm.effort)) problems.push(`${arm.id}: ${arm.model} does not accept effort ${arm.effort} (${model.efforts.join(', ')})`);
    if (!catalogModel(arm.model)) problems.push(`${arm.id}: ${arm.model} is not in bench/lib/catalog.ts (no family or lineage for the report)`);
  }
  if (spec.tasks !== 'all') for (const id of spec.tasks) if (!tasks.some(t => t.id === id)) problems.push(`unknown task ${id}`);
  return problems;
}

export const selectTasks = (spec: Spec, tasks: Task[]) =>
  spec.tasks === 'all' ? tasks.filter(t => t.class !== 'smoke') : spec.tasks.map(id => tasks.find(t => t.id === id)!).filter(Boolean);

/** Repetition outermost, then task, then arm: an interrupted run leaves every arm with the same tasks done, and arms alternate in time. */
export function plan(spec: Spec, tasks: Task[]): PlannedRun[] {
  const out: PlannedRun[] = [];
  for (let rep = 1; rep <= spec.runs; rep++) for (const task of selectTasks(spec, tasks)) for (const arm of spec.arms) out.push({ arm, task, rep });
  return out;
}
