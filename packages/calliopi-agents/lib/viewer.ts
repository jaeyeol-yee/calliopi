// /cl-agents: the subagents of this session in a floating window, grouped by the goal they work for
// (the open goal first and expanded, closed goals folded, then those without a goal). A goal row
// shows the goal on the right and folds with Enter; e exports it. On an agent, Enter shows an agent's real Pi screen (its pseudo-terminal, lib/fleet.ts) and passes
// keys to it, so the user can watch it think and step in. Ctrl+] goes back to the list; the child
// keeps running. An agent that has ended shows its last screen, or its result when this Pi did not
// run it (an earlier session).
import { CURSOR_MARKER, matchesKey, renderFakeCursor, truncateToWidth, visibleWidth, type Component, type Focusable, type TuiMouseEvent, type TuiMouseEventResult } from '@earendil-works/pi-tui';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { MARK, OPEN, STATUS_TEXT, buildTree, formatBudget, goalAgentTokens, stateOf, treeCounts, treeRows, type AgentRecord, type Goal } from '@calliopi/core/agents';
import { metadataTable, type MetadataValue } from '@calliopi/ui/table';
import type { Fleet } from '#lib/fleet.ts';
import { agentLine } from '#lib/parent.ts';

/** Leaves an attached screen: not a key Pi uses in its editor's common paths. */
export const DETACH_KEY = 'ctrl+]';

/**
 * How far a key scrolls a text view of `page` lines, or 0 when it is not a scroll key. On a live
 * screen only Shift+PgUp/PgDn and Shift+↑↓ (keys Pi does not bind), so the agent gets the rest.
 */
export function scrollStep(data: string, page: number, keys: { live: boolean }): number {
  const half = Math.max(1, Math.floor(page / 2));
  if (matchesKey(data, 'shift+pageUp')) return -half;
  if (matchesKey(data, 'shift+pageDown')) return half;
  if (matchesKey(data, 'shift+up')) return -1;
  if (matchesKey(data, 'shift+down')) return 1;
  if (keys.live) return 0; // everything else belongs to the running agent
  if (matchesKey(data, 'pageUp')) return -half;
  if (matchesKey(data, 'pageDown')) return half;
  if (data === 'K') return -1;
  if (data === 'J') return 1;
  return 0;
}

interface Tui { terminal: { columns: number; rows: number }; requestRender(): void }
interface Theme { fg(color: string, text: string): string }

/** Below this width the details go under the list instead of beside it. */
const SPLIT_MIN = 70;

/** One row of the list: a goal (null: the agents without one) or an agent under it. */
export type Item = { kind: 'goal'; goal: Goal | null; agents: AgentRecord[] } | { kind: 'agent'; record: AgentRecord; prefix: string };

const GOAL_MARK: Record<Goal['status'], string> = { active: '▶', paused: '⏸', done: '✓', abandoned: '✗' };
const GOAL_STATE: Record<Goal['status'], string> = { active: '진행 중', paused: '일시 중지', done: '완료', abandoned: '포기' };

/**
 * Whether a goal starts folded: closed goals are, except the latest one opened by itself (implicit)
 * while no goal is open, so the subagents of the request just finished stay in view.
 */
export function foldedByDefault(goal: Goal | null, goals: Goal[]): boolean {
  if (!goal || OPEN.includes(goal.status)) return false;
  if (!goal.implicit || goals.some(g => OPEN.includes(g.status))) return true;
  const latest = goals.filter(g => !OPEN.includes(g.status)).reduce<Goal | undefined>((a, g) => (!a || (g.closedAt ?? 0) > (a.closedAt ?? 0) ? g : a), undefined);
  return latest?.id !== goal.id;
}

/** The rows: goals as headers with their agents' trees, unless there are no goals at all (then the tree alone). */
export function listItems(records: AgentRecord[], goals: Goal[], folded: (key: string, closed: boolean) => boolean): Item[] {
  const tree = (rs: AgentRecord[], indent: string): Item[] => treeRows(buildTree(rs)).map(r => ({ kind: 'agent', record: r.node.record, prefix: indent + r.prefix }));
  const known = new Set(goals.map(g => g.id));
  const loose = records.filter(r => !r.meta.goal || !known.has(r.meta.goal));
  if (!goals.length) return tree(loose, '');
  const order = [...goals.filter(g => OPEN.includes(g.status)), ...goals.filter(g => !OPEN.includes(g.status)).sort((a, b) => (b.closedAt ?? 0) - (a.closedAt ?? 0))];
  const items: Item[] = [];
  for (const goal of order) {
    const agents = records.filter(r => r.meta.goal === goal.id);
    items.push({ kind: 'goal', goal, agents });
    if (!folded(goal.id, foldedByDefault(goal, goals))) items.push(...tree(agents, '  '));
  }
  if (loose.length) {
    items.push({ kind: 'goal', goal: null, agents: loose });
    if (!folded('', false)) items.push(...tree(loose, '  '));
  }
  return items;
}

