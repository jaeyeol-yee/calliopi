// Subagents and the active goal. The top Pi gets the subagent tool and the goal (tools, /cl-goal,
// carry-on); its subagents are linked to the open goal. A child Pi (started with CALLIOPI_AGENT_DIR)
// gets the child side — the finish tool, its contract, inbox and result — and, when its role may
// delegate and it is above the depth cap, the subagent tool one level down, within its own budget
// and for the goal it inherited.
import { getAgentDir, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { Fleet } from '#lib/fleet.ts';
import { delegates, descendantTokens, listAgents, listGoals, readAgent, remaining } from '@calliopi/core/agents';
import { loadCatalog } from '#lib/catalog.ts';
import { installChild } from '#lib/child.ts';
import { AGENT_DIR_ENV } from '#lib/launch.ts';
import { brief } from '#lib/briefing.ts';
import { writeGoalExport } from '#lib/export.ts';
import { collect, retention } from '#lib/gc.ts';
import { installGoals, type Goals } from '#lib/goals.ts';
import { installParent, registryRoot, type OnSpawned } from '#lib/parent.ts';
import { openAgentsView } from '#lib/viewer.ts';

export default function (pi: ExtensionAPI) {
  const cwd = process.cwd();
  const root = () => registryRoot(getAgentDir());
  /** Aged records go: request logs, then whole records, after their goal closes (lib/gc.ts). */
  const gc = () => { collect(root(), retention(getAgentDir())); };
  // Each delegation summarizes this Pi's work since the last one and briefs the children with it.
  const onSpawned: OnSpawned = (records, ctx) => { void brief(pi, ctx, records, loadCatalog(ctx.cwd).roles); };
  const dir = process.env[AGENT_DIR_ENV];
  /** /cl-agents: the tree of this session's subagents, and their screens, in a floating window. */
  const viewer = (fleet: Fleet, treeRoot: (sessionId: string) => string) => pi.registerCommand('cl-agents', {
    description: '서브에이전트를 goal별 목록(tree)으로, 각 에이전트의 실제 Pi 화면을 floating window로 봅니다. Enter: 화면 보기(입력하면 끼어들기)·goal 접기 · ctrl+]: 목록 · x: 중지 · e: goal 내보내기',
    handler: async (_args, ctx) => {
      if (ctx.mode !== 'tui') return ctx.ui.notify('서브에이전트 목록: Pi 대화형 TUI에서만 볼 수 있습니다.', 'warning');
      const tree = treeRoot(ctx.sessionManager.getSessionId());
      const records = () => listAgents(root(), tree);
      await openAgentsView(ctx, fleet, records, () => listGoals(root(), tree),
        goal => writeGoalExport(root(), goal, records(), { parentSession: ctx.sessionManager.getSessionFile() }));
    },
  });

  if (!dir) {
    let goals: Goals | undefined;
    const fleet = installParent(pi, { depth: 0, parentId: null }, { root, cwd, onSpawned, collect: gc, goal: (ctx, hint) => goals?.ensure(ctx, hint) ?? null });
    goals = installGoals(pi, { root, fleet, collect: gc });
    viewer(fleet, id => id);
    return;
  }

  let fleet: Fleet | undefined; // set below when this child may delegate
  installChild(pi, dir, () => (fleet?.running() ?? 0) > 0);
  const meta = readAgent(dir)!.meta;
  const role = loadCatalog(cwd).roles.get(meta.role);
  if (!role || !delegates(meta.depth, role)) return;
  fleet = installParent(pi, {
    depth: meta.depth, parentId: meta.id, root: meta.root, role,
    budgetLeft: () => {
      const s = readAgent(dir)?.status;
      const now = Date.now();
      const below = descendantTokens(listAgents(root(), meta.root), meta.id); // what it already delegated is spent
      return remaining(meta.call.budget, { turns: s?.turns ?? 0, ms: now - (s?.startedAt ?? now), tokens: (s?.tokens ?? 0) + below, idleMs: 0 });
    },
  }, { root, cwd, onSpawned, collect: gc, goal: () => meta.goal ?? null });
  viewer(fleet, () => meta.root);
}
