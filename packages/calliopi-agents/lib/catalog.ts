// The role catalog on disk: agents/*.md, from least to most specific — this package's built-ins,
// the user's (<Pi agent dir>/agents), then the project's (.agents/agents, .pi/agents). The user's
// roles replace built-ins of the same name; a project's only add new names and need approval once
// (a checked-out repository is not trusted to redefine reviewer or scout).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAgentDir, parseFrontmatter } from '@earendil-works/pi-coding-agent';
import { mergeCatalog, parseRole, type AgentRole } from '@calliopi/core/agents';

export const BUILTIN_DIR = fileURLToPath(new URL('../agents', import.meta.url));

export const catalogDirs = (cwd: string, agentDir = getAgentDir()) =>
  [BUILTIN_DIR, path.join(agentDir, 'agents'), path.join(cwd, '.agents', 'agents'), path.join(cwd, '.pi', 'agents')];

function readDir(dir: string): { roles: AgentRole[]; problems: string[] } {
  let names: string[];
  try { names = fs.readdirSync(dir).filter(n => n.endsWith('.md')).sort(); } catch { return { roles: [], problems: [] }; }
  const roles: AgentRole[] = [], problems: string[] = [];
  for (const name of names) {
    const file = path.join(dir, name);
    try {
      const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(fs.readFileSync(file, 'utf8'));
      const parsed = parseRole(path.basename(name, '.md'), frontmatter, body, file);
      if ('error' in parsed) problems.push(parsed.error);
      else { roles.push(parsed.role); problems.push(...parsed.warnings); }
    } catch (error) {
      problems.push(`${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { roles, problems };
}

export function loadCatalog(cwd: string, dirs = catalogDirs(cwd)): { roles: Map<string, AgentRole>; problems: string[] } {
  const layers = dirs.map(readDir);
  // The first two directories (built-in, the user's) are trusted; any after them belong to the project.
  const { roles, shadowed } = mergeCatalog(layers.map(l => l.roles), dirs.map((_, i) => i < 2));
  return { roles, problems: [...layers.flatMap(l => l.problems), ...shadowed] };
}
