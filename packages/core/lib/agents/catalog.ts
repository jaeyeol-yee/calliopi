// The role catalog: agents/*.md files whose YAML frontmatter describes a role and whose body is
// appended to the child's system prompt. Parsing the YAML is the caller's (Pi's parseFrontmatter);
// this turns its values into a role, tolerating the spellings people use and naming what is wrong.
import type { AgentRole, Approval, Budget, ContextMode } from '#lib/agents/types.ts';

export const ROLE_NAME = /^[a-z][a-z0-9-]{0,39}$/;

/** `read, bash` or `[read, bash]`. */
export function nameList(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
  return raw.filter((v): v is string => typeof v === 'string').map(v => v.trim()).filter(Boolean);
}

const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : undefined);
const number = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined);

function budget(value: unknown): Budget {
  if (!value || typeof value !== 'object') return {};
  const b = value as Record<string, unknown>;
  return { turns: number(b.turns), minutes: number(b.minutes), tokens: number(b.tokens), idleMinutes: number(b.idle_minutes ?? b.idleMinutes) };
}

const KNOWN = new Set(['name', 'description', 'when', 'not_when', 'tools', 'disallowed_tools', 'model', 'model_locked', 'thinking', 'allowed_subagents', 'approval', 'budget', 'context']);

/** A role from one file. `name` defaults to the file's; problems that make it unusable are errors, others warnings. */
export function parseRole(fileName: string, frontmatter: Record<string, unknown>, body: string, source: string):
  { role: AgentRole; warnings: string[] } | { error: string } {
  const name = text(frontmatter.name) ?? fileName;
  if (!ROLE_NAME.test(name)) return { error: `${source}: 이름 "${name}"은 영문 소문자·숫자·-로 시작해 40자까지입니다.` };
  const description = text(frontmatter.description);
  if (!description) return { error: `${source}: description이 없습니다.` };
  const warnings = Object.keys(frontmatter).filter(k => !KNOWN.has(k)).map(k => `${source}: 알 수 없는 키 ${k}`);
  const approval = (text(frontmatter.approval) ?? 'none') as Approval;
  if (!['none', 'once', 'always'].includes(approval)) return { error: `${source}: approval은 none, once, always 중 하나입니다.` };
  const context = (text(frontmatter.context) ?? 'summary') as ContextMode;
  if (!['none', 'summary', 'fork'].includes(context)) return { error: `${source}: context는 none, summary, fork 중 하나입니다.` };
  const tools = nameList(frontmatter.tools);
  return {
    role: {
      name, description, when: text(frontmatter.when), notWhen: text(frontmatter.not_when),
      tools: tools.length ? tools : undefined, disallowedTools: nameList(frontmatter.disallowed_tools),
      model: text(frontmatter.model), modelLocked: frontmatter.model_locked === true, thinking: text(frontmatter.thinking),
      allowedSubagents: nameList(frontmatter.allowed_subagents), approval, budget: budget(frontmatter.budget), context,
      instructions: body.trim(), source,
    },
    warnings,
  };
}

/** Layers from least to most specific (built-in, user, project): a later role replaces an earlier one of the same name. */
export function mergeCatalog(layers: AgentRole[][]): { roles: Map<string, AgentRole>; shadowed: string[] } {
  const roles = new Map<string, AgentRole>();
  const shadowed: string[] = [];
  for (const layer of layers) for (const role of layer) {
    const before = roles.get(role.name);
    if (before) shadowed.push(`${role.name}: ${role.source}가 ${before.source}를 대신합니다.`);
    roles.set(role.name, role);
  }
  return { roles, shadowed };
}

/**
 * Prompt guidelines for the subagent tool: when to delegate, to which role. Pi appends them flat to
 * the system prompt's rules, so each one names the tool.
 */
export function roleGuidelines(tool: string, roles: Iterable<AgentRole>): string[] {
  const lines = [
    `Use ${tool} to delegate a self-contained task whose working context would crowd yours, independent tasks that can run in parallel, or work that needs fresh eyes such as a review; give it a done condition that can be checked.`,
    `Do not use ${tool} for a short step you can do directly, or for work that needs back-and-forth with the user.`,
    `Use ${tool} when the user asks to hand work to an agent or a role, or to run work in parallel.`,
  ];
  for (const role of roles) {
    const when = role.when ? ` when ${role.when.replace(/\.$/, '')}` : '';
    const not = role.notWhen ? `; not ${role.notWhen.replace(/\.$/, '')}` : '';
    lines.push(`Use ${tool} with role "${role.name}" (${role.description.replace(/\.$/, '')})${when}${not}.`);
  }
  return lines;
}
