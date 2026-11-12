// A workflow is a stack of fzf steps. Selecting an item may push a step, stay (e.g. after running a
// program), or finish with a value. Esc pops one step, restoring that step's query and cursor;
// Esc on the first step ends the workflow with null. The runner is injected, as in fzf.ts.
import { fzfSelect, type FzfSelection } from '#lib/fzf.ts';
import type { RunProgram } from '#lib/types.ts';

export interface StepIO {
  run: RunProgram;
  setFooter: (text: string) => void;
}

export type StepResult<T> = { next: WorkflowStep<T> } | { done: T } | 'stay';

export interface WorkflowStep<T> {
  /** Private file stem for this step's fzf list/output, unique among the steps of one workflow. */
  name: string;
  prompt: string;
  /** Display lines; only these are shown and searched. Selections come back by index. */
  items: readonly string[];
  /** fzf --preview command; {1} is the focused item's index (see nodePreview). */
  preview?: string;
  footer?: string;
  onSelect(selection: FzfSelection, io: StepIO): StepResult<T> | Promise<StepResult<T>>;
}

export interface WorkflowOptions {
  run: RunProgram;
  directory: string;
  setFooter?: (text: string) => void;
  /** True once the hosting overlay is gone; checked after every program. */
  cancelled?: () => boolean;
}

export async function runWorkflow<T>(first: WorkflowStep<T>, { run, directory, setFooter = () => {}, cancelled = () => false }: WorkflowOptions): Promise<T | null> {
  const stack: { step: WorkflowStep<T>; query: string; position: number }[] = [{ step: first, query: '', position: 0 }];
  const io: StepIO = { run, setFooter };
  while (stack.length) {
    const top = stack.at(-1)!;
    const { step } = top;
    if (step.footer !== undefined) setFooter(step.footer);
    // A closed overlay kills fzf mid-way: cancellation wins over whatever it left in the output.
    const selection = await fzfSelect({ run, directory, name: step.name, items: step.items, prompt: step.prompt, preview: step.preview, query: top.query, position: top.position })
      .catch((error: unknown) => { if (cancelled()) return null; throw error; });
    if (cancelled()) return null;
    if (!selection) { stack.pop(); continue; }
    top.query = selection.query;
    top.position = selection.index + 1;
    const result = await step.onSelect(selection, io);
    if (cancelled()) return null;
    if (result === 'stay') continue;
    if ('done' in result) return result.done;
    stack.push({ step: result.next, query: '', position: 0 });
  }
  return null;
}
