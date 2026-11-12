// Session lifecycle: nothing starts in the factory. The registry watcher and the dedicated-session mailbox
// start on session_start and stop on session_shutdown.
import { attach, detach, drain } from "#lib/sidecar.ts";
import { PLAN_INSTRUCTIONS } from "#lib/plan.ts";
import { sideDir, type Runtime } from "#extensions/runtime/state.ts";
import { startWatcher, stopWatcher } from "#extensions/runtime/watcher.ts";
import { inspect } from "#extensions/components/inspector.ts";

export function registerSession(rt: Runtime) {
	const { pi } = rt;
	pi.on("session_start", async (_e, ctx) => {
		const role = ctx.sessionManager.getEntries().filter((e: any) => e.type === "custom" && e.customType === "cloud-fanout-owner").at(-1) as any;
		if (ctx.mode === "tui" && role?.data?.sessionId === ctx.sessionManager.getSessionId() && role.data.enabled) {
			try { rt.registration = attach(sideDir(ctx), { sessionId: ctx.sessionManager.getSessionId(), token: role.data.token, rexSession: process.env.REX_SESSION, block: process.env.REX_BLOCK }); }
			catch (e: any) { ctx.ui.notify(`fanout: ${e.message}`, "warning"); }
		}
		if (ctx.hasUI) startWatcher(rt, ctx);
		if (ctx.mode === "tui") rt.mailboxTimer = setInterval(() => {
			if (!rt.registration || !ctx.isIdle() || rt.inspectorOpen) return;
			try { drain(sideDir(ctx), rt.registration.token, (payload: any) => {
				if (payload.action === "inspect") { void inspect(rt, ctx); return; }
				pi.sendMessage({ customType: "cloud-fanout-plan", content: payload.spec ? `Call calliopi_fanout_launch with this plan, preserving all instructions. Require normal UI approval.\n${JSON.stringify(payload.spec)}` : PLAN_INSTRUCTIONS(payload.goal), display: false }, { deliverAs: "followUp", triggerTurn: true });
			}); } catch (e: any) { ctx.ui.notify(`fanout mailbox: ${e.message}`, "error"); }
		}, 1000);
	});
	pi.on("session_shutdown", async (_e, ctx) => {
		stopWatcher(rt); clearInterval(rt.mailboxTimer!); rt.mailboxTimer = null;
		rt.closeFloating?.();
		if (rt.registration) detach(sideDir(ctx), rt.registration.token);
		rt.registration = null;
	});
}
