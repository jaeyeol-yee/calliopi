// Calliopi cloud fan-out — Pi extension.
// Reads (registry, dashboard, report) import the harness libs directly; anything that mutates state or
// talks to the network runs the multiplexer-agnostic tracker CLI so locking/logging stay in one place.
// Nothing starts in the factory: the registry watcher starts on session_start and stops on session_shutdown.
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateHead, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, highlightCode } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi, matchesKey } from "@earendil-works/pi-tui";
import { owner, attach, detach, enqueue, drain } from "../lib/sidecar.mjs";
import { createReviewService, syncReviews, prTarget } from "../lib/github-review.mjs";
import { taskState, freshness } from "../lib/floating-model.mjs";
import { floatingList } from "./components/floating.ts";
import { metadataTable, type MetadataValue } from "./components/metadata.ts";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../lib/config.mjs";
import { load, update as updateRegistry } from "../lib/registry.mjs";
import { icon } from "../lib/dashboard.mjs";
import { aggregate, toMarkdown } from "../lib/report.mjs";
import { isTerminal, short, cleanResult } from "../lib/util.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TRACKER = path.join(HERE, "..", "bin", "tracker.mjs");
const FANOUT_SH = path.join(HERE, "..", "rex", "fanout.sh");
const NODE = process.env.CALLIOPI_NODE || "node";

type Agent = ReturnType<typeof load>["agents"][string];