export class AgentsView implements Component, Focusable {
  focused = false;
  mode: 'list' | 'screen' = 'list';
  selected = 0;
  /** Goals folded or unfolded by hand; otherwise closed goals are folded. */
  private toggled = new Map<string, boolean>();
  private items: Item[] = [];
  private notice = '';
  /** Lines scrolled down in the details (list) or the record (an agent without a screen). */
  private offset = 0;
  /** From the last render: page height, and where the right column starts (0: no split). */
  private page = 10;
  private splitAt = 0;

  private readonly tui: Tui;
  private readonly theme: Theme;
  private readonly fleet: Fleet;
  private readonly records: () => AgentRecord[];
  private readonly goals: () => Goal[];
  private readonly onExport: (goal: Goal | null) => string;
  private readonly close: () => void;

  constructor(tui: Tui, theme: Theme, fleet: Fleet, records: () => AgentRecord[], close: () => void, goals: () => Goal[] = () => [], onExport: (goal: Goal | null) => string = () => '') {
    this.tui = tui; this.theme = theme; this.fleet = fleet; this.records = records; this.close = close; this.goals = goals; this.onExport = onExport;
  }

  private current(): Item | undefined { return this.items[this.selected]; }
  private agent(): AgentRecord | undefined { const c = this.current(); return c?.kind === 'agent' ? c.record : undefined; }
  private goalOf(item: Item | undefined): Goal | null | undefined {
    if (!item) return undefined;
    if (item.kind === 'goal') return item.goal;
    return this.goals().find(g => g.id === item.record.meta.goal) ?? null;
  }

  /** Scroll whatever text the window shows: the agent's screen, its record, or the details. */
  private scroll(lines: number): void {
    const child = this.mode === 'screen' ? this.agent() && this.fleet.get(this.agent()!.meta.id) : undefined;
    if (child) child.pane.scrollBy(lines);
    else this.offset = Math.max(0, this.offset + lines); // clamped when rendered
    this.tui.requestRender();
  }

  /** Wheel (fullscreen Pi only; in regular mode the terminal keeps the wheel): scrolls what is under the pointer. */
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult {
    if (event.type !== 'wheel' || !event.wheelDelta) return {}; // only the wheel is ours
    if (this.mode === 'list' && !(this.splitAt && event.x > this.splitAt)) {
      this.select(this.selected + Math.sign(event.wheelDelta));
      this.tui.requestRender();
    } else this.scroll(event.wheelDelta);
    return { handled: true };
  }

  /** `height` lines of `lines` from the scroll offset, which is clamped to the text. */
  private window(lines: string[], height: number): string[] {
    this.offset = Math.max(0, Math.min(this.offset, lines.length - height));
    return lines.slice(this.offset, this.offset + height);
  }

  /** "first–last/total" of the visible lines. */
  private position(total: number, height: number): string {
    return `${this.offset + 1}–${Math.min(total, this.offset + height)}/${total}`;
  }

  private select(index: number): void {
    const next = Math.max(0, Math.min(Math.max(0, this.items.length - 1), index));
    if (next !== this.selected) this.offset = 0;
    this.selected = next;
  }

