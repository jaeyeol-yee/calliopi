// Registry watcher: refreshes the floating list, notifies on terminal transitions and queues finished
// batch reports for the model's next turn. Local file only, zero API calls.
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateHead } from "@earendil-works/pi-coding-agent";
import fs from "node:fs";
import { owner } from "#lib/sidecar.ts";
import { load } from "#lib/registry.ts";
import { icon } from "#lib/dashboard.ts";
import { aggregate, toMarkdown } from "#lib/report.ts";
import { isTerminal } from "#lib/util.ts";
import { cfgFor, ensureReviewDaemon, isOwner, sideDir, type Agent, type Runtime } from "#extensions/runtime/state.ts";
import { mountFloating } from "#extensions/runtime/floating.ts";

export function refresh(rt: Runtime, ctx: ExtensionContext) {
	const cfg = cfgFor(ctx);
	ctx.ui.setStatus("cloud-fanout", undefined); ctx.ui.setWidget("cloud-fanout", undefined);
	if (!fs.existsSync(cfg.registryPath)) { rt.floatingAgents = []; rt.floatingHandle?.setHidden(true); return; }
	let reg; try { reg = load(cfg); } catch { return; }
	const agents = Object.values(reg.agents) as Agent[];
	const approvals = (Object.values(reg.meta.approvals || {}) as any[]).filter(a => { try { if (!a.pid) return false; process.kill(a.pid, 0); return true; } catch { return false; } });
	rt.floatingAgents = [...approvals, ...agents];
	if (!rt.floatingAgents.length) { rt.floatingHandle?.setHidden(true); return; }
	rt.floatingHandle?.setHidden(!rt.widgetOn || rt.inspectorOpen);
	ensureReviewDaemon(rt, ctx, agents);
	mountFloating(rt, ctx);
	rt.renderFloating?.();

	// Notify on terminal transitions.
	for (const a of agents) {
		const id = (a.agentId || a.key) as string;
		const prev = rt.lastStatus.get(id);
		const now = (a.missing ? "MISSING" : a.status || a.phase) as string;
		if (prev && prev !== now && isTerminal(now) && a.finalized) {
			ctx.ui.notify(`${icon(now)} ${a.label}: ${now}${a.git?.branches?.[0]?.prUrl ? ` · ${a.git.branches[0].prUrl}` : ""}`, now === "FINISHED" ? "info" : "warning");
		}
		rt.lastStatus.set(id, now);
	}
	// When a whole batch is terminal, queue its report for the model's next turn (does not interrupt).
	for (const batch of new Set(agents.map((a) => a.batch).filter((b): b is string => Boolean(b)))) {
		const agg = aggregate(cfg, { batch });
		if (agg.allDone && !rt.notifiedBatches.has(batch)) {
			rt.notifiedBatches.add(batch);
			const md = truncateHead(toMarkdown(agg), { maxLines: 300, maxBytes: 20_000 }).content;
			if (!owner(sideDir(ctx)) || isOwner(ctx)) {
				rt.pi.sendMessage({ customType: "cloud-fanout", content: md, display: true, details: { batch } }, { deliverAs: "nextTurn" });
			} else ctx.ui.notify(`☁ ${batch} 완료 · /calliopi-fanout inbox로 결과 확인`, "info");
		}
	}
}

export function startWatcher(rt: Runtime, ctx: ExtensionContext) {
	const cfg = cfgFor(ctx);
	stopWatcher(rt);
	try { fs.mkdirSync(cfg.dir, { recursive: true, mode: 0o700 }); } catch { /* read-only cwd */ }
	// Seed: batches already terminal at startup are not re-announced.
	try { const reg = load(cfg); for (const b of new Set(Object.values(reg.agents).map((a: Agent) => a.batch))) if (b && aggregate(cfg, { batch: b }).allDone) rt.notifiedBatches.add(b); } catch { /* none */ }
	try {
		rt.watcher = fs.watch(cfg.dir, (_e, name) => {
			if (!name || !String(name).startsWith("registry.json")) return;
			if (rt.debounce) clearTimeout(rt.debounce);
			rt.debounce = setTimeout(() => refresh(rt, ctx), 250);
		});
	} catch { /* dir missing */ }
	refresh(rt, ctx);
}

export function stopWatcher(rt: Runtime) {
	rt.watcher?.close(); rt.watcher = null;
	if (rt.debounce) clearTimeout(rt.debounce);
}
