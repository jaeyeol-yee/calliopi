// The agents of one top Pi session as a tree, parent first, siblings in the order they started.
import type { AgentRecord, AgentState } from '#lib/agents/types.ts';

export interface TreeNode {
  record: AgentRecord;
  children: TreeNode[];
  /** Its parent is not in the registry (removed): shown under the top Pi. */
  orphan: boolean;
}

/** Children of the top Pi; deeper agents hang under their parents. */
export function buildTree(records: AgentRecord[]): TreeNode[] {
  const nodes = new Map(records.map(r => [r.meta.id, { record: r, children: [] as TreeNode[], orphan: false }]));
  const top: TreeNode[] = [];
  for (const node of [...nodes.values()].sort((a, b) => a.record.meta.createdAt - b.record.meta.createdAt)) {
    const parent = node.record.meta.parent;
    const into = parent ? nodes.get(parent) : undefined;
    if (into && into !== node) into.children.push(node);
    else { node.orphan = parent !== null; top.push(node); }
  }
  return top;
}

export interface TreeRow {
  node: TreeNode;
  depth: number;
  /** Box-drawing prefix, e.g. "│  └─ ". */
  prefix: string;
}

/** Depth-first rows with their connectors; `collapsed` ids hide their children. */
export function treeRows(top: TreeNode[], collapsed: ReadonlySet<string> = new Set()): TreeRow[] {
  const rows: TreeRow[] = [];
  const walk = (nodes: TreeNode[], lead: string, depth: number) => nodes.forEach((node, i) => {
    const last = i === nodes.length - 1;
    rows.push({ node, depth, prefix: `${lead}${last ? '└─ ' : '├─ '}` });
    if (!collapsed.has(node.record.meta.id)) walk(node.children, `${lead}${last ? '   ' : '│  '}`, depth + 1);
  });
  walk(top, '', 1);
  return rows;
}

export const stateOf = (r: AgentRecord): AgentState => r.result?.status ?? r.status?.state ?? 'starting';

/** Counts by state over the whole tree, for a one-line summary. */
export function treeCounts(records: AgentRecord[]): { running: number; ended: number; problems: number } {
  let running = 0, ended = 0, problems = 0;
  for (const r of records) {
    const s = stateOf(r);
    if (s === 'running' || s === 'starting') running++;
    else { ended++; if (!['done', 'partial', 'stopped'].includes(s)) problems++; }
  }
  return { running, ended, problems };
}
