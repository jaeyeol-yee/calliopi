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

const TOOL_NAME = /^[\w.:*-]+$/;
/** Why a name list is malformed (not a string or list of strings, or a name like "read bash"), or null. */
function badList(key: string, value: unknown): string | null {
  if (value === undefined) return null;
  const ok = typeof value === 'string' || (Array.isArray(value) && value.every(v => typeof v === 'string'));
  if (!ok) return `${key}는 쉼표로 구분한 이름이나 목록입니다(값 ${JSON.stringify(value)}).`;
  const bad = nameList(value).find(n => !TOOL_NAME.test(n));
  return bad ? `${key}의 "${bad}"는 이름이 아닙니다(쉼표로 구분하세요).` : null;
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
  // A key that is there but not a string is an error, never a silent default: `approval: yes` is YAML
  // true, and falling back to 'none' would loosen the role the author meant to tighten.
  const enumOf = (key: string, fallback: string, allowed: string[]) => {
    const v = frontmatter[key];
    if (v === undefined || v === null) return fallback;
    return typeof v === 'string' && allowed.includes(v.trim()) ? v.trim() : null;
  };
  const approval = enumOf('approval', 'none', ['none', 'once', 'always']) as Approval | null;
  if (!approval) return { error: `${source}: approval은 none, once, always 중 하나입니다(값 ${JSON.stringify(frontmatter.approval)}).` };
  const context = enumOf('context', 'summary', ['none', 'summary', 'fork']) as ContextMode | null;
  if (!context) return { error: `${source}: context는 none, summary, fork 중 하나입니다(값 ${JSON.stringify(frontmatter.context)}).` };
  if (frontmatter.model_locked !== undefined && typeof frontmatter.model_locked !== 'boolean') return { error: `${source}: model_locked는 true 또는 false입니다.` };
  if ('tools' in frontmatter && frontmatter.tools === null) return { error: `${source}: tools가 비어 있습니다. 도구 없이는 tools: [], 부모의 도구는 키를 빼세요.` };
  for (const key of ['tools', 'disallowed_tools', 'allowed_subagents']) {
    const why = badList(key, frontmatter[key]);
    if (why) return { error: `${source}: ${why}` };
  }
  const tools = nameList(frontmatter.tools);
  return {
    role: {
      name, description, when: text(frontmatter.when), notWhen: text(frontmatter.not_when),
      // An empty list means no tools (besides finish), not the parent's: only a missing key inherits them.
      tools: 'tools' in frontmatter ? tools : undefined, disallowedTools: nameList(frontmatter.disallowed_tools),
      model: text(frontmatter.model), modelLocked: frontmatter.model_locked === true, thinking: text(frontmatter.thinking),
      allowedSubagents: nameList(frontmatter.allowed_subagents), approval, budget: budget(frontmatter.budget), context,
      instructions: body.trim(), source,
    },
    warnings,
  };
}

const APPROVAL_RANK: Record<Approval, number> = { none: 0, once: 1, always: 2 };

/**
 * Layers from least to most specific (built-in, user, project). A trusted layer (built-in, the user's
 * own) replaces an earlier role of the same name. An untrusted one (a project's, which comes with
 * whatever repository is checked out) may only add roles: it cannot replace a role (a repository's
 * reviewer.md must not turn the read-only reviewer into a writer), and its roles need the user's
 * approval at least once. `trusted` says which layers are trusted (default: all).
 */
export function mergeCatalog(layers: AgentRole[][], trusted: boolean[] = layers.map(() => true)): { roles: Map<string, AgentRole>; shadowed: string[] } {
  const roles = new Map<string, AgentRole>();
  const shadowed: string[] = [];
  layers.forEach((layer, i) => {
    for (const role of layer) {
      const before = roles.get(role.name);
      if (trusted[i] === false) {
        if (before) { shadowed.push(`${role.name}: ${role.source}는 ${before.source}를 대신할 수 없어 무시합니다(프로젝트 역할은 새 이름만 추가합니다).`); continue; }
        roles.set(role.name, APPROVAL_RANK[role.approval] >= APPROVAL_RANK.once ? role : { ...role, approval: 'once' });
        continue;
      }
      if (before) shadowed.push(`${role.name}: ${role.source}가 ${before.source}를 대신합니다.`);
      roles.set(role.name, role);
    }
  });
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
