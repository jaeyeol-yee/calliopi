// Subagents. The top Pi gets the subagent tool. A child Pi (started with CALLIOPI_AGENT_DIR) gets
// the child side — the finish tool, its contract, inbox and result — and, when its role may
// delegate and it is above the depth cap, the subagent tool one level down, within its own budget.
import { getAgentDir, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { delegates, readAgent, remaining } from '@calliopi/core/agents';
import { loadCatalog } from '#lib/catalog.ts';
import { installChild } from '#lib/child.ts';
import { AGENT_DIR_ENV } from '#lib/launch.ts';
import { brief } from '#lib/briefing.ts';
import { installParent, registryRoot, type OnSpawned } from '#lib/parent.ts';

export default function (pi: ExtensionAPI) {
  const cwd = process.cwd();
  const root = () => registryRoot(getAgentDir());
  // Each delegation summarizes this Pi's work since the last one and briefs the children with it.
  const onSpawned: OnSpawned = (records, ctx) => { void brief(pi, ctx, records, loadCatalog(ctx.cwd).roles); };
  const dir = process.env[AGENT_DIR_ENV];
  if (!dir) return installParent(pi, { depth: 0, parentId: null }, { root, cwd, onSpawned });

  installChild(pi, dir);
  const meta = readAgent(dir)!.meta;
  const role = loadCatalog(cwd).roles.get(meta.role);
  if (!role || !delegates(meta.depth, role)) return;
  installParent(pi, {
    depth: meta.depth, parentId: meta.id, root: meta.root, role,
    budgetLeft: () => {
      const s = readAgent(dir)?.status;
      const now = Date.now();
      return remaining(meta.call.budget, { turns: s?.turns ?? 0, ms: now - (s?.startedAt ?? now), tokens: s?.tokens ?? 0, idleMs: 0 });
    },
  }, { root, cwd, onSpawned });
}
