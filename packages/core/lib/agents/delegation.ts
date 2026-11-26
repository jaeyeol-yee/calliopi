// Who may delegate to whom, with which model and tools. A child never gets more than its parent:
// its tools are a subset of the parent's, and below the depth cap it gets no way to delegate.
import type { AgentRole, ModelSource } from '#lib/agents/types.ts';

export const DEFAULT_MAX_DEPTH = 2;

/**
 * Whether an agent at `depth` (0: the top Pi) with role `parent` (undefined for the top Pi) may
 * delegate to `child`. The top Pi delegates to any role; an agent only to the roles its own role
 * lists in allowed_subagents, and only above the depth cap.
 */
export function mayDelegate(depth: number, parent: AgentRole | undefined, child: string, maxDepth = DEFAULT_MAX_DEPTH): { ok: true } | { ok: false; why: string } {
  if (depth >= maxDepth) return { ok: false, why: `깊이 ${depth}: 최대 깊이(${maxDepth})라 더 위임할 수 없습니다.` };
  if (depth === 0) return { ok: true };
  if (!parent) return { ok: false, why: '역할이 없는 에이전트는 위임할 수 없습니다.' };
  if (parent.allowedSubagents.includes('*') || parent.allowedSubagents.includes(child)) return { ok: true };
  return { ok: false, why: `${parent.name} 역할은 ${child}에게 위임할 수 없습니다(allowed_subagents).` };
}

/** Whether a child at this depth gets the delegation tool at all. */
export const delegates = (childDepth: number, role: AgentRole, maxDepth = DEFAULT_MAX_DEPTH) =>
  childDepth < maxDepth && role.allowedSubagents.length > 0;

/** The child's model: a locked role's, else the caller's, else the role's, else the parent's own. */
export function resolveModel(role: AgentRole, caller: string | undefined, parentModel: string): { model: string; source: ModelSource } {
  if (role.model && role.modelLocked) return { model: role.model, source: 'pin' };
  if (caller) return { model: caller, source: 'caller' };
  if (role.model) return { model: role.model, source: 'default' };
  return { model: parentModel, source: 'inherit' };
}

/** The child's tools: the role's (or all) among the parent's, minus the role's disallowed ones. */
export function resolveTools(role: AgentRole, parentTools: string[]): string[] {
  const wanted = role.tools ?? parentTools;
  return wanted.filter(t => parentTools.includes(t) && !role.disallowedTools.includes(t));
}
