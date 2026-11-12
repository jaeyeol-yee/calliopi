// Inspector frame rendering, separated from the overlay's I/O so it can be tested with a plain theme.
// No Pi runtime imports: the markdown highlighter is injected (Pi's needs an initialized theme).
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { metadataTable, type MetadataValue } from "@calliopi/ui/table";
import { taskState, freshness } from "#lib/floating-model.ts";
import { archiveTime } from "#lib/archive.ts";
import { cleanResult } from "#lib/util.ts";
import type { Agent } from "#extensions/runtime/state.ts";

export type ViewTheme = { fg(color: any, text: string): string; bold(text: string): string };

export type InspectorState = {
	agents: Agent[];
	selected: number;
	offset: number;
	detail: boolean;
	/** Diff text while reviewing; null shows the list or the selected task's detail. */
	review: string | null;
	showMetadata: boolean;
	includeArchived: boolean;
	cache?: { text: string; width: number; theme: unknown; lines: string[]; diff: boolean } | null;
};

export type ViewEnv = {
	theme: ViewTheme;
	/** Terminal rows; the viewport is rows - 14, clamped to 1..16. */
	rows: number;
	highlight: (text: string) => string[];
	refreshing?: (id: string) => boolean;
	/** Identity of the active theme, used only to invalidate the wrapped-content cache. */
	themeKey?: unknown;
};

export const repoSlug = (url?: string) => String(url || "").replace(/^(https?:\/\/)?github\.com\//, "").replace(/\.git$/, "");
export const validRepo = (repo: string) => /^[\w.-]+\/[\w.-]+$/.test(repo);

export function detailMetadata(a: Agent, refreshing = false): [string, MetadataValue][] {
	const branches = a.git?.branches || [];
	const agentUrl = a.url || (/^bc-[\w-]+$/.test(a.agentId || "") ? `https://cursor.com/agents/${a.agentId}` : undefined);
	const repoLink = (b: any) => { const repo = repoSlug(b.repoUrl); return validRepo(repo) ? `https://github.com/${repo}` : undefined; };
	return [
		["작업", a.label || a.name || ""], ["목표", a.summary || ""], ["상태", `${taskState(a).text} · ${a.status || a.phase}`],
		["에이전트", { text: a.agentId || a.key || "", url: agentUrl }], ["실행", a.runId || ""], ["배치", a.batch || ""],
		["저장소", branches.flatMap((b: any, i: number) => [...(i ? ["\n"] : []), { text: b.repoUrl || "—", url: repoLink(b) }])],
		["브랜치", branches.flatMap((b: any, i: number) => [...(i ? ["\n"] : []), { text: b.branch || "—", url: repoLink(b) && b.branch ? `${repoLink(b)}/tree/${encodeURIComponent(b.branch)}` : undefined }])],
		["PR", branches.filter((b) => b.prUrl).flatMap((b, i) => [...(i ? ["\n"] : []), { text: b.prUrl || "", url: b.prUrl }, ` · ${a.reviews?.[b.prUrl || ""]?.state || "미확인"}${a.reviews?.[b.prUrl || ""]?.lastError ? ` · ${a.reviews?.[b.prUrl || ""]?.lastError}` : ""}`])],
		["갱신", `${refreshing ? "갱신 중 · " : ""}${freshness(a)}`],
		["보관 시각", a.archivedRunId === a.runId && archiveTime(a.archivedAt) != null ? new Date(archiveTime(a.archivedAt)!).toLocaleString() : "미기록"],
	];
}

export const viewportHeight = (rows: number) => Math.max(1, Math.min(16, rows - 14));

/** Render the framed overlay at width w. Clamps state.selected/offset and fills state.cache. */
export function renderInspector(state: InspectorState, w: number, env: ViewEnv): string[] {
	const { theme } = env;
	const { agents } = state;
	state.selected = Math.max(0, Math.min(state.selected, agents.length - 1));
	const a = agents[state.selected];
	// Border + two-cell horizontal padding; reserve vertical space for the frame.
	const padding = w >= 24 ? 2 : 1;
	const innerWidth = Math.max(1, w - 2 - padding * 2);
	const contentWidth = Math.max(1, innerWidth - 4); // Separate rail: │ + space + ANSI-colored triangle + space.
	const height = viewportHeight(env.rows);
	let body: string[];
	let scrollTop = 0, totalLines = 0;
	if (state.detail && (a || state.review !== null)) {
		const text = state.review ?? (cleanResult(a.runs?.[a.runId as string]?.result) || "아직 결과가 없습니다.");
		const diff = state.review !== null;
		const c = state.cache;
		if (!c || c.text !== text || c.width !== contentWidth || c.theme !== env.themeKey || c.diff !== diff) {
			const lines = diff
				? text.split("\n").flatMap(s => wrapTextWithAnsi(s, contentWidth)).map(s => theme.fg(s.startsWith("+") ? "success" : s.startsWith("-") ? "error" : s.startsWith("@@") ? "accent" : "text", s))
				: env.highlight(text).flatMap(s => wrapTextWithAnsi(s, contentWidth));
			state.cache = { text, width: contentWidth, theme: env.themeKey, lines, diff };
		}
		const content = state.cache!.lines;
		const lines = diff ? content : [
			...(state.showMetadata ? [...metadataTable(detailMetadata(a, !!env.refreshing?.((a.agentId || a.key) as string)), contentWidth, theme), ""] : []),
			theme.fg("accent", theme.bold("결과")), "", ...content,
		];
		state.offset = Math.max(0, Math.min(state.offset, lines.length - height));
		body = lines.slice(state.offset, state.offset + height);
		scrollTop = state.offset; totalLines = lines.length;
	} else {
		const start = Math.max(0, state.selected - height + 1);
		scrollTop = start; totalLines = agents.length;
		body = agents.slice(start, start + height).map((a, i) => {
			const active = start + i === state.selected;
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
	const title = state.review !== null ? "☁ Diff 리뷰" : state.detail ? `☁ Fan-out · ${a?.label || "상세"}` : `☁ Fan-out ${state.includeArchived ? "전체 기록" : "현황"} · ${agents.length}개 작업`;
	const hint = state.detail ? "↑↓ / 휠 · m 표 · d diff · r 리뷰 · u 갱신 · a 보관 · Esc" : "↑↓ 선택 · Enter 상세 · d diff · r 외부 리뷰 · Esc";
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
}
