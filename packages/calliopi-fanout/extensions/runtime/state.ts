// Shared state of one extension instance, plus the paths/tracker helpers every part of it uses.
// Reads import the harness libs directly; anything that mutates state or talks to the network runs the
// tracker CLI so locking/logging stay in one place.
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { owner } from "#lib/sidecar.ts";
import { createReviewService, syncReviews, prTarget } from "#lib/github-review.ts";
import { loadConfig } from "#lib/config.ts";
import { load } from "#lib/registry.ts";

export const TRACKER = fileURLToPath(new URL("../../bin/tracker.ts", import.meta.url));
export const REVIEW_WATCH = fileURLToPath(new URL("../../bin/review-watch.ts", import.meta.url));
export const FANOUT_SH = fileURLToPath(new URL("../../rex/fanout.sh", import.meta.url));
export const NODE = process.env.CALLIOPI_NODE || "node";

export type Agent = ReturnType<typeof load>["agents"][string];

export type Runtime = ReturnType<typeof createRuntime>;

export function createRuntime(pi: ExtensionAPI) {
	return {
		pi,
		watcher: null as fs.FSWatcher | null,
		debounce: null as NodeJS.Timeout | null,
		lastStatus: new Map<string, string>(),
		notifiedBatches: new Set<string>(),
		widgetOn: true,
		registration: null as any,
		mailboxTimer: null as NodeJS.Timeout | null,
		inspectorOpen: false,
		floatingHandle: null as any,
		closeFloating: null as (() => void) | null,
		floatingMounted: false,
		renderFloating: null as (() => void) | null,
		floatingAgents: [] as Agent[],
		lastReviewStart: 0,
		reviewing: new Set<string>(),
		reviewService: createReviewService({ exec: (command: string, args: string[], options: any) => pi.exec(command, args, options) }),
	};
}

export const stateDir = (ctx: ExtensionContext) => process.env.CURSOR_FANOUT_DIR || path.join(ctx.cwd, ".cursor-fanout");
export const cfgFor = (ctx: ExtensionContext) => loadConfig({ dir: stateDir(ctx) });
export const sideDir = (ctx: ExtensionContext) => path.join(stateDir(ctx), "sidecar");
export const isOwner = (ctx: ExtensionContext) => owner(sideDir(ctx))?.sessionId === ctx.sessionManager.getSessionId();
export const json = (s: string) => { try { return JSON.parse(s); } catch { return null; } };

/** Run the tracker CLI against this cwd's state directory. */
export async function tracker(rt: Runtime, ctx: ExtensionContext, args: string[], signal?: AbortSignal) {
	const r = await rt.pi.exec(NODE, [TRACKER, "--dir", stateDir(ctx), ...args], { cwd: ctx.cwd, signal, timeout: 120_000 });
	return { ok: r.code === 0, code: r.code, out: r.stdout.trim(), err: r.stderr.trim() };
}

export async function revalidate(rt: Runtime, ctx: ExtensionContext, a?: Agent) {
	const id = a?.agentId || a?.key;
	if (!id || rt.reviewing.has(id)) return;
	rt.reviewing.add(id);
	try { await syncReviews(cfgFor(ctx), rt.reviewService, { agentId: id, detail: true, limit: 100 }); }
	catch (e: any) { ctx.ui.notify(`GitHub: ${e.message}`, "warning"); }
	finally { rt.reviewing.delete(id); }
}

export function ensureDaemon(ctx: ExtensionContext) {
	const cfg = cfgFor(ctx);
	let pid = 0;
	try { pid = Number(fs.readFileSync(cfg.pidPath, "utf8")); } catch { /* none */ }
	try { if (pid) { process.kill(pid, 0); return; } } catch { /* stale */ }
	fs.mkdirSync(cfg.dir, { recursive: true, mode: 0o700 });
	// Detached so it outlives this Pi session; it exits by itself when every agent is terminal.
	const child = spawn(NODE, [TRACKER, "--dir", cfg.dir, "watch", "--exit-when-done", "--quiet", "--log", cfg.logPath], {
		cwd: ctx.cwd, detached: true, stdio: "ignore",
	});
	child.unref();
}

export function ensureReviewDaemon(rt: Runtime, ctx: ExtensionContext, agents: Agent[]) {
	if (load(cfgFor(ctx)).meta.reviewPaused) return;
	if (!agents.some(a => a.status === "FINISHED" && (a.git?.branches || []).some((b: any) => prTarget(b.prUrl) && a.reviews?.[b.prUrl]?.state !== "merged"))) return;
	if (Date.now() - rt.lastReviewStart < 5000) return;
	rt.lastReviewStart = Date.now();
	const file = path.join(stateDir(ctx), "review.pid");
	try { const pid = Number(fs.readFileSync(file, "utf8")); if (pid) { process.kill(pid, 0); return; } } catch { /* stale */ }
	const child = spawn(NODE, [REVIEW_WATCH, stateDir(ctx)], { cwd: ctx.cwd, detached: true, stdio: "ignore" });
	child.on("error", () => {}); child.unref();
}
