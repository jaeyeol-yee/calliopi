// Mounts the non-capturing floating task list (top-right overlay) once per session.
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { floatingList } from "#extensions/components/floating.ts";
import { inspect } from "#extensions/components/inspector.ts";
import type { Runtime } from "#extensions/runtime/state.ts";

const tuiModeArg = () => process.argv.find(a => a.startsWith("--tui-mode="))?.split("=")[1] || (process.argv.includes("--tui-mode") ? process.argv[process.argv.indexOf("--tui-mode") + 1] : undefined);

export function mountFloating(rt: Runtime, ctx: ExtensionContext) {
	if (ctx.mode !== "tui" || (tuiModeArg() || rt.pi.getSettings().tuiMode) === "regular" || rt.floatingMounted || !rt.widgetOn || !rt.floatingAgents.length) return;
	rt.floatingMounted = true;
	let ageTimer: NodeJS.Timeout | undefined;
	void ctx.ui.custom<void>((tui, _theme, _keys, done) => {
		rt.closeFloating = () => done();
		rt.renderFloating = () => tui.requestRender();
		// Expiration is local display work, even when the registry/API is idle.
		ageTimer = setInterval(() => tui.requestRender(), 1000);
		return floatingList({ agents: () => rt.floatingAgents, theme: () => ctx.ui.theme,
			render: () => tui.requestRender(),
			open: id => { if (id.startsWith("approval:")) ctx.ui.notify("팬아웃 담당 세션의 승인 화면을 확인하세요.", "info"); else void inspect(rt, ctx, false, id); },
			unfocus: () => rt.floatingHandle?.unfocus(),
		});
	}, { overlay: true, overlayOptions: { anchor: "top-right", width: 42, maxHeight: 12, margin: { top: 1, right: 1 }, nonCapturing: true,
		visible: (w: number, h: number) => w >= 48 && h >= 18 }, onHandle: handle => { rt.floatingHandle = handle; if (rt.inspectorOpen) handle.setHidden(true); },
	}).catch((e: any) => ctx.ui.notify(`fanout floating: ${e.message}`, "warning")).finally(() => {
		clearInterval(ageTimer);
		rt.floatingMounted = false; rt.floatingHandle = null; rt.closeFloating = null; rt.renderFloating = null;
	});
}