export default function (pi: ExtensionAPI) {
	let watcher: fs.FSWatcher | null = null;
	let debounce: NodeJS.Timeout | null = null;
	let lastStatus = new Map<string, string>();
	let notifiedBatches = new Set<string>();
	let widgetOn = true;
	let registration: any = null;
	let mailboxTimer: NodeJS.Timeout | null = null;
	let inspectorOpen = false;
	let floatingHandle: any = null;
	let closeFloating: (() => void) | null = null;
	let floatingMounted = false;
	let renderFloating: (() => void) | null = null;
	let floatingAgents: Agent[] = [];
	let lastReviewStart = 0;
	const reviewing = new Set<string>();
	const reviewService = createReviewService({ exec: (command: string, args: string[], options: any) => pi.exec(command, args, options) });

	async function revalidate(ctx: ExtensionContext, a?: Agent) {
		const id = a?.agentId || a?.key;
		if (!id || reviewing.has(id)) return;
		reviewing.add(id);
		try { await syncReviews(cfgFor(ctx), reviewService, { agentId: id, detail: true, limit: 100 }); }
		catch (e: any) { ctx.ui.notify(`GitHub: ${e.message}`, "warning"); }
		finally { reviewing.delete(id); }
	}

	function mountFloating(ctx: ExtensionContext) {
		const modeArg = process.argv.find(a => a.startsWith("--tui-mode="))?.split("=")[1] || (process.argv.includes("--tui-mode") ? process.argv[process.argv.indexOf("--tui-mode") + 1] : undefined);
		if (ctx.mode !== "tui" || (modeArg || pi.getSettings().tuiMode) === "regular" || floatingMounted || !widgetOn || !floatingAgents.length) return;
		floatingMounted = true;
		void ctx.ui.custom<void>((tui, _theme, _keys, done) => {
			closeFloating = () => done();
			renderFloating = () => tui.requestRender();
			return floatingList({ agents: () => floatingAgents, theme: () => ctx.ui.theme,
				render: () => tui.requestRender(), open: id => { if (id.startsWith("approval:")) ctx.ui.notify("팬아웃 담당 세션의 승인 화면을 확인하세요.", "info"); else void inspect(ctx, false, id); }, unfocus: () => floatingHandle?.unfocus(),
			});
		}, { overlay: true, overlayOptions: { anchor: "top-right", width: 42, maxHeight: 12, margin: { top: 1, right: 1 }, nonCapturing: true,
			visible: (w: number, h: number) => w >= 48 && h >= 18 }, onHandle: handle => { floatingHandle = handle; if (inspectorOpen) handle.setHidden(true); },
		}).catch((e: any) => ctx.ui.notify(`fanout floating: ${e.message}`, "warning")).finally(() => {
			floatingMounted = false; floatingHandle = null; closeFloating = null; renderFloating = null;
		});
	}

	function ensureReviewDaemon(ctx: ExtensionContext, agents: Agent[]) {
		if (load(cfgFor(ctx)).meta.reviewPaused) return;
		if (!agents.some(a => a.status === "FINISHED" && (a.git?.branches || []).some((b: any) => prTarget(b.prUrl) && a.reviews?.[b.prUrl]?.state !== "merged"))) return;
		if (Date.now() - lastReviewStart < 5000) return;
		lastReviewStart = Date.now();
		const file = path.join(stateDir(ctx), "review.pid");
		try { const pid = Number(fs.readFileSync(file, "utf8")); if (pid) { process.kill(pid, 0); return; } } catch { /* stale */ }
		const child = spawn(NODE, [path.join(HERE, "..", "bin", "review-watch.mjs"), stateDir(ctx)], { cwd: ctx.cwd, detached: true, stdio: "ignore" });
		child.on("error", () => {}); child.unref();
	}
	const sideDir = (ctx: ExtensionContext) => path.join(stateDir(ctx), "sidecar");
	const isOwner = (ctx: ExtensionContext) => owner(sideDir(ctx))?.sessionId === ctx.sessionManager.getSessionId();

	async function inspect(ctx: ExtensionContext, localReview = false, initialId?: string) {
		if (ctx.mode !== "tui" || inspectorOpen) return;
		inspectorOpen = true;
		floatingHandle?.setHidden(true);
		let timer: NodeJS.Timeout | undefined;
		try {
			await ctx.ui.custom<void>((tui, theme, keys, done) => {
				let selected = 0, offset = 0, detail = localReview || !!initialId, showMetadata = true;
				let review: string | null = localReview ? "diff를 불러오는 중…" : null;
				let loading = false, closed = false;
				let contentCache: { text: string; width: number; theme: any; lines: string[]; diff: boolean } | null = null;
				const loadDiff = async (local: boolean, external = false) => {
					if (loading) return;
					loading = true; detail = true; offset = 0; review = "diff를 불러오는 중…"; tui.requestRender();
					try {
						let r;
						if (local) {
							r = await pi.exec("git", ["--no-pager", "diff", "--no-ext-diff", "--no-textconv", "--color=never", "HEAD", "--"], { cwd: ctx.cwd, timeout: 20_000, maxBuffer: 4_000_000 });
							const untracked = await pi.exec("git", ["ls-files", "-z", "--others", "--exclude-standard"], { cwd: ctx.cwd, timeout: 10_000 });
							review = `로컬 변경 · HEAD 대비 (staged + unstaged + untracked)\n\n${r.stdout || r.stderr || "추적 중인 파일의 변경이 없습니다."}`;
							const files = untracked.stdout.split("\0").filter(Boolean);
							for (const file of files.slice(0, 40)) {
								if (review.length > 1_000_000) { review += "\n⚠ 미추적 파일 diff가 1MB를 넘어 나머지는 생략했습니다."; break; }
								const patch = await pi.exec("git", ["--no-pager", "diff", "--no-index", "--no-ext-diff", "--no-textconv", "--color=never", "--", "/dev/null", file], { cwd: ctx.cwd, timeout: 10_000, maxBuffer: 200_000 });
								review += `\n${patch.stdout || patch.stderr}`;
								if (patch.truncated || patch.killed) review += `\n⚠ ${file}: 출력 제한 또는 시간 초과로 불완전한 diff입니다.\n`;
							}
							if (files.length > 40) review += `\n⚠ 미추적 파일 ${files.length}개 중 처음 40개만 표시합니다.\n`;
						} else {
							const a = agents[selected];
							const branch = a?.git?.branches?.[0];
							if (!branch?.repoUrl || !branch?.branch) throw new Error("아직 push된 브랜치 정보가 없습니다. 읽기 전용 분석 작업에는 코드 diff가 없습니다.");
							const repo = branch.repoUrl.replace(/^(https?:\/\/)?github\.com\//, "").replace(/\.git$/, "");
							if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error("지원하지 않는 GitHub 저장소 주소입니다.");
							const base = await pi.exec("gh", ["api", `repos/${repo}`, "--jq", ".default_branch"], { timeout: 20_000 });
							if (base.code !== 0) throw new Error(`저장소 ${repo}에 접근할 수 없습니다. 주소 또는 gh 인증 권한을 확인하세요.\n${base.stderr}`);
							// Cursor assigns a branch name before any push; metadata alone is not proof it exists.
							const pushed = await pi.exec("gh", ["api", `repos/${repo}/branches/${encodeURIComponent(branch.branch)}`, "--silent"], { timeout: 20_000 });
							if (pushed.code !== 0) {
								if (/404|Branch not found|Not Found/i.test(pushed.stderr + pushed.stdout)) throw new Error(`리뷰할 원격 브랜치가 없습니다.\n\n작업: ${a.label}\n브랜치: ${branch.branch}\n\nCursor가 반환한 브랜치 이름은 실제 push 여부를 보장하지 않습니다. 읽기 전용 분석 작업은 코드 변경 없이 완료될 수 있습니다. 결과 요약은 Enter로 확인하세요.\n코드 변경 작업이라면 에이전트가 커밋을 push했는지 확인해야 합니다.`);
								throw new Error(`원격 브랜치 확인에 실패했습니다.\n${pushed.stderr || pushed.stdout}`);
							}
							r = await pi.exec("gh", ["api", `repos/${repo}/compare/${encodeURIComponent(base.stdout.trim())}...${encodeURIComponent(branch.branch)}`, "-H", "Accept: application/vnd.github.diff"], { timeout: 30_000, maxBuffer: 4_000_000 });
							if (r.code !== 0) throw new Error(r.stderr || "diff를 가져오지 못했습니다.");
							review = `${a.label} · ${repo}\n${base.stdout.trim()}...${branch.branch}\n\n${r.stdout || "변경사항이 없습니다."}`;
						}
						if (r.truncated || r.killed) review += "\n\n⚠ 출력 제한 또는 시간 초과: diff가 완전하지 않습니다.";
						if (external) {
							if (!process.env.REX_SESSION || !process.env.REX_BLOCK) throw new Error("외부 리뷰는 Rex 터미널에서만 열 수 있습니다. d 키로 내장 diff를 확인하세요.");
							const check = await pi.exec("delta", ["--version"], { timeout: 5000 });
							if (check.code !== 0) throw new Error("delta를 실행할 수 없습니다. d 키로 내장 diff를 확인하세요.");
							const dir = path.join(cfgFor(ctx).dir, "reviews");
							fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
							const file = path.join(dir, `review-${Date.now()}.diff`);
							fs.writeFileSync(file, review, { mode: 0o600 });
							const pane = await pi.exec("rex", ["split", "-s", process.env.REX_SESSION, "-b", process.env.REX_BLOCK, "--split=right", "--ratio", "50", "--label", `review-${agents[selected]?.label || "diff"}`, "--keep-open", "-c", ctx.cwd, "--json", "--", "sh", "-c", 'delta --paging=always < "$1"', "review", file], { timeout: 10_000 });
							if (pane.code !== 0) throw new Error(pane.stderr || "리뷰 pane을 열지 못했습니다.");
							ctx.ui.notify("외부 diff 리뷰를 열었습니다. ↑↓ / PgUp / PgDn 스크롤 · q 종료", "info");
						}
					} catch (e: any) { review = `diff를 열 수 없습니다.\n\n${e.message}`; }
					finally { loading = false; if (!closed) tui.requestRender(); }
				};
				let agents: Agent[] = [];
				const update = () => { try { agents = Object.values(load(cfgFor(ctx)).agents) as Agent[]; } catch { agents = []; } tui.requestRender(); };
				update();
				if (initialId) { selected = Math.max(0, agents.findIndex(a => (a.agentId || a.key) === initialId)); void revalidate(ctx, agents[selected]); }
				timer = setInterval(update, 1000);
				if (localReview) void loadDiff(true);
				return {
					render(w: number) {
						selected = Math.max(0, Math.min(selected, agents.length - 1));
						const a = agents[selected];
						// Border + two-cell horizontal padding; reserve vertical space for the frame.
						const padding = w >= 24 ? 2 : 1;
						const innerWidth = Math.max(1, w - 2 - padding * 2);
						const contentWidth = Math.max(1, innerWidth - 4); // Separate rail: │ + space + ANSI-colored triangle + space.
						const height = Math.max(1, Math.min(16, (process.stdout.rows || 30) - 14));
						let body: string[];
						let scrollTop = 0, totalLines = 0;
						if (detail && (a || review !== null)) {
							const text = review ?? (cleanResult(a.runs?.[a.runId]?.result) || "아직 결과가 없습니다.");
							const diff = review !== null;
							if (!contentCache || contentCache.text !== text || contentCache.width !== contentWidth || contentCache.theme !== ctx.ui.theme || contentCache.diff !== diff) {
								const lines = diff ? text.split("\n").flatMap(s => wrapTextWithAnsi(s, contentWidth)).map(s => theme.fg(s.startsWith("+") ? "success" : s.startsWith("-") ? "error" : s.startsWith("@@") ? "accent" : "text", s)) : highlightCode(text, "markdown").flatMap(s => wrapTextWithAnsi(s, contentWidth));
								contentCache = { text, width: contentWidth, theme: ctx.ui.theme, lines, diff };
							}
							const branches = a?.git?.branches || [];
							const agentUrl = a?.url || (/^bc-[\w-]+$/.test(a?.agentId || "") ? `https://cursor.com/agents/${a.agentId}` : undefined);
							const repoLink = (b: any) => {
								const repo = String(b.repoUrl || "").replace(/^(https?:\/\/)?github\.com\//, "").replace(/\.git$/, "");
								return /^[\w.-]+\/[\w.-]+$/.test(repo) ? `https://github.com/${repo}` : undefined;
							};
							const meta: [string, MetadataValue][] = diff ? [] : [
								["작업", a.label || a.name || ""], ["목표", a.summary || ""], ["상태", `${taskState(a).text} · ${a.status || a.phase}`],
								["에이전트", { text: a.agentId || a.key || "", url: agentUrl }], ["실행", a.runId || ""], ["배치", a.batch || ""],
								["저장소", branches.flatMap((b: any, i: number) => [...(i ? ["\n"] : []), { text: b.repoUrl || "—", url: repoLink(b) }])],
								["브랜치", branches.flatMap((b: any, i: number) => [...(i ? ["\n"] : []), { text: b.branch || "—", url: repoLink(b) && b.branch ? `${repoLink(b)}/tree/${encodeURIComponent(b.branch)}` : undefined }])],
								["PR", branches.filter((b: any) => b.prUrl).flatMap((b: any, i: number) => [...(i ? ["\n"] : []), { text: b.prUrl, url: b.prUrl }, ` · ${a.reviews?.[b.prUrl]?.state || "미확인"}${a.reviews?.[b.prUrl]?.lastError ? ` · ${a.reviews[b.prUrl].lastError}` : ""}`])],
								["갱신", `${reviewing.has(a.agentId || a.key) ? "갱신 중 · " : ""}${freshness(a)}`],
							];
							const lines = diff ? contentCache.lines : [...(showMetadata ? [...metadataTable(meta, contentWidth, theme), ""] : []), theme.fg("accent", theme.bold("결과")), "", ...contentCache.lines];
							offset = Math.min(offset, Math.max(0, lines.length - height));
							body = lines.slice(offset, offset + height);
							scrollTop = offset; totalLines = lines.length;
						} else {
							const start = Math.max(0, selected - height + 1);
							scrollTop = start; totalLines = agents.length;
							body = agents.slice(start, start + height).map((a, i) => {
								const active = start + i === selected;
								const row = truncateToWidth(`${active ? "›" : " "} ${taskState(a).icon} ${a.label} · ${taskState(a).text} · ${a.summary || ""}`, contentWidth);
								return active ? theme.fg("accent", theme.bold(row)) : row;
							});
						}
						const canUp = scrollTop > 0, canDown = scrollTop + height < totalLines;
						const viewport = Array.from({ length: height }, (_, i) => {
							const text = truncateToWidth(body[i] || (i === 0 && !body.length ? "작업이 없습니다." : ""), contentWidth);
							const glyph = height === 1 ? (canDown ? "▼" : canUp ? "▲" : " ") : i === 0 && canUp ? "▲" : i === height - 1 && canDown ? "▼" : " ";
							return text + " ".repeat(Math.max(0, contentWidth - visibleWidth(text))) + theme.fg("dim", "│") + " " + theme.fg("accent", theme.bold(glyph)) + " ";
						});
						const title = review !== null ? "☁ Diff 리뷰" : detail ? `☁ Fan-out · ${a?.label || "상세"}` : `☁ Fan-out 현황 · ${agents.length}개 작업`;
						const hint = detail ? "↑↓ / 휠 · m 표 접기 · d diff · r 리뷰 · u 갱신 · Esc" : "↑↓ 선택 · Enter 상세 · d diff · r 외부 리뷰 · Esc";
						const border = (s: string) => theme.fg("dim", s);
						const row = (s = "") => {
							const text = truncateToWidth(s, innerWidth);
							return border("│") + " ".repeat(padding) + text + " ".repeat(Math.max(0, innerWidth - visibleWidth(text)) + padding) + border("│");
						};
						if (w < 8) return [truncateToWidth(title, w)];
						return [
							border("╭" + "─".repeat(w - 2) + "╮"),
							row(), row(theme.fg("accent", theme.bold(title))), row(),
							...viewport.map(s => row(s)),
							row(),
							border("├" + "─".repeat(w - 2) + "┤"),
							row(theme.fg("dim", hint)), row(),
							border("╰" + "─".repeat(w - 2) + "╯"),
						];
					},
					handleInput(data: string) {
						if (keys.matches(data, "tui.select.cancel")) { if (detail && !localReview) { detail = false; review = null; offset = 0; } else { closed = true; done(); return; } }
						else if (data === "m" && detail && review === null) { showMetadata = !showMetadata; offset = 0; }
						else if (data === "u") { void revalidate(ctx, agents[selected]); return; }
						else if (data === "a" && agents[selected]?.status === "FINISHED" && !(agents[selected].git?.branches || []).some((b: any) => b.prUrl)) {
							const a = agents[selected];
							void updateRegistry(cfgFor(ctx), (reg: any) => { const current = reg.agents[a.agentId || a.key]; if (current?.runId === a.runId) current.reviewAckRunId = a.runId; }).catch((e: any) => ctx.ui.notify(e.message, "warning"));
							return;
						}
						else if (data === "r") { void loadDiff(localReview, true); return; }
						else if (data === "d" && !localReview) { void loadDiff(false); return; }
						else if (matchesKey(data, "pageup")) { offset = Math.max(0, offset - 10); }
						else if (matchesKey(data, "pagedown")) { offset += 10; }
						else if (matchesKey(data, "home")) { offset = 0; selected = 0; }
						else if (matchesKey(data, "end")) { if (detail) offset = Number.MAX_SAFE_INTEGER; else selected = agents.length - 1; }
						else if (keys.matches(data, "tui.select.confirm")) { detail = true; offset = 0; void revalidate(ctx, agents[selected]); }
						else if (keys.matches(data, "tui.select.up")) { if (detail) offset = Math.max(0, offset - 1); else selected = Math.max(0, selected - 1); }
						else if (keys.matches(data, "tui.select.down")) { if (detail) offset++; else selected = Math.min(agents.length - 1, selected + 1); }
						tui.requestRender();
					},
					handleMouse(event: { type: string; wheelDelta?: number }) {
						if (event.type !== "wheel") return;
						const delta = event.wheelDelta || 0;
						if (detail) offset = Math.max(0, offset + delta * 3);
						else selected = Math.max(0, Math.min(agents.length - 1, selected + delta));
						tui.requestRender(); return { handled: true };
					},
					invalidate() {},
				};
			}, { overlay: true, overlayOptions: { width: "90%", anchor: "center", margin: 1 } });
		} finally { clearInterval(timer); inspectorOpen = false; if (widgetOn) floatingHandle?.setHidden(false); }
	}

	const stateDir = (ctx: ExtensionContext) => process.env.CURSOR_FANOUT_DIR || path.join(ctx.cwd, ".cursor-fanout");
	const cfgFor = (ctx: ExtensionContext) => loadConfig({ dir: stateDir(ctx) });

	async function T(ctx: ExtensionContext, args: string[], signal?: AbortSignal) {
		const r = await pi.exec(NODE, [TRACKER, "--dir", stateDir(ctx), ...args], { cwd: ctx.cwd, signal, timeout: 120_000 });
		return { ok: r.code === 0, code: r.code, out: r.stdout.trim(), err: r.stderr.trim() };
	}
	const json = (s: string) => { try { return JSON.parse(s); } catch { return null; } };

	function ensureDaemon(ctx: ExtensionContext) {
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

	function refresh(ctx: ExtensionContext) {
		const cfg = cfgFor(ctx);
		ctx.ui.setStatus("cloud-fanout", undefined); ctx.ui.setWidget("cloud-fanout", undefined);
		if (!fs.existsSync(cfg.registryPath)) { floatingAgents = []; floatingHandle?.setHidden(true); return; }
		let reg; try { reg = load(cfg); } catch { return; }
		const agents = Object.values(reg.agents) as Agent[];
		const approvals = (Object.values(reg.meta.approvals || {}) as any[]).filter(a => { try { if (!a.pid) return false; process.kill(a.pid, 0); return true; } catch { return false; } });
		floatingAgents = [...approvals, ...agents];
		if (!floatingAgents.length) { floatingHandle?.setHidden(true); return; }
		floatingHandle?.setHidden(!widgetOn || inspectorOpen);
		ctx.ui.setStatus("cloud-fanout", undefined);
		ctx.ui.setWidget("cloud-fanout", undefined);
		ensureReviewDaemon(ctx, agents);
		mountFloating(ctx);
		renderFloating?.();

		// Notify on terminal transitions (local file only, zero API calls).
		for (const a of agents) {
			const id = a.agentId || a.key;
			const prev = lastStatus.get(id);
			const now = a.missing ? "MISSING" : a.status || a.phase;
			if (prev && prev !== now && isTerminal(now) && a.finalized) {
				ctx.ui.notify(`${icon(now)} ${a.label}: ${now}${a.git?.branches?.[0]?.prUrl ? ` · ${a.git.branches[0].prUrl}` : ""}`, now === "FINISHED" ? "info" : "warning");
			}
			lastStatus.set(id, now);
		}
		// When a whole batch is terminal, queue its report for the model's next turn (does not interrupt).
		for (const batch of new Set(agents.map((a) => a.batch).filter(Boolean))) {
			const agg = aggregate(cfg, { batch });
			if (agg.allDone && !notifiedBatches.has(batch)) {
				notifiedBatches.add(batch);
				const md = truncateHead(toMarkdown(agg), { maxLines: 300, maxBytes: 20_000 }).content;
				if (!owner(sideDir(ctx)) || isOwner(ctx)) {
					pi.sendMessage({ customType: "cloud-fanout", content: md, display: true, details: { batch } }, { deliverAs: "nextTurn" });
				} else ctx.ui.notify(`☁ ${batch} 완료 · /fanout inbox로 결과 확인`, "info");
			}
		}
	}

	function startWatcher(ctx: ExtensionContext) {
		const cfg = cfgFor(ctx);
		stopWatcher();
		try { fs.mkdirSync(cfg.dir, { recursive: true, mode: 0o700 }); } catch { /* read-only cwd */ }
		// Seed: batches already terminal at startup are not re-announced.
		try { const reg = load(cfg); for (const b of new Set(Object.values(reg.agents).map((a: Agent) => a.batch))) if (b && aggregate(cfg, { batch: b }).allDone) notifiedBatches.add(b); } catch { /* none */ }
		try {
			watcher = fs.watch(cfg.dir, (_e, name) => {
				if (!name || !String(name).startsWith("registry.json")) return;
				if (debounce) clearTimeout(debounce);
				debounce = setTimeout(() => refresh(ctx), 250);
			});
		} catch { /* dir missing */ }
		refresh(ctx);
	}
	function stopWatcher() {
		watcher?.close(); watcher = null;
		if (debounce) clearTimeout(debounce);
	}

	pi.on("session_start", async (_e, ctx) => {
		const role = ctx.sessionManager.getEntries().filter((e: any) => e.type === "custom" && e.customType === "cloud-fanout-owner").at(-1) as any;
		if (ctx.mode === "tui" && role?.data?.sessionId === ctx.sessionManager.getSessionId() && role.data.enabled) {
			try { registration = attach(sideDir(ctx), { sessionId: ctx.sessionManager.getSessionId(), token: role.data.token, rexSession: process.env.REX_SESSION, block: process.env.REX_BLOCK }); }
			catch (e: any) { ctx.ui.notify(`fanout: ${e.message}`, "warning"); }
		}
		if (ctx.hasUI) startWatcher(ctx);
		if (ctx.mode === "tui") mailboxTimer = setInterval(() => {
			if (!registration || !ctx.isIdle() || inspectorOpen) return;
			try { drain(sideDir(ctx), registration.token, (payload: any) => {
				if (payload.action === "inspect") { void inspect(ctx); return; }
				pi.sendMessage({ customType: "cloud-fanout-plan", content: payload.spec ? `Call cloud_fanout_launch with this plan, preserving all instructions. Require normal UI approval.\n${JSON.stringify(payload.spec)}` : PLAN_INSTRUCTIONS(payload.goal), display: false }, { deliverAs: "followUp", triggerTurn: true });
			}); } catch (e: any) { ctx.ui.notify(`fanout mailbox: ${e.message}`, "error"); }
		}, 1000);
	});
	pi.on("session_shutdown", async (_e, ctx) => {
		stopWatcher(); clearInterval(mailboxTimer!); mailboxTimer = null;
		closeFloating?.();
		if (registration) detach(sideDir(ctx), registration.token);
		registration = null;
	});

	// ---------------------------------------------------------------- plan → approve (table) → launch
	type Task = { label: string; summary: string; instruction: string; output: string; prompt?: string };
	type Spec = { batch: string; title?: string; agents: Task[] };
	const stamp = () => new Date().toISOString().slice(0, 16).replace(/[:T-]/g, "");
	const slug = (t: string) => t.toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 40);
	const newBatch = (title?: string) => (title && slug(title) ? `${slug(title)}-${stamp().slice(4)}` : `pi-${stamp()}`);

	function writeSpec(ctx: ExtensionContext, spec: Spec) {
		const dir = path.join(cfgFor(ctx).dir, "specs");
		fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
		const file = path.join(dir, `${spec.batch.replace(/[^\w.-]/g, "_")}.json`);
		fs.writeFileSync(file, JSON.stringify(spec, null, 2), { mode: 0o600 });
		return file;
	}

	function validate(spec: Spec) {
		if (!Array.isArray(spec.agents) || !spec.agents.length) throw new Error("plan has no tasks");
		const seen = new Set<string>();
		for (const t of spec.agents) {
			if (!t?.instruction && t?.prompt) t.instruction = t.prompt; // legacy shape
			if (!t?.label || !t?.summary || !t?.instruction || !t?.output) throw new Error("every task needs label, summary, instruction and output");
			if (seen.has(t.label)) throw new Error(`duplicate label: ${t.label}`);
			seen.add(t.label);
		}
	}

	// Display width: East Asian wide/fullwidth characters take two terminal cells.
	const cellW = (ch: string) => /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(ch) ? 2 : 1;
	const width = (s: string) => [...s].reduce((n, ch) => n + cellW(ch), 0);
	function fit(text: string, w: number) {
		const t = String(text ?? "").replace(/\s+/g, " ").trim();
		if (width(t) <= w) return t + " ".repeat(w - width(t));
		let out = ""; let n = 0;
		for (const ch of t) { if (n + cellW(ch) > w - 1) break; out += ch; n += cellW(ch); }
		return out + "…" + " ".repeat(Math.max(0, w - n - 1));
	}

	function planTable(plan: any, spec: Spec) {
		const rows = (plan.plan || []) as any[];
		const repo = rows[0]?.repo ? String(rows[0].repo).replace(/^https?:\/\/github\.com\//, "") : "(no repo)";
		const lw = Math.min(16, Math.max(5, ...rows.map((r) => width(String(r.label)))));
		const cols = process.stdout.columns || 100;
		const sw = Math.max(18, Math.min(48, Math.floor((cols - lw - 12) * 0.55)));
		const ow = Math.max(14, Math.min(40, cols - lw - sw - 12));
		const head = `${spec.title ? `${spec.title}  ` : ""}☁ ${rows.length} agent(s) · via ${plan.via} · ${repo} · batch ${spec.batch}`;
		const lines = [
			head,
			`billing: ${rows[0]?.billing ?? "plan usage"}${plan.skipped?.length ? ` · ${plan.skipped.length} already tracked (skipped)` : ""}`,
			"",
			` #  ${fit("label", lw)}  ${fit("summary", sw)}  output`,
			` ── ${"─".repeat(lw)}  ${"─".repeat(sw)}  ${"─".repeat(ow)}`,
			...rows.map((r, i) => ` ${String(i + 1).padStart(2)}  ${fit(r.label, lw)}  ${fit(r.summary || r.prompt, sw)}  ${fit(r.output || "", ow).trimEnd()}`),
			"",
			"(Edit plan shows the full instruction of every task)",
		];
		return lines.join("\n");
	}

	/** Show the plan as a table; Launch / Edit (JSON in the editor) / Cancel. Returns the approved spec or null. */
	async function approve(ctx: ExtensionContext, spec: Spec, signal?: AbortSignal): Promise<{ spec: Spec; plan: any } | null> {
		for (;;) {
			validate(spec);
			const specPath = writeSpec(ctx, spec);
			const r = await T(ctx, ["launch", "--spec", specPath, "--json"], signal);
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

	async function launch(ctx: ExtensionContext, spec: Spec, signal?: AbortSignal) {
		const target = owner(sideDir(ctx));
		if (target && !isOwner(ctx)) {
			validate(spec);
			const request = enqueue(sideDir(ctx), { spec });
			return { created: [], message: `queued to dedicated session (${request}); approval happens there`, spec };
		}
		// Cloud workers cannot see local edits. Never push on the user's behalf.
		const git = await pi.exec("git", ["status", "--porcelain"], { cwd: ctx.cwd, timeout: 10_000, signal });
		if (git.code === 0 && git.stdout.trim()) {
			if (!ctx.hasUI) throw new Error("Local changes are not visible to Cloud Agents; interactive confirmation required.");
			if (!(await ctx.ui.confirm("클라우드에 없는 로컬 변경사항", `Cloud Agents는 원격 저장소만 봅니다. 로컬 변경·미추적 파일은 전달되지 않습니다. 자동 push는 하지 않습니다. 원격 코드만으로 작업 가능한지 확인하세요.\n\n${truncateHead(git.stdout, { maxLines: 15, maxBytes: 2000 }).content}\n계속할까요?`))) return { created: [], message: "cancelled", spec };
		}
		const ok = await approve(ctx, spec, signal);
		if (!ok) return { created: [], message: "cancelled", spec };
		const r = await T(ctx, ["launch", "--spec", writeSpec(ctx, ok.spec), "--yes", "--json"], signal);
		const res = json(r.out);
		if (!res) throw new Error(r.err || r.out);
		ensureDaemon(ctx);
		startWatcher(ctx);
		// Name the Pi session after the fan-out (only if the user hasn't named it).
		if (ok.spec.title && !pi.getSessionName()) pi.setSessionName(`☁ ${ok.spec.title}`);
		const n = res.results.filter((x: any) => x.phase === "created").length;
		return { created: res.results, message: `${n}/${res.results.length} created`, spec: ok.spec };
	}

	const PLAN_INSTRUCTIONS = (goal: string) => [
		"Plan a Cursor Cloud fan-out for the goal below, then call cloud_fanout_launch.",
		"- Split it into independent tasks that can run in parallel without depending on each other (usually 2-6).",
		"- Give the whole fan-out a short human title (a few words, in the user's language) as `title`.",
		"- Each task has: label (short unique kebab-case), summary (one line: the goal, in the user's language),",
		"  instruction (self-contained: what to do, where, constraints, how to verify), output (the concrete deliverable:",
		"  e.g. 'a pushed commit that adds X', or 'a one-line report in Korean'). The cloud agent sees only these fields.",
		"- The cloud agents commit and push their own branches; do not ask them to open pull requests unless the goal says so.",
		"- Do not do the work locally and do not inspect files beyond what you need to write good prompts.",
		"- The user approves or edits the plan in a table before anything starts.",
		"",
		`Goal: ${goal}`,
	].join("\n");

	// ---------------------------------------------------------------- /fanout command
	const SUBS = ["attach", "detach", "show", "inbox", "focus", "reviews", "diff", "launch", "status", "report", "up", "add", "followup", "steer", "cancel", "tree", "widget", "stop"];
	pi.registerCommand("fanout", {
		description: "Cursor Cloud fan-out: attach | detach | show (right pane) | inbox (interactive status) | focus (floating keyboard navigation) | diff (local review) | <goal> | launch [spec.json] | status | report | tree <label> | add <bc-id> | followup | steer | cancel | up | widget on|off | stop",
		getArgumentCompletions: (prefix: string) => {
			const items = SUBS.filter((s) => s.startsWith(prefix)).map((s) => ({ value: s, label: s }));
			return items.length ? items : null;
		},
		handler: async (args, ctx) => {
			const [first = "status", ...rest] = (args || "").trim().split(/\s+/);
			const sub = SUBS.includes(first) ? first : "__goal__";
			const say = (text: string, level: "info" | "warning" | "error" = "info") => ctx.ui.notify(text, level);
			const show = (title: string, body: string) =>
				pi.sendMessage({ customType: "cloud-fanout", content: `**${title}**\n\n\`\`\`\n${truncateHead(body, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES }).content}\n\`\`\``, display: true }, { triggerTurn: false });
			try {
				switch (sub) {
					case "attach": {
						if (ctx.mode !== "tui") return say("attach requires an interactive Pi session", "warning");
						if (!registration) registration = attach(sideDir(ctx), { sessionId: ctx.sessionManager.getSessionId(), rexSession: process.env.REX_SESSION, block: process.env.REX_BLOCK });
						pi.appendEntry("cloud-fanout-owner", { enabled: true, sessionId: ctx.sessionManager.getSessionId(), token: registration.token });
						refresh(ctx); return say("이 세션이 팬아웃을 전담합니다. 다른 세션에서 /fanout <목표>로 전달하세요.");
					}
					case "detach": { if (registration) detach(sideDir(ctx), registration.token); registration = null; pi.appendEntry("cloud-fanout-owner", { enabled: false }); refresh(ctx); return say("팬아웃 담당 해제 (클라우드 작업은 계속 실행)"); }
					case "inbox": return inspect(ctx);
					case "focus": { mountFloating(ctx); floatingHandle?.focus(); return; }
					case "reviews": {
						if (!["on", "off"].includes(rest[0])) return say("usage: /fanout reviews on|off", "warning");
						await updateRegistry(cfgFor(ctx), (reg: any) => { reg.meta.reviewPaused = rest[0] === "off"; });
						refresh(ctx); return say(rest[0] === "off" ? "GitHub 자동 확인을 중지합니다. 진행 중인 요청은 마무리합니다. 상세 재검증은 가능합니다." : "GitHub 자동 확인을 재개합니다.");
					}
					case "diff": return inspect(ctx, true);
					case "show": {
						const target = owner(sideDir(ctx));
						if (!target?.block || target.rexSession !== process.env.REX_SESSION) return say("같은 Rex 세션의 담당 pane이 없습니다. 담당 세션에서 /fanout attach 하세요.", "warning");
						if (target.block === process.env.REX_BLOCK) return inspect(ctx);
						const r = await pi.exec("rex", ["move", "-s", target.rexSession, target.block, "right", process.env.REX_BLOCK!, "--ratio", "45"], { timeout: 10_000 });
						if (r.code === 0) enqueue(sideDir(ctx), { action: "inspect" });
						return say(r.code === 0 ? "오른쪽 현황에서 작업 선택 → d diff / r 외부 리뷰 (담당 세션이 idle일 때 열립니다)." : r.stderr, r.code === 0 ? "info" : "error");
					}
					case "launch": {
						const file = rest[0] ? path.resolve(ctx.cwd, rest[0]) : "";
						if (!file || !fs.existsSync(file)) return say("usage: /fanout <goal>   or   /fanout launch <spec.json>", "warning");
						const raw = JSON.parse(fs.readFileSync(file, "utf8"));
						const r = await launch(ctx, { batch: raw.batch || newBatch(raw.title), title: raw.title, agents: raw.agents || [] });
						return say(`fanout: ${r.message}`);
					}
					case "status": { const r = await T(ctx, ["status"]); return show("Cloud fan-out status", r.out || r.err); }
					case "report": { const r = await T(ctx, ["report"]); return pi.sendMessage({ customType: "cloud-fanout", content: r.out || r.err, display: true }, { triggerTurn: false }); }
					case "tree": { const r = await T(ctx, ["tree", rest[0] ?? ""]); return show(`tree ${rest[0] ?? ""}`, r.out || r.err); }
					case "add": { const r = await T(ctx, ["add", rest[0] ?? "", ...(rest[1] ? ["--label", rest[1]] : [])]); startWatcher(ctx); ensureDaemon(ctx); return say(r.out || r.err, r.ok ? "info" : "error"); }
					case "followup": case "steer": {
						const [label, ...words] = rest;
						if (!label || !words.length) return say(`usage: /fanout ${sub} <label> <text>`, "warning");
						const r = await T(ctx, ["followup", label, "--prompt", words.join(" "), "--yes", ...(sub === "steer" ? ["--steer"] : [])]);
						ensureDaemon(ctx);
						return say(r.out || r.err, r.ok ? "info" : "error");
					}
					case "cancel": {
						if (!rest[0]) return say("usage: /fanout cancel <label>", "warning");
						if (!(await ctx.ui.confirm("Cancel run?", `Cancel the current run of ${rest[0]}?`))) return;
						const r = await T(ctx, ["cancel", rest[0], "--yes"]); return say(r.out || r.err, r.ok ? "info" : "error");
					}
					case "up": {
						if (!process.env.REX_SESSION) return say("not inside a rex terminal (REX_SESSION unset)", "warning");
						const r = await pi.exec(FANOUT_SH, ["up"], { cwd: ctx.cwd, timeout: 60_000 });
						return say(r.code === 0 ? "rex panes up" : r.stderr || r.stdout, r.code === 0 ? "info" : "error");
					}
					case "widget": { widgetOn = rest[0] !== "off"; floatingHandle?.setHidden(!widgetOn); if (widgetOn) mountFloating(ctx); return; }
					case "stop": { const r = await T(ctx, ["stop"]); return say(r.out); }
					default: {
						// Anything else is a goal: the model plans the tasks and calls cloud_fanout_launch (table approval follows).
						const goal = (args || "").trim();
						if (!goal) return say("usage: /fanout <goal>", "warning");
						if (owner(sideDir(ctx)) && !isOwner(ctx)) {
							const id = enqueue(sideDir(ctx), { goal });
							return say(`담당 세션으로 전달했습니다 (${id.slice(0, 8)}). 승인은 그 세션에서 진행합니다.`);
						}
						// Hidden planning brief: the transcript only shows the user's own /fanout line.
						pi.sendMessage({ customType: "cloud-fanout-plan", content: PLAN_INSTRUCTIONS(goal), display: false, details: { goal } },
							ctx.isIdle() ? { triggerTurn: true } : { deliverAs: "followUp", triggerTurn: true });
						return;
					}
				}
			} catch (e: any) { say(`fanout: ${e.message}`, "error"); }
		},
	});

	// ---------------------------------------------------------------- tools for the model
	pi.registerTool({
		name: "cloud_fanout_launch",
		label: "Cloud fan-out: launch",
		description: "Start several Cursor Cloud Agents in parallel, one per task, and track them in the background. The user sees the plan as a table and approves, edits or cancels it. Returns immediately with agent ids; the batch report arrives in a later turn.",
		promptSnippet: "Fan out independent coding tasks to Cursor Cloud Agents running in parallel",
		promptGuidelines: [
			"Use cloud_fanout_launch only for independent tasks that can run in parallel in the cloud; give each task a short unique label and a self-contained prompt.",
			"After cloud_fanout_launch, do not poll in a loop; check cloud_fanout_status only when the user asks, and the report arrives automatically when the batch finishes.",
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
			const r = await launch(ctx, { batch: params.batch || newBatch(params.title), title: params.title, agents: params.tasks }, signal);
			const created = (r.created || []).map((c: any) => `${c.phase} ${c.label} ${short(c.agentId)}`).join("\n");
			const text = r.message === "cancelled"
				? "The user cancelled the fan-out plan. Ask what to change, or stop."
				: `${r.message}\n${created}\n${r.message.startsWith("queued") ? "Work has not launched yet. Approval and full reports belong to the dedicated session." : "The batch report will arrive in a later turn; do not poll."}`;
			return { content: [{ type: "text", text: text.trim() }], details: { batch: r.spec.batch, created: r.created } };
		},
	});

	pi.registerTool({
		name: "cloud_fanout_status",
		label: "Cloud fan-out: status",
		description: "Show the raw status and summary of tracked Cursor Cloud Agents (local registry, no API calls).",
		promptSnippet: "Check the status of fanned-out Cursor Cloud Agents",
		parameters: Type.Object({}),
		async execute(_id, _p, signal, _u, ctx) {
			const r = await T(ctx, ["status"], signal);
			return { content: [{ type: "text", text: truncateHead(r.out || r.err, { maxLines: 200, maxBytes: 20_000 }).content }], details: undefined };
		},
	});

	pi.registerTool({
		name: "cloud_fanout_report",
		label: "Cloud fan-out: report",
		description: "Aggregate summaries, pull requests and token totals of fanned-out Cursor Cloud Agents.",
		parameters: Type.Object({ batch: Type.Optional(Type.String()) }),
		async execute(_id, p, signal, _u, ctx) {
			const r = await T(ctx, ["report", ...(p.batch ? ["--batch", p.batch] : [])], signal);
			return { content: [{ type: "text", text: truncateHead(r.out || r.err, { maxLines: 400, maxBytes: 30_000 }).content }], details: undefined };
		},
	});

	pi.registerTool({
		name: "cloud_fanout_diff",
		label: "Cloud fan-out: changes",
		description: "File tree with added/modified/deleted files of a cloud agent's pushed branch, read from GitHub via gh. Read-only.",
		parameters: Type.Object({ label: Type.String({ description: "Agent label or id" }) }),
		async execute(_id, p, signal, _u, ctx) {
			const r = await T(ctx, ["tree", p.label], signal);
			return { content: [{ type: "text", text: truncateHead(r.out || r.err, { maxLines: 300, maxBytes: 20_000 }).content }], details: undefined };
		},
	});

	pi.registerTool({
		name: "cloud_fanout_followup",
		label: "Cloud fan-out: follow-up",
		description: "Send a follow-up instruction to a tracked Cursor Cloud Agent (new run), or steer its running turn. Requires the user's approval in the UI.",
		parameters: Type.Object({
			label: Type.String(), prompt: Type.String(),
			steer: Type.Optional(Type.Boolean({ description: "Deliver into the running turn instead of starting a new run" })),
		}),
		async execute(_id, p, signal, _u, ctx) {
			if (!ctx.hasUI) throw new Error("needs approval: run /fanout followup interactively");
			if (!(await ctx.ui.confirm(`${p.steer ? "Steer" : "Follow up"} ${p.label}?`, p.prompt))) return { content: [{ type: "text", text: "cancelled by user" }], details: undefined };
			const r = await T(ctx, ["followup", p.label, "--prompt", p.prompt, "--yes", ...(p.steer ? ["--steer"] : [])], signal);
			ensureDaemon(ctx);
			if (!r.ok) throw new Error(r.err || r.out);
			return { content: [{ type: "text", text: r.out }], details: undefined };
		},
	});
}
