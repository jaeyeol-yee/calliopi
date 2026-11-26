// /cl-agents: the subagents of this session in a floating window. The list is the tree with each
// agent's state; Enter shows an agent's real Pi screen (its pseudo-terminal, lib/fleet.ts) and passes
// keys to it, so the user can watch it think and step in. Ctrl+] goes back to the list; the child
// keeps running. An agent that has ended shows its last screen, or its result when this Pi did not
// run it (an earlier session).
import { CURSOR_MARKER, matchesKey, renderFakeCursor, truncateToWidth, visibleWidth, type Component, type Focusable } from '@earendil-works/pi-tui';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { MARK, STATUS_TEXT, buildTree, formatBudget, stateOf, treeCounts, treeRows, type AgentRecord } from '@calliopi/core/agents';
import { metadataTable, type MetadataValue } from '@calliopi/ui/table';
import type { Fleet } from '#lib/fleet.ts';
import { agentLine } from '#lib/parent.ts';

/** Leaves an attached screen: not a key Pi uses in its editor's common paths. */
export const DETACH_KEY = 'ctrl+]';

interface Tui { terminal: { columns: number; rows: number }; requestRender(): void }
interface Theme { fg(color: string, text: string): string }

/** Below this width the details go under the list instead of beside it. */
const SPLIT_MIN = 70;

export class AgentsView implements Component, Focusable {
  focused = false;
  mode: 'list' | 'screen' = 'list';
  selected = 0;
  private rowsCache: AgentRecord[] = [];

  private readonly tui: Tui;
  private readonly theme: Theme;
  private readonly fleet: Fleet;
  private readonly records: () => AgentRecord[];
  private readonly close: () => void;

  constructor(tui: Tui, theme: Theme, fleet: Fleet, records: () => AgentRecord[], close: () => void) {
    this.tui = tui; this.theme = theme; this.fleet = fleet; this.records = records; this.close = close;
  }

  private current(): AgentRecord | undefined { return this.rowsCache[this.selected]; }

  handleInput(data: string): void {
    if (this.mode === 'screen') {
      const child = this.current() && this.fleet.get(this.current()!.meta.id);
      const live = !!child && !child.exited;
      // ctrl+] always leaves; Esc too when nothing is listening (an ended agent): a live one gets it
      if (matchesKey(data, DETACH_KEY) || (!live && (matchesKey(data, 'escape') || data === 'q'))) { this.mode = 'list'; this.tui.requestRender(); return; }
      if (live) child.pane.write(data);
      return;
    }
    if (matchesKey(data, 'escape') || data === 'q') return this.close();
    if (matchesKey(data, 'up') || data === 'k') this.selected = Math.max(0, this.selected - 1);
    else if (matchesKey(data, 'down') || data === 'j') this.selected = Math.min(Math.max(0, this.rowsCache.length - 1), this.selected + 1);
    else if (matchesKey(data, 'enter') && this.current()) this.mode = 'screen';
    else if (data === 'x' && this.current()) this.fleet.stop(this.current()!.meta.id);
    this.tui.requestRender();
  }

  invalidate(): void {}

