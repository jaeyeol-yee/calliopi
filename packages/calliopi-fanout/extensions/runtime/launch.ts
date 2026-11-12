// plan → approve (table) → launch. Routes to the dedicated session when another session owns fan-out.
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateHead } from "@earendil-works/pi-coding-agent";
import fs from "node:fs";
import path from "node:path";
import { owner, enqueue } from "#lib/sidecar.ts";
import { update as updateRegistry } from "#lib/registry.ts";
import { planTable, validate, type Spec } from "#lib/plan.ts";
import { cfgFor, ensureDaemon, isOwner, json, sideDir, tracker, type Runtime } from "#extensions/runtime/state.ts";
import { startWatcher } from "#extensions/runtime/watcher.ts";

function writeSpec(ctx: ExtensionContext, spec: Spec) {
	const dir = path.join(cfgFor(ctx).dir, "specs");
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	const file = path.join(dir, `${spec.batch.replace(/[^\w.-]/g, "_")}.json`);
	fs.writeFileSync(file, JSON.stringify(spec, null, 2), { mode: 0o600 });
	return file;
}

/** Show the plan as a table; Launch / Edit (JSON in the editor) / Cancel. Returns the approved spec or null. */
async function approve(rt: Runtime, ctx: ExtensionContext, spec: Spec, signal?: AbortSignal): Promise<{ spec: Spec; plan: any } | null> {
	for (;;) {
		validate(spec);
		const specPath = writeSpec(ctx, spec);
		const r = await tracker(rt, ctx, ["launch", "--spec", specPath, "--json"], signal);
		const plan = json(r.out);
		if (!plan) throw new Error(r.err || r.out || "plan failed");
		if (!plan.toCreate) { ctx.ui.notify("fanout: nothing to create (all tasks already tracked)", "info"); return null; }
		if (!ctx.hasUI) throw new Error(`needs approval in the UI:\n${planTable(plan, spec)}`);
		const launchLabel = `Launch ${plan.toCreate} agent(s)`;
		const approvalId = `approval:${ctx.sessionManager.getSessionId()}:${spec.batch}`;
		await updateRegistry(cfgFor(ctx), (reg: any) => { reg.meta.approvals ||= {}; reg.meta.approvals[approvalId] = { key: approvalId, label: spec.title || spec.batch, localApproval: true, pid: process.pid }; });
		let choice: string | undefined;
		try { choice = await ctx.ui.select(planTable(plan, spec), [launchLabel, "Edit plan", "Cancel"]); }
		finally { await updateRegistry(cfgFor(ctx), (reg: any) => { delete reg.meta.approvals?.[approvalId]; }); }
		if (choice === launchLabel) return { spec, plan };
		if (choice !== "Edit plan") return null;
		const edited = await ctx.ui.editor("Edit fan-out plan (JSON)", JSON.stringify(spec.agents, null, 2));
		if (edited == null) continue;
		try { spec = { ...spec, agents: JSON.parse(edited) }; } catch (e: any) { ctx.ui.notify(`invalid JSON: ${e.message}`, "error"); }
	}
}

export async function launch(rt: Runtime, ctx: ExtensionContext, spec: Spec, signal?: AbortSignal) {
	const target = owner(sideDir(ctx));
	if (target && !isOwner(ctx)) {
		validate(spec);
		const request = enqueue(sideDir(ctx), { spec });
		return { created: [], message: `queued to dedicated session (${request}); approval happens there`, spec };
	}
	// Cloud workers cannot see local edits. Never push on the user's behalf.
	const git = await rt.pi.exec("git", ["status", "--porcelain"], { cwd: ctx.cwd, timeout: 10_000, signal });
	if (git.code === 0 && git.stdout.trim()) {
		if (!ctx.hasUI) throw new Error("Local changes are not visible to Cloud Agents; interactive confirmation required.");
		if (!(await ctx.ui.confirm("클라우드에 없는 로컬 변경사항", `Cloud Agents는 원격 저장소만 봅니다. 로컬 변경·미추적 파일은 전달되지 않습니다. 자동 push는 하지 않습니다. 원격 코드만으로 작업 가능한지 확인하세요.\n\n${truncateHead(git.stdout, { maxLines: 15, maxBytes: 2000 }).content}\n계속할까요?`))) return { created: [], message: "cancelled", spec };
	}
	const ok = await approve(rt, ctx, spec, signal);
	if (!ok) return { created: [], message: "cancelled", spec };
	const r = await tracker(rt, ctx, ["launch", "--spec", writeSpec(ctx, ok.spec), "--yes", "--json"], signal);
	const res = json(r.out);
	if (!res) throw new Error(r.err || r.out);
	ensureDaemon(ctx);
	startWatcher(rt, ctx);
	// Name the Pi session after the fan-out (only if the user hasn't named it).
	if (ok.spec.title && !rt.pi.getSessionName()) rt.pi.setSessionName(`☁ ${ok.spec.title}`);
	const n = res.results.filter((x: any) => x.phase === "created").length;
	return { created: res.results, message: `${n}/${res.results.length} created`, spec: ok.spec };
}