  handleInput(data: string): void {
    if (this.mode === 'screen') {
      const child = this.agent() && this.fleet.get(this.agent()!.meta.id);
      const live = !!child && !child.exited;
      // ctrl+] always leaves; Esc too when nothing is listening (an ended agent): a live one gets it
      if (matchesKey(data, DETACH_KEY) || (!live && (matchesKey(data, 'escape') || data === 'q'))) {
        this.mode = 'list'; this.offset = 0; child?.pane.scrollToBottom(); this.tui.requestRender(); return;
      }
      const step = scrollStep(data, this.page, { live });
      if (step) return this.scroll(step);
      if (live) child.pane.write(data);
      return;
    }
    this.notice = '';
    const item = this.current();
    const step = scrollStep(data, this.page, { live: false });
    if (matchesKey(data, 'escape') || data === 'q') return this.close();
    if (step) return this.scroll(step);
    if (matchesKey(data, 'up') || data === 'k') this.select(this.selected - 1);
    else if (matchesKey(data, 'down') || data === 'j') this.select(this.selected + 1);
    else if (matchesKey(data, 'enter') && item?.kind === 'goal') {
      const key = item.goal?.id ?? '';
      const closed = foldedByDefault(item.goal, this.goals());
      this.toggled.set(key, !(this.toggled.get(key) ?? closed));
    } else if (matchesKey(data, 'enter') && item) { this.mode = 'screen'; this.offset = 0; }
    else if (data === 'x' && this.agent()) this.fleet.stop(this.agent()!.meta.id);
    else if (data === 'e' && item) {
      try { this.notice = `내보냄: ${this.onExport(this.goalOf(item) ?? null)}`; } catch (error) { this.notice = `내보내지 못함: ${error instanceof Error ? error.message : String(error)}`; }
    }
    this.tui.requestRender();
  }

  invalidate(): void {}

  render(width: number): string[] {
    if (width < 20) return [' '.repeat(Math.max(0, width))];
    const inner = width - 2;
    const height = Math.max(8, Math.floor(this.tui.terminal.rows * 0.85) - 2);
    this.page = height;
    this.splitAt = 0;
    const border = (s: string) => this.theme.fg('border', s);
    const fit = (s: string) => truncateToWidth(s, inner, '…', true);
    const records = this.records();
    const goals = this.goals();
    this.items = listItems(records, goals, (key, closed) => this.toggled.get(key) ?? closed);
    this.selected = Math.min(this.selected, Math.max(0, this.items.length - 1));
    const box = (title: string, body: string[], footer: string) => [
      border('╭') + this.theme.fg('accent', truncateToWidth(title, inner, '…', true)) + border('╮'),
      ...body.map(line => border('│') + line + border('│')),
      border('╰') + this.theme.fg('dim', truncateToWidth(footer, inner, '', true)) + border('╯'),
    ];

    const a = this.agent();
    if (this.mode === 'screen' && a) {
      const child = this.fleet.get(a.meta.id);
      const state = stateOf(a);
      const title = ` ${MARK[state]} ${a.meta.id} · ${a.meta.role} · ${a.result ? STATUS_TEXT[a.result.status] : '실행 중'} `;
      if (child) {
        child.pane.resize(inner, height);
        const live = !child.exited;
        const lines = child.pane.lines(this.focused && live, { CURSOR_MARKER, renderFakeCursor, truncateToWidth });
        const back = child.pane.scrolledBack;
        const where = back ? ` · ↑ ${back}줄 위${live ? ' (입력하면 맨 아래로)' : ''}` : '';
        const footer = live ? ` ${DETACH_KEY}: 목록 · 입력은 이 에이전트로 갑니다 · Shift+PgUp/PgDn·Shift+↑↓: 스크롤${where} ` : ` Esc·${DETACH_KEY}: 목록 · 끝난 화면 · PgUp/PgDn·J/K: 스크롤${where} `;
        return box(title, lines.map(l => truncateToWidth(l, inner, '', true)), footer);
      }
      // Not run by this Pi (an earlier session, or its goal closed): its record is all there is.
      const text = [`과제: ${a.meta.call.task}`, ...(a.meta.call.done ? [`완료: ${a.meta.call.done}`] : []), '',
        ...(a.result ? [a.result.summary || '(요약 없음)', ...(a.result.evidence ? ['', `근거: ${a.result.evidence}`] : [])] : ['(화면이 없습니다)']),
        '', `세션: ${a.meta.session}`];
      const all = wrap(text, inner);
      const body = this.window(all, height);
      return box(title, [...body, ...Array(height - body.length).fill('')].map(fit), ` Esc·${DETACH_KEY}: 목록${all.length > height ? ` · PgUp/PgDn·J/K: 스크롤 ${this.position(all.length, height)}` : ''} `);
    }

    const counts = treeCounts(records);
    const title = ` 서브에이전트 · 실행 중 ${counts.running} · 끝남 ${counts.ended}${counts.problems ? ` · 문제 ${counts.problems}` : ''} `;
    const footerFor = (total: number, h: number) => this.notice ? ` ${this.notice} `
      : ` ↑↓ 이동 · Enter: 화면/접기${total > h ? ` · PgUp/PgDn·J/K: 상세 ${this.position(total, h)}` : ''} · x: 중지 · e: 내보내기 · Esc: 닫기 `;
    if (!this.items.length) return box(title, [fit(this.theme.fg('dim', ' 아직 맡긴 일이 없습니다.')), ...Array(height - 1).fill(fit(''))], ' Esc: 닫기 ');
    const rows = this.items.map((item, i) => {
      const line = item.kind === 'agent' ? `${item.prefix}${agentLine(item.record)}` : goalLine(item, this.toggled.get(item.goal?.id ?? '') ?? foldedByDefault(item.goal, goals));
      return i === this.selected ? this.theme.fg('accent', `▸${line}`) : ` ${line}`;
    });
    /** The list, scrolled so the selected row is in view. */
    const list = (h: number) => {
      const start = Math.max(0, Math.min(this.selected - h + 1, rows.length - h));
      return [...rows.slice(start, start + h), ...Array(Math.max(0, h - rows.length)).fill('')];
    };
    const item = this.current()!;
    const detail = item.kind === 'agent' ? detailRows(item.record) : goalRows(item, records);
    const table = (w: number) => metadataTable(detail, w, { fg: (token, text) => this.theme.fg(token, text) });
    const pad = (line: string, w: number) => truncateToWidth(line, w, '…', true);

    if (inner < SPLIT_MIN) { // narrow: the details under the list
      const listHeight = Math.min(rows.length, Math.max(3, Math.floor(height / 3)));
      const details = table(inner);
      const body = [...list(listHeight), ...this.window(details, height - listHeight)];
      return box(title, [...body, ...Array(height - body.length).fill('')].map(fit), footerFor(details.length, height - listHeight));
    }
    // wide: the list on the left, the selected goal or agent in a table on the right
    const leftCols = Math.max(28, Math.floor((inner - 1) * 0.42));
    const rightCols = inner - 1 - leftCols;
    const details = table(rightCols);
    const right = this.window(details, height);
    const left = list(height);
    this.splitAt = leftCols + 1;
    const footer = footerFor(details.length, height);
    const label = (text: string, cols: number, color: string) => this.theme.fg(color, truncateToWidth(text, cols, '…', true));
    const heading = item.kind === 'agent' ? ` ${item.record.meta.id} ` : item.goal ? ` goal ${item.goal.id} ` : ' goal 없음 ';
    return [
      border('╭') + label(title, leftCols, 'accent') + border('┬') + label(heading, rightCols, 'dim') + border('╮'),
      ...Array.from({ length: height }, (_, i) => border('│') + pad(left[i] ?? '', leftCols) + border('│') + pad(right[i] ?? '', rightCols) + border('│')),
      border('╰') + this.theme.fg('dim', truncateToWidth(footer, inner, '', true)) + border('╯'),
    ];
  }
}

