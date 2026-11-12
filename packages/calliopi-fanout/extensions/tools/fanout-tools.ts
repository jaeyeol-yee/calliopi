// Tools the model can call: launch (with table approval), status, report, diff tree, follow-up.
import { truncateHead } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { newBatch } from "#lib/plan.ts";
import { short } from "#lib/util.ts";
import { ensureDaemon, tracker, type Runtime } from "#extensions/runtime/state.ts";
import { launch } from "#extensions/runtime/launch.ts";

const text = (s: string, maxLines: number, maxBytes: number) => ({ content: [{ type: "text" as const, text: truncateHead(s, { maxLines, maxBytes }).content }], details: undefined });

export function registerTools(rt: Runtime) {
	const { pi } = rt;
	pi.registerTool({
		name: "calliopi_fanout_launch",
		label: "Cloud fan-out: launch",
		description: "Start several Cursor Cloud Agents in parallel, one per task, and track them in the background. The user sees the plan as a table and approves, edits or cancels it. Returns immediately with agent ids; the batch report arrives in a later turn.",
		promptSnippet: "Fan out independent coding tasks to Cursor Cloud Agents running in parallel",
		promptGuidelines: [
			"Use calliopi_fanout_launch only for independent tasks that can run in parallel in the cloud; give each task a short unique label and a self-contained prompt.",
			"After calliopi_fanout_launch, do not poll in a loop; check calliopi_fanout_status only when the user asks, and the report arrives automatically when the batch finishes.",
		],
		parameters: Type.Object({
			title: Type.String({ description: "Short human title for the whole fan-out (few words, user's language); names the batch, report and Pi session" }),
			batch: Type.Optional(Type.String({ description: "Batch id (default: derived from title)" })),
			tasks: Type.Array(Type.Object({
				label: Type.String({ description: "Short unique kebab-case label" }),
				summary: Type.String({ description: "One line: the goal of this task (user's language); becomes its title" }),
				instruction: Type.String({ description: "Self-contained: what to do, where, constraints, how to verify" }),
				output: Type.String({ description: "The concrete deliverable (pushed commit / report format / file)" }),
			}), { minItems: 1, maxItems: 20 }),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			const r = await launch(rt, ctx, { batch: params.batch || newBatch(params.title), title: params.title, agents: params.tasks }, signal);
			const created = (r.created || []).map((c: any) => `${c.phase} ${c.label} ${short(c.agentId)}`).join("\n");
			const text = r.message === "cancelled"
				? "The user cancelled the fan-out plan. Ask what to change, or stop."
				: `${r.message}\n${created}\n${r.message.startsWith("queued") ? "Work has not launched yet. Approval and full reports belong to the dedicated session." : "The batch report will arrive in a later turn; do not poll."}`;
			return { content: [{ type: "text", text: text.trim() }], details: { batch: r.spec.batch, created: r.created } };
		},
	});

	pi.registerTool({
		name: "calliopi_fanout_status",
		label: "Cloud fan-out: status",
		description: "Show the raw status and summary of tracked Cursor Cloud Agents (local registry, no API calls).",
		promptSnippet: "Check the status of fanned-out Cursor Cloud Agents",
		parameters: Type.Object({}),
		async execute(_id, _p, signal, _u, ctx) {
			const r = await tracker(rt, ctx, ["status"], signal);
			return text(r.out || r.err, 200, 20_000);
		},
	});

	pi.registerTool({
		name: "calliopi_fanout_report",
		label: "Cloud fan-out: report",
		description: "Aggregate summaries, pull requests and token totals of fanned-out Cursor Cloud Agents.",
		parameters: Type.Object({ batch: Type.Optional(Type.String()) }),
		async execute(_id, p, signal, _u, ctx) {
			const r = await tracker(rt, ctx, ["report", ...(p.batch ? ["--batch", p.batch] : [])], signal);
			return text(r.out || r.err, 400, 30_000);
		},
	});

	pi.registerTool({
		name: "calliopi_fanout_diff",
		label: "Cloud fan-out: changes",
		description: "File tree with added/modified/deleted files of a cloud agent's pushed branch, read from GitHub via gh. Read-only.",
		parameters: Type.Object({ label: Type.String({ description: "Agent label or id" }) }),
		async execute(_id, p, signal, _u, ctx) {
			const r = await tracker(rt, ctx, ["tree", p.label], signal);
			return text(r.out || r.err, 300, 20_000);
		},
	});

	pi.registerTool({
		name: "calliopi_fanout_followup",
		label: "Cloud fan-out: follow-up",
		description: "Send a follow-up instruction to a tracked Cursor Cloud Agent (new run), or steer its running turn. Requires the user's approval in the UI.",
		parameters: Type.Object({
			label: Type.String(), prompt: Type.String(),
			steer: Type.Optional(Type.Boolean({ description: "Deliver into the running turn instead of starting a new run" })),
		}),
		async execute(_id, p, signal, _u, ctx) {
			if (!ctx.hasUI) throw new Error("needs approval: run /calliopi-fanout followup interactively");
			if (!(await ctx.ui.confirm(`${p.steer ? "Steer" : "Follow up"} ${p.label}?`, p.prompt))) return { content: [{ type: "text", text: "cancelled by user" }], details: undefined };
			const r = await tracker(rt, ctx, ["followup", p.label, "--prompt", p.prompt, "--yes", ...(p.steer ? ["--steer"] : [])], signal);
			ensureDaemon(ctx);
			if (!r.ok) throw new Error(r.err || r.out);
			return { content: [{ type: "text", text: r.out }], details: undefined };
		},
	});
}
