// Inspector overlay: task list → detail (metadata + result) → diff review (built-in or delta in a Rex pane).
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { highlightCode } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi, matchesKey } from "@earendil-works/pi-tui";
import fs from "node:fs";
import path from "node:path";
import { metadataTable, type MetadataValue } from "@calliopi/ui/table";
import { taskState, freshness, visibleByDefault } from "#lib/floating-model.ts";
import { stampArchive, archiveTime } from "#lib/archive.ts";
import { load, update as updateRegistry } from "#lib/registry.ts";
import { cleanResult } from "#lib/util.ts";
import { cfgFor, revalidate, type Agent, type Runtime } from "#extensions/runtime/state.ts";

type Exec = ExtensionAPI["exec"];
type Diff = { text: string; incomplete: boolean };

const repoSlug = (url?: string) => String(url || "").replace(/^(https?:\/\/)?github\.com\//, "").replace(/\.git$/, "");
const validRepo = (repo: string) => /^[\w.-]+\/[\w.-]+$/.test(repo);

/** Local changes against HEAD: staged + unstaged + (up to 40) untracked files. */
async function localDiff(exec: Exec, cwd: string): Promise<Diff> {
	const r = await exec("git", ["--no-pager", "diff", "--no-ext-diff", "--no-textconv", "--color=never", "HEAD", "--"], { cwd, timeout: 20_000, maxBuffer: 4_000_000 });
	const untracked = await exec("git", ["ls-files", "-z", "--others", "--exclude-standard"], { cwd, timeout: 10_000 });
	let text = `로컬 변경 · HEAD 대비 (staged + unstaged + untracked)\n\n${r.stdout || r.stderr || "추적 중인 파일의 변경이 없습니다."}`;
	const files = untracked.stdout.split("\0").filter(Boolean);
	for (const file of files.slice(0, 40)) {
		if (text.length > 1_000_000) { text += "\n⚠ 미추적 파일 diff가 1MB를 넘어 나머지는 생략했습니다."; break; }
		const patch = await exec("git", ["--no-pager", "diff", "--no-index", "--no-ext-diff", "--no-textconv", "--color=never", "--", "/dev/null", file], { cwd, timeout: 10_000, maxBuffer: 200_000 });
		text += `\n${patch.stdout || patch.stderr}`;
		if (patch.truncated || patch.killed) text += `\n⚠ ${file}: 출력 제한 또는 시간 초과로 불완전한 diff입니다.\n`;
	}
	if (files.length > 40) text += `\n⚠ 미추적 파일 ${files.length}개 중 처음 40개만 표시합니다.\n`;
	return { text, incomplete: !!(r.truncated || r.killed) };
}

/** The agent's pushed branch against the repository's default branch, via gh. */
async function branchDiff(exec: Exec, a: Agent | undefined): Promise<Diff> {
	const branch = a?.git?.branches?.[0];
	if (!a || !branch?.repoUrl || !branch?.branch) throw new Error("아직 push된 브랜치 정보가 없습니다. 읽기 전용 분석 작업에는 코드 diff가 없습니다.");
	const repo = repoSlug(branch.repoUrl);
	if (!validRepo(repo)) throw new Error("지원하지 않는 GitHub 저장소 주소입니다.");
	const base = await exec("gh", ["api", `repos/${repo}`, "--jq", ".default_branch"], { timeout: 20_000 });
	if (base.code !== 0) throw new Error(`저장소 ${repo}에 접근할 수 없습니다. 주소 또는 gh 인증 권한을 확인하세요.\n${base.stderr}`);
	// Cursor assigns a branch name before any push; metadata alone is not proof it exists.
	const pushed = await exec("gh", ["api", `repos/${repo}/branches/${encodeURIComponent(branch.branch)}`, "--silent"], { timeout: 20_000 });
	if (pushed.code !== 0) {
		if (/404|Branch not found|Not Found/i.test(pushed.stderr + pushed.stdout)) throw new Error(`리뷰할 원격 브랜치가 없습니다.\n\n작업: ${a.label}\n브랜치: ${branch.branch}\n\nCursor가 반환한 브랜치 이름은 실제 push 여부를 보장하지 않습니다. 읽기 전용 분석 작업은 코드 변경 없이 완료될 수 있습니다. 결과 요약은 Enter로 확인하세요.\n코드 변경 작업이라면 에이전트가 커밋을 push했는지 확인해야 합니다.`);
		throw new Error(`원격 브랜치 확인에 실패했습니다.\n${pushed.stderr || pushed.stdout}`);
	}
	const r = await exec("gh", ["api", `repos/${repo}/compare/${encodeURIComponent(base.stdout.trim())}...${encodeURIComponent(branch.branch)}`, "-H", "Accept: application/vnd.github.diff"], { timeout: 30_000, maxBuffer: 4_000_000 });
	if (r.code !== 0) throw new Error(r.stderr || "diff를 가져오지 못했습니다.");
	return { text: `${a.label} · ${repo}\n${base.stdout.trim()}...${branch.branch}\n\n${r.stdout || "변경사항이 없습니다."}`, incomplete: !!(r.truncated || r.killed) };
}

/** Open the diff with delta in a Rex pane to the right. */
async function openExternal(exec: Exec, ctx: ExtensionContext, review: string, label: string) {
	if (!process.env.REX_SESSION || !process.env.REX_BLOCK) throw new Error("외부 리뷰는 Rex 터미널에서만 열 수 있습니다. d 키로 내장 diff를 확인하세요.");
	const check = await exec("delta", ["--version"], { timeout: 5000 });
	if (check.code !== 0) throw new Error("delta를 실행할 수 없습니다. d 키로 내장 diff를 확인하세요.");
	const dir = path.join(cfgFor(ctx).dir, "reviews");
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	const file = path.join(dir, `review-${Date.now()}.diff`);
	fs.writeFileSync(file, review, { mode: 0o600 });
	const pane = await exec("rex", ["split", "-s", process.env.REX_SESSION, "-b", process.env.REX_BLOCK, "--split=right", "--ratio", "50", "--label", `review-${label}`, "--keep-open", "-c", ctx.cwd, "--json", "--", "sh", "-c", 'delta --paging=always < "$1"', "review", file], { timeout: 10_000 });
	if (pane.code !== 0) throw new Error(pane.stderr || "리뷰 pane을 열지 못했습니다.");
	ctx.ui.notify("외부 diff 리뷰를 열었습니다. ↑↓ / PgUp / PgDn 스크롤 · q 종료", "info");
}

function detailMetadata(rt: Runtime, a: Agent): [string, MetadataValue][] {
	const branches = a.git?.branches || [];
	const agentUrl = a.url || (/^bc-[\w-]+$/.test(a.agentId || "") ? `https://cursor.com/agents/${a.agentId}` : undefined);
	const repoLink = (b: any) => { const repo = repoSlug(b.repoUrl); return validRepo(repo) ? `https://github.com/${repo}` : undefined; };
	return [
		["작업", a.label || a.name || ""], ["목표", a.summary || ""], ["상태", `${taskState(a).text} · ${a.status || a.phase}`],
		["에이전트", { text: a.agentId || a.key || "", url: agentUrl }], ["실행", a.runId || ""], ["배치", a.batch || ""],
		["저장소", branches.flatMap((b: any, i: number) => [...(i ? ["\n"] : []), { text: b.repoUrl || "—", url: repoLink(b) }])],
		["브랜치", branches.flatMap((b: any, i: number) => [...(i ? ["\n"] : []), { text: b.branch || "—", url: repoLink(b) && b.branch ? `${repoLink(b)}/tree/${encodeURIComponent(b.branch)}` : undefined }])],
		["PR", branches.filter((b) => b.prUrl).flatMap((b, i) => [...(i ? ["\n"] : []), { text: b.prUrl || "", url: b.prUrl }, ` · ${a.reviews?.[b.prUrl || ""]?.state || "미확인"}${a.reviews?.[b.prUrl || ""]?.lastError ? ` · ${a.reviews?.[b.prUrl || ""]?.lastError}` : ""}`])],
		["갱신", `${rt.reviewing.has((a.agentId || a.key) as string) ? "갱신 중 · " : ""}${freshness(a)}`],
		["보관 시각", a.archivedRunId === a.runId && archiveTime(a.archivedAt) != null ? new Date(archiveTime(a.archivedAt)!).toLocaleString() : "미기록"],
	];
}

const canArchive = (a: Agent) => taskState(a).tab === 2 || (a.status === "FINISHED" && !(a.git?.branches || []).some((b: any) => b.prUrl));

export async function inspect(rt: Runtime, ctx: ExtensionContext, localReview = false, initialId?: string, includeArchived = false) {
	if (ctx.mode !== "tui" || rt.inspectorOpen) return;
	rt.inspectorOpen = true;
	rt.floatingHandle?.setHidden(true);
	let timer: NodeJS.Timeout | undefined;
	try {
		await ctx.ui.custom<void>((tui, theme, keys, done) => {
			let selected = 0, offset = 0, detail = localReview || !!initialId, showMetadata = true;
			let review: string | null = localReview ? "diff를 불러오는 중…" : null;
			let loading = false, closed = false;
			let contentCache: { text: string; width: number; theme: any; lines: string[]; diff: boolean } | null = null;
			let agents: Agent[] = [];
			const exec: Exec = (...args) => rt.pi.exec(...args);
			const loadDiff = async (local: boolean, external = false) => {
				if (loading) return;
				loading = true; detail = true; offset = 0; review = "diff를 불러오는 중…"; tui.requestRender();
				try {
					const d = local ? await localDiff(exec, ctx.cwd) : await branchDiff(exec, agents[selected]);
					review = d.text;
					if (d.incomplete) review += "\n\n⚠ 출력 제한 또는 시간 초과: diff가 완전하지 않습니다.";
					if (external) await openExternal(exec, ctx, review, agents[selected]?.label || "diff");
				} catch (e: any) { review = `diff를 열 수 없습니다.\n\n${e.message}`; }
				finally { loading = false; if (!closed) tui.requestRender(); }
			};
			const update = () => {
				try {
					const selectedId = agents[selected]?.agentId || agents[selected]?.key || initialId;
					const all = Object.values(load(cfgFor(ctx)).agents) as Agent[];
					// Keep an open detail stable across the 24h boundary; hide it upon returning to the list.
					agents = includeArchived ? all : all.filter(a => visibleByDefault(a) || (detail && (a.agentId || a.key) === selectedId));
					const index = agents.findIndex(a => (a.agentId || a.key) === selectedId);
					selected = index >= 0 ? index : Math.max(0, Math.min(selected, agents.length - 1));
				} catch { agents = []; }
				tui.requestRender();
			};
			update();
			if (initialId) { selected = Math.max(0, agents.findIndex(a => (a.agentId || a.key) === initialId)); void revalidate(rt, ctx, agents[selected]); }
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
						const text = review ?? (cleanResult(a.runs?.[a.runId as string]?.result) || "아직 결과가 없습니다.");
						const diff = review !== null;
						if (!contentCache || contentCache.text !== text || contentCache.width !== contentWidth || contentCache.theme !== ctx.ui.theme || contentCache.diff !== diff) {
							const lines = diff ? text.split("\n").flatMap(s => wrapTextWithAnsi(s, contentWidth)).map(s => theme.fg(s.startsWith("+") ? "success" : s.startsWith("-") ? "error" : s.startsWith("@@") ? "accent" : "text", s)) : highlightCode(text, "markdown").flatMap(s => wrapTextWithAnsi(s, contentWidth));
							contentCache = { text, width: contentWidth, theme: ctx.ui.theme, lines, diff };
						}
						const lines = diff ? contentCache.lines : [...(showMetadata ? [...metadataTable(detailMetadata(rt, a), contentWidth, theme), ""] : []), theme.fg("accent", theme.bold("결과")), "", ...contentCache.lines];
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
					const title = review !== null ? "☁ Diff 리뷰" : detail ? `☁ Fan-out · ${a?.label || "상세"}` : `☁ Fan-out ${includeArchived ? "전체 기록" : "현황"} · ${agents.length}개 작업`;
					const hint = detail ? "↑↓ / 휠 · m 표 · d diff · r 리뷰 · u 갱신 · a 보관 · Esc" : "↑↓ 선택 · Enter 상세 · d diff · r 외부 리뷰 · Esc";
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
					else if (data === "u") { void revalidate(rt, ctx, agents[selected]); return; }
					else if (data === "a" && agents[selected] && canArchive(agents[selected])) {
						const a = agents[selected];
						void updateRegistry(cfgFor(ctx), (reg) => {
							const current = reg.agents[(a.agentId || a.key) as string];
							if (current?.runId !== a.runId) return;
							if (current.status === "FINISHED" && !(current.git?.branches || []).some((b: any) => b.prUrl)) current.reviewAckRunId = current.runId;
							stampArchive(current);
						}).catch((e: any) => ctx.ui.notify(e.message, "warning"));
						return;
					}
					else if (data === "r") { void loadDiff(localReview, true); return; }
					else if (data === "d" && !localReview) { void loadDiff(false); return; }
					else if (matchesKey(data, "pageup" as Parameters<typeof matchesKey>[1])) { offset = Math.max(0, offset - 10); }
					else if (matchesKey(data, "pagedown" as Parameters<typeof matchesKey>[1])) { offset += 10; }
					else if (matchesKey(data, "home")) { offset = 0; selected = 0; }
					else if (matchesKey(data, "end")) { if (detail) offset = Number.MAX_SAFE_INTEGER; else selected = agents.length - 1; }
					else if (keys.matches(data, "tui.select.confirm")) { detail = true; offset = 0; void revalidate(rt, ctx, agents[selected]); }
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
	} finally { clearInterval(timer); rt.inspectorOpen = false; if (rt.widgetOn) rt.floatingHandle?.setHidden(false); }
}