/** A goal header row: its mark, objective, state and how many agents (running among them). */
function goalLine(item: Extract<Item, { kind: 'goal' }>, folded: boolean): string {
  const running = item.agents.filter(r => !r.result).length;
  const count = `${item.agents.length}${running ? ` · 실행 ${running}` : ''}`;
  if (!item.goal) return `${folded ? '▸' : '▾'} · goal 없음 (${count})`;
  const state = item.goal.implicit ? (item.goal.status === 'done' ? '자동 · 끝남' : '자동') : GOAL_STATE[item.goal.status];
  return `${folded ? '▸' : '▾'} ${item.goal.implicit ? '◇' : GOAL_MARK[item.goal.status]} ${item.goal.objective} · ${state} (${count})`;
}

/** The selected goal as table rows. */
function goalRows(item: Extract<Item, { kind: 'goal' }>, records: AgentRecord[]): [string, MetadataValue][] {
  const g = item.goal;
  const running = item.agents.filter(r => !r.result).length;
  if (!g) return [['goal', '없음: goal이 열려 있지 않을 때 맡긴 일'], ['에이전트', `${item.agents.length}개${running ? ` · 실행 중 ${running}` : ''}`]];
  const when = (t: number) => new Date(t).toLocaleString();
  return [
    ['상태', `${GOAL_MARK[g.status]} ${GOAL_STATE[g.status]}${g.pausedBecause ? ` (${g.pausedBecause})` : ''}${g.implicit ? ' · 자동: 서브에이전트가 필요한 요청에서 열림, 모두 끝나면 닫힘' : ''}`],
    ['목표', g.objective],
    ...(g.done ? [['완료', g.done] as [string, MetadataValue]] : []),
    ...(g.progress ? [['진척', g.progress] as [string, MetadataValue]] : []),
    ['사용', `턴 ${g.usage.turns} · 토큰 ${g.usage.tokens + goalAgentTokens(g, records)} (에이전트 포함) · 자동 계속 ${g.continuations}회${g.budget ? ` · 예산 ${[g.budget.turns ? `턴 ${g.budget.turns}` : '', g.budget.tokens ? `토큰 ${g.budget.tokens}` : ''].filter(Boolean).join(' ')}` : ''}`],
    ['에이전트', `${item.agents.length}개${running ? ` · 실행 중 ${running}` : ''}`],
    ...(g.outcome ? [['결과', g.outcome] as [string, MetadataValue]] : []),
    ['시각', `${when(g.createdAt)}${g.closedAt ? ` → ${when(g.closedAt)}` : ''}`],
  ];
}

