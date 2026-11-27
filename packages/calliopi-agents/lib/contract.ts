// What a child is told: its role and the rules of being a subagent (system prompt), its contract
// (the first user message), the parent's background (briefing), and reminders. The contract is the
// declared purpose; the child is held to it, not to a purpose inferred later from its transcript.
import { formatBudget, type AgentMeta, type BudgetUsage } from '@calliopi/core/agents';

export const FINISH_TOOL = 'finish';

/** Appended to the child's system prompt. */
export function childSystemPrompt(meta: AgentMeta, roleInstructions: string): string {
  return [
    `You are a subagent: another agent delegated one task to you (role "${meta.role}", id "${meta.id}", depth ${meta.depth}).`,
    'You work on your own; nobody answers questions. When the task is done, or cannot be done, call the ' +
      `${FINISH_TOOL} tool with status "done", "partial" or "blocked", a summary your delegator can act on without ` +
      'reading your transcript, and the evidence (paths, commands and their results, sources). Calling it ends your work.',
    'Stay within the task. If you notice related work, mention it in the summary instead of doing it.',
    ...(roleInstructions.trim() ? ['', roleInstructions.trim()] : []),
  ].join('\n');
}

/** The first user message: the task and how it ends. */
export function taskMessage(meta: AgentMeta): string {
  return [
    `Task: ${meta.call.task}`,
    ...(meta.call.done ? [`Done when: ${meta.call.done}`] : []),
    `Budget: ${formatBudget(meta.call.budget)}.`,
    `When it is done or blocked, call ${FINISH_TOOL}.`,
  ].join('\n');
}

/** The parent's summary of its own work, given as background; `late` when it came after the task had started. */
export function briefingMessage(text: string, late: boolean): string {
  const head = late
    ? 'Background from the agent that delegated this task. It arrived after you started: check whether it changes anything you did or planned.'
    : 'Background from the agent that delegated this task: its own goal, constraints and decisions so far. Use it to understand the task; the task itself is in the next message.';
  return `${head}\n\n<background>\n${text.trim()}\n</background>`;
}

/** Added at the end of each request (not stored): the declared purpose and what is left of the budget. */
export function contractReminder(meta: AgentMeta, usage: BudgetUsage): string {
  return [
    `[Subagent contract] Task: ${meta.call.task}`,
    ...(meta.call.done ? [`Done when: ${meta.call.done}`] : []),
    `Budget used: ${formatBudget(meta.call.budget, usage)}.`,
    `Stay within the task; when it is done or blocked, call ${FINISH_TOOL}.`,
  ].join('\n');
}

export const steerMessage = (text: string) => `Message from the agent that delegated this task:\n\n${text.trim()}`;

export const FINISH_REMINDER = `You stopped without calling ${FINISH_TOOL}. Call it now: status "done", "partial" or "blocked", with a summary and evidence. If you still have work to do for the task, do it first.`;

export const wrapUpReminder = (dims: string[]) =>
  `Your budget is nearly used (${dims.join(', ')}). Wrap up: finish what you can and call ${FINISH_TOOL}; report anything left as "partial".`;