  render(width: number): string[] {
    if (width < 20) return [' '.repeat(Math.max(0, width))];
    const inner = width - 2;
    const height = Math.max(8, Math.floor(this.tui.terminal.rows * 0.85) - 2);
    const border = (s: string) => this.theme.fg('border', s);
    const fit = (s: string) => truncateToWidth(s, inner, '…', true);
    const records = this.records();
    const top = buildTree(records);
    this.rowsCache = treeRows(top).map(r => r.node.record);
    this.selected = Math.min(this.selected, Math.max(0, this.rowsCache.length - 1));
    const box = (title: string, body: string[], footer: string) => [
      border('╭') + this.theme.fg('accent', truncateToWidth(title, inner, '…', true)) + border('╮'),
      ...body.map(line => border('│') + line + border('│')),
      border('╰') + this.theme.fg('dim', truncateToWidth(footer, inner, '', true)) + border('╯'),
    ];

    if (this.mode === 'screen' && this.current()) {
      const r = this.current()!;
      const child = this.fleet.get(r.meta.id);
      const state = stateOf(r);
      const title = ` ${MARK[state]} ${r.meta.id} · ${r.meta.role} · ${r.result ? STATUS_TEXT[r.result.status] : '실행 중'} `;
      if (child) {
        child.pane.resize(inner, height);
        const live = !child.exited;
        const lines = child.pane.lines(this.focused && live, { CURSOR_MARKER, renderFakeCursor, truncateToWidth });
        return box(title, lines.map(l => truncateToWidth(l, inner, '', true)), live ? ` ${DETACH_KEY}: 목록 · 입력은 이 에이전트로 갑니다 ` : ` Esc·${DETACH_KEY}: 목록 · 끝난 화면 `);
      }
      // Not run by this Pi (an earlier session): its record is all there is.
      const text = [`과제: ${r.meta.call.task}`, ...(r.meta.call.done ? [`완료: ${r.meta.call.done}`] : []), '',
        ...(r.result ? [r.result.summary || '(요약 없음)', ...(r.result.evidence ? ['', `근거: ${r.result.evidence}`] : [])] : ['(이 Pi에서 실행하지 않아 화면이 없습니다)']),
        '', `세션: ${r.meta.session}`];
      const body = wrap(text, inner).slice(0, height);
      return box(title, [...body, ...Array(height - body.length).fill('')].map(fit), ` Esc·${DETACH_KEY}: 목록 `);
    }

    const counts = treeCounts(records);
    const title = ` 서브에이전트 · 실행 중 ${counts.running} · 끝남 ${counts.ended}${counts.problems ? ` · 문제 ${counts.problems}` : ''} `;
    const footer = ' ↑↓ 이동 · Enter: 화면 · x: 중지 · Esc: 닫기 ';
    if (!records.length) return box(title, [fit(this.theme.fg('dim', ' 아직 맡긴 일이 없습니다.')), ...Array(height - 1).fill(fit(''))], ' Esc: 닫기 ');
    const rows = treeRows(top).map((row, i) => {
      const line = `${row.prefix}${agentLine(row.node.record)}`;
      return i === this.selected ? this.theme.fg('accent', `▸${line}`) : ` ${line}`;
    });
    /** The list, scrolled so the selected row is in view. */
    const list = (h: number) => {
      const start = Math.max(0, Math.min(this.selected - h + 1, rows.length - h));
      return [...rows.slice(start, start + h), ...Array(Math.max(0, h - rows.length)).fill('')];
    };
    const r = this.current()!;
    const table = (w: number) => metadataTable(detailRows(r), w, { fg: (token, text) => this.theme.fg(token, text) });
    const pad = (line: string, w: number) => truncateToWidth(line, w, '…', true);

    if (inner < SPLIT_MIN) { // narrow: the details under the list
      const listHeight = Math.min(rows.length, Math.max(3, Math.floor(height / 3)));
      const body = [...list(listHeight), ...table(inner)].slice(0, height);
      return box(title, [...body, ...Array(height - body.length).fill('')].map(fit), footer);
    }
    // wide: the list on the left, the details of the selected agent in a table on the right
    const leftCols = Math.max(28, Math.floor((inner - 1) * 0.42));
    const rightCols = inner - 1 - leftCols;
    const details = table(rightCols);
    const right = details.length > height ? [...details.slice(0, height - 1), this.theme.fg('dim', '…')] : details;
    const left = list(height);
    const label = (text: string, cols: number, color: string) => this.theme.fg(color, truncateToWidth(text, cols, '…', true));
    return [
      border('╭') + label(title, leftCols, 'accent') + border('┬') + label(` ${r.meta.id} `, rightCols, 'dim') + border('╮'),
      ...Array.from({ length: height }, (_, i) => border('│') + pad(left[i] ?? '', leftCols) + border('│') + pad(right[i] ?? '', rightCols) + border('│')),
      border('╰') + this.theme.fg('dim', truncateToWidth(footer, inner, '', true)) + border('╯'),
    ];
  }
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
export async function openAgentsView(ctx: ExtensionContext, fleet: Fleet, records: () => AgentRecord[]): Promise<void> {
  let unsubscribe: (() => void) | undefined;
  let timer: NodeJS.Timeout | undefined;
  try {
    await ctx.ui.custom<void>((tui, theme, _keys, done) => {
      const view = new AgentsView(tui, theme, fleet, records, () => done());
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