/** The selected agent's contract, run and result, as table rows. */
function detailRows(r: AgentRecord): [string, MetadataValue][] {
  const state = stateOf(r);
  const now = r.result?.endedAt ?? Date.now();
  const usage = r.status ? { turns: r.status.turns, ms: now - r.status.startedAt, tokens: r.status.tokens, idleMs: 0 } : undefined;
  return [
    ['상태', `${MARK[state]} ${r.result ? STATUS_TEXT[r.result.status] : state === 'starting' ? '시작 중' : `실행 중${r.status?.activity ? ` · ${r.status.activity}` : ''}`}${r.result?.reason ? ` (${r.result.reason})` : ''}`],
    ['역할', `${r.meta.role} · 깊이 ${r.meta.depth}${r.meta.parent ? ` · 부모 ${r.meta.parent}` : ''}`],
    ['과제', r.meta.call.task],
    ...(r.meta.call.done ? [['완료', r.meta.call.done] as [string, MetadataValue]] : []),
    ['모델', `${r.meta.model} (${r.meta.modelSource})${r.meta.thinking ? ` · thinking ${r.meta.thinking}` : ''}`],
    ['맥락', `${r.meta.call.context}${r.status?.briefing ? ` · 배경 ${r.status.briefing.how}` : ''} · ${r.meta.call.background ? 'background' : 'foreground'}`],
    ['예산', formatBudget(r.meta.call.budget, usage)],
    ...(r.result ? [['결과', r.result.summary || '(요약 없음)'] as [string, MetadataValue]] : []),
    ...(r.result?.evidence ? [['근거', r.result.evidence] as [string, MetadataValue]] : []),
    ['세션', r.meta.session],
  ];
}

/** Lines cut to `width` cells, wide characters counted. */
function wrap(lines: string[], width: number): string[] {
  const out: string[] = [];
  for (const line of lines) {
    let rest = line;
    if (!rest) { out.push(''); continue; }
    while (rest) {
      let cut = rest.length;
      while (visibleWidth(rest.slice(0, cut)) > width) cut--;
      out.push(rest.slice(0, Math.max(1, cut)));
      rest = rest.slice(Math.max(1, cut));
    }
  }
  return out;
}

/** Open the window; resolves when it closes. */
export async function openAgentsView(ctx: ExtensionContext, fleet: Fleet, records: () => AgentRecord[], goals: () => Goal[] = () => [], onExport: (goal: Goal | null) => string = () => ''): Promise<void> {
  let unsubscribe: (() => void) | undefined;
  let timer: NodeJS.Timeout | undefined;
  try {
    await ctx.ui.custom<void>((tui, theme, _keys, done) => {
      const view = new AgentsView(tui, theme, fleet, records, () => done(), goals, onExport);
      fleet.onRender = () => tui.requestRender();
      timer = setInterval(() => tui.requestRender(), 500); // status files change outside any render
      // Keys belong to the window (and, on a screen, to the agent) before Pi's own shortcuts.
      unsubscribe = ctx.ui.onTerminalInput(data => {
        if (!view.focused) return;
        view.handleInput(data);
        return { consume: true };
      });
      return view;
    }, { overlay: true, overlayOptions: { anchor: 'center', width: '90%', maxHeight: '85%', margin: 1 } });
  } finally {
    unsubscribe?.();
    clearInterval(timer);
    fleet.onRender = () => {};
  }
}
