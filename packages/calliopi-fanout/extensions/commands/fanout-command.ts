// /calliopi-fanout command: subcommands, or a free-form goal that the model turns into a plan.
import { truncateHead, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@earendil-works/pi-coding-agent";
import fs from "node:fs";
import path from "node:path";
import { owner, attach, detach, enqueue } from "#lib/sidecar.ts";
import { update as updateRegistry } from "#lib/registry.ts";
import { newBatch, PLAN_INSTRUCTIONS } from "#lib/plan.ts";
import { cfgFor, ensureDaemon, FANOUT_SH, isOwner, json, sideDir, tracker, type Runtime } from "#extensions/runtime/state.ts";
import { refresh, startWatcher } from "#extensions/runtime/watcher.ts";
import { mountFloating } from "#extensions/runtime/floating.ts";
import { launch } from "#extensions/runtime/launch.ts";
import { inspect } from "#extensions/components/inspector.ts";

export const SUBS = ["attach", "detach", "show", "inbox", "history", "archive", "focus", "reviews", "diff", "launch", "status", "report", "up", "add", "followup", "steer", "cancel", "tree", "widget", "stop", "pr", "merge", "fix"];

export function registerCommand(rt: Runtime) {
	const { pi } = rt;
	pi.registerCommand("calliopi-fanout", {
		description: "Cursor Cloud fan-out: attach | detach | show (right pane) | inbox (interactive status) | history (all records) | archive <label> (Cursor archive) | focus (floating keyboard navigation) | diff (local review) | <goal> | launch [spec.json] | status | report | tree <label> | add <bc-id> | followup | steer | cancel | pr <label> | merge <label> (gh, approval) | fix <label> <request> (@cursor on the PR) | up | widget on|off | stop",
		getArgumentCompletions: (prefix: string) => {
			const items = SUBS.filter((s) => s.startsWith(prefix)).map((s) => ({ value: s, label: s }));
			return items.length ? items : null;
		},
		handler: async (args, ctx) => {
			const [first = "status", ...rest] = (args || "").trim().split(/\s+/);
			const sub = SUBS.includes(first) ? first : "__goal__";
			const T = (argv: string[]) => tracker(rt, ctx, argv);
			const say = (text: string, level: "info" | "warning" | "error" = "info") => ctx.ui.notify(text, level);
			const show = (title: string, body: string) =>
				pi.sendMessage({ customType: "cloud-fanout", content: `**${title}**\n\n\`\`\`\n${truncateHead(body, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES }).content}\n\`\`\``, display: true }, { triggerTurn: false });
			try {
				switch (sub) {
					case "attach": {
						if (ctx.mode !== "tui") return say("attach requires an interactive Pi session", "warning");
						if (!rt.registration) rt.registration = attach(sideDir(ctx), { sessionId: ctx.sessionManager.getSessionId(), rexSession: process.env.REX_SESSION, block: process.env.REX_BLOCK });
						pi.appendEntry("cloud-fanout-owner", { enabled: true, sessionId: ctx.sessionManager.getSessionId(), token: rt.registration.token });
						refresh(rt, ctx); return say("이 세션이 팬아웃을 전담합니다. 다른 세션에서 /calliopi-fanout <목표>로 전달하세요.");
					}
					case "detach": { if (rt.registration) detach(sideDir(ctx), rt.registration.token); rt.registration = null; pi.appendEntry("cloud-fanout-owner", { enabled: false }); refresh(rt, ctx); return say("팬아웃 담당 해제 (클라우드 작업은 계속 실행)"); }
					case "inbox": return inspect(rt, ctx);
					case "history": return inspect(rt, ctx, false, undefined, true);
					case "archive": {
						if (!rest[0]) return say("usage: /calliopi-fanout archive <label>", "warning");
						if (!(await ctx.ui.confirm("Cursor에 에이전트 보관", `${rest[0]}을 Cursor에 보관할까요? 실행 취소와는 별개이며, 원격 영구 삭제는 하지 않습니다.`))) return;
						const r = await T(["archive", rest[0], "--yes"]);
						return say(r.out || r.err, r.ok ? "info" : "error");
					}
					case "focus": { mountFloating(rt, ctx); rt.floatingHandle?.focus(); return; }
					case "reviews": {
						if (!["on", "off"].includes(rest[0])) return say("usage: /calliopi-fanout reviews on|off", "warning");
						await updateRegistry(cfgFor(ctx), (reg: any) => { reg.meta.reviewPaused = rest[0] === "off"; });
						refresh(rt, ctx); return say(rest[0] === "off" ? "GitHub 자동 확인을 중지합니다. 진행 중인 요청은 마무리합니다. 상세 재검증은 가능합니다." : "GitHub 자동 확인을 재개합니다.");
					}
					case "diff": return inspect(rt, ctx, true);
					case "show": {
						const target = owner(sideDir(ctx));
						if (!target?.block || target.rexSession !== process.env.REX_SESSION) return say("같은 Rex 세션의 담당 pane이 없습니다. 담당 세션에서 /calliopi-fanout attach 하세요.", "warning");
						if (target.block === process.env.REX_BLOCK) return inspect(rt, ctx);
						const r = await pi.exec("rex", ["move", "-s", target.rexSession as string, target.block, "right", process.env.REX_BLOCK!, "--ratio", "45"], { timeout: 10_000 });
						if (r.code === 0) enqueue(sideDir(ctx), { action: "inspect" });
						return say(r.code === 0 ? "오른쪽 현황에서 작업 선택 → d diff / r 외부 리뷰 (담당 세션이 idle일 때 열립니다)." : r.stderr, r.code === 0 ? "info" : "error");
					}
					case "launch": {
						const file = rest[0] ? path.resolve(ctx.cwd, rest[0]) : "";
						if (!file || !fs.existsSync(file)) return say("usage: /calliopi-fanout <goal>   or   /calliopi-fanout launch <spec.json>", "warning");
						const raw = JSON.parse(fs.readFileSync(file, "utf8"));
						const r = await launch(rt, ctx, { batch: raw.batch || newBatch(raw.title), title: raw.title, agents: raw.agents || [] });
						return say(`fanout: ${r.message}`);
					}
					case "status": { const r = await T(["status"]); return show("Cloud fan-out status", r.out || r.err); }
					case "report": { const r = await T(["report"]); return pi.sendMessage({ customType: "cloud-fanout", content: r.out || r.err, display: true }, { triggerTurn: false }); }
					case "tree": { const r = await T(["tree", rest[0] ?? ""]); return show(`tree ${rest[0] ?? ""}`, r.out || r.err); }
					case "add": { const r = await T(["add", rest[0] ?? "", ...(rest[1] ? ["--label", rest[1]] : [])]); startWatcher(rt, ctx); ensureDaemon(ctx); return say(r.out || r.err, r.ok ? "info" : "error"); }
					case "followup": case "steer": {
						const [label, ...words] = rest;
						if (!label || !words.length) return say(`usage: /calliopi-fanout ${sub} <label> <text>`, "warning");
						const r = await T(["followup", label, "--prompt", words.join(" "), "--yes", ...(sub === "steer" ? ["--steer"] : [])]);
						ensureDaemon(ctx);
						return say(r.out || r.err, r.ok ? "info" : "error");
					}
					case "pr": {
						if (!rest[0]) return say("usage: /calliopi-fanout pr <label>", "warning");
						const r = await T(["pr", rest[0]]); return show(`PR ${rest[0]}`, r.out || r.err);
					}
					case "merge": {
						// A: merge locally with explicit approval, pinned to the head shown in the dialog.
						if (!rest[0]) return say("usage: /calliopi-fanout merge <label>", "warning");
						const r = await T(["pr", rest[0], "--json"]);
						const s = r.ok ? json(r.out) : null;
						if (!s) return say(r.err || r.out || "PR 상태를 읽지 못했습니다.", "error");
						const head = `#${s.number} ${s.title}\n${s.headRefName} → ${s.baseRefName} @ ${String(s.headRefOid).slice(0, 7)}\n${s.url}`;
						if (s.mergeable === "CONFLICTING") {
							// B: conflicts are resolved by Cursor on the PR, not locally.
							if (await ctx.ui.confirm("충돌이 있어 머지할 수 없습니다", `${head}\n\n@cursor에게 ${s.baseRefName} 기준 rebase와 충돌 해결을 요청할까요?`)) {
								const f = await T(["fix", rest[0], "--rebase", "--yes"]);
								return say(f.ok ? "@cursor에게 rebase를 요청했습니다. 새 커밋이 올라오면 다시 merge하세요." : f.err || f.out, f.ok ? "info" : "error");
							}
							return;
						}
						if (s.blockers?.length) return say(`머지 불가: ${s.blockers.join("; ")}`, "warning");
						if (!(await ctx.ui.confirm("PR 머지", `${head}\n\nsquash 머지하고 브랜치를 삭제할까요? 표시된 커밋(${String(s.headRefOid).slice(0, 7)}) 이후 변경이 있으면 거부됩니다.`))) return;
						const m = await T(["merge", rest[0], "--sha", s.headRefOid, "--yes"]);
						return say(m.out || m.err, m.ok ? "info" : "error");
					}
					case "fix": {
						// B: delegate a change on the PR to Cursor's GitHub integration.
						const [label, ...words] = rest;
						if (!label || !words.length) return say("usage: /calliopi-fanout fix <label> <request>", "warning");
						if (!(await ctx.ui.confirm("@cursor에게 수정 요청", `${label}의 PR에 다음 댓글을 답니다:\n\n@cursor ${words.join(" ")}`))) return;
						const r = await T(["fix", label, "--prompt", words.join(" "), "--yes"]);
						return say(r.out || r.err, r.ok ? "info" : "error");
					}
					case "cancel": {
						if (!rest[0]) return say("usage: /calliopi-fanout cancel <label>", "warning");
						if (!(await ctx.ui.confirm("Cancel run?", `Cancel the current run of ${rest[0]}?`))) return;
						const r = await T(["cancel", rest[0], "--yes"]); return say(r.out || r.err, r.ok ? "info" : "error");
					}
					case "up": {
						if (!process.env.REX_SESSION) return say("not inside a rex terminal (REX_SESSION unset)", "warning");
						const r = await pi.exec(FANOUT_SH, ["up"], { cwd: ctx.cwd, timeout: 60_000 });
						return say(r.code === 0 ? "rex panes up" : r.stderr || r.stdout, r.code === 0 ? "info" : "error");
					}
					case "widget": { rt.widgetOn = rest[0] !== "off"; rt.floatingHandle?.setHidden(!rt.widgetOn); if (rt.widgetOn) mountFloating(rt, ctx); return; }
					case "stop": { const r = await T(["stop"]); return say(r.out); }
					default: {
						// Anything else is a goal: the model plans the tasks and calls calliopi_fanout_launch (table approval follows).
						const goal = (args || "").trim();
						if (!goal) return say("usage: /calliopi-fanout <goal>", "warning");
						if (owner(sideDir(ctx)) && !isOwner(ctx)) {
							const id = enqueue(sideDir(ctx), { goal });
							return say(`담당 세션으로 전달했습니다 (${id.slice(0, 8)}). 승인은 그 세션에서 진행합니다.`);
						}
						// Hidden planning brief: the transcript only shows the user's own /calliopi-fanout line.
						pi.sendMessage({ customType: "cloud-fanout-plan", content: PLAN_INSTRUCTIONS(goal), display: false, details: { goal } },
							ctx.isIdle() ? { triggerTurn: true } : { deliverAs: "followUp", triggerTurn: true });
						return;
					}
				}
			} catch (e: any) { say(`fanout: ${e.message}`, "error"); }
		},
	});
}
