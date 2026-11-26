// /cl-agents: the subagents of this session in a floating window. The list is the tree with each
// agent's state; Enter shows an agent's real Pi screen (its pseudo-terminal, lib/fleet.ts) and passes
// keys to it, so the user can watch it think and step in. Ctrl+] goes back to the list; the child
// keeps running. An agent that has ended shows its last screen, or its result when this Pi did not
// run it (an earlier session).
import { CURSOR_MARKER, matchesKey, renderFakeCursor, truncateToWidth, visibleWidth, type Component, type Focusable } from '@earendil-works/pi-tui';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { MARK, STATUS_TEXT, buildTree, formatBudget, stateOf, treeCounts, treeRows, type AgentRecord } from '@calliopi/core/agents';
import type { Fleet } from '#lib/fleet.ts';
import { agentLine } from '#lib/parent.ts';

/** Leaves an attached screen: not a key Pi uses in its editor's common paths. */
export const DETACH_KEY = 'ctrl+]';

interface Tui { terminal: { columns: number; rows: number }; requestRender(): void }
interface Theme { fg(color: string, text: string): string; bold?(text: string): string }

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
      if (matchesKey(data, DETACH_KEY)) { this.mode = 'list'; this.tui.requestRender(); return; }
      const child = this.current() && this.fleet.get(this.current()!.meta.id);
      if (child && !child.exited) child.pane.write(data);
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
        return box(title, lines.map(l => truncateToWidth(l, inner, '', true)), live ? ` ${DETACH_KEY}: 목록 · 입력은 이 에이전트로 갑니다 ` : ` ${DETACH_KEY}: 목록 · 끝난 화면 `);
      }
      // Not run by this Pi (an earlier session): its record is all there is.
      const text = [`과제: ${r.meta.call.task}`, ...(r.meta.call.done ? [`완료: ${r.meta.call.done}`] : []), '',
        ...(r.result ? [r.result.summary || '(요약 없음)', ...(r.result.evidence ? ['', `근거: ${r.result.evidence}`] : [])] : ['(이 Pi에서 실행하지 않아 화면이 없습니다)']),
        '', `세션: ${r.meta.session}`];
      const body = wrap(text, inner).slice(0, height);
      return box(title, [...body, ...Array(height - body.length).fill('')].map(fit), ` ${DETACH_KEY}: 목록 `);
    }

    const counts = treeCounts(records);
    const title = ` 서브에이전트 · 실행 중 ${counts.running} · 끝남 ${counts.ended}${counts.problems ? ` · 문제 ${counts.problems}` : ''} `;
    if (!records.length) return box(title, [fit(this.theme.fg('dim', ' 아직 맡긴 일이 없습니다.')), ...Array(height - 1).fill(fit(''))], ' Esc: 닫기 ');
    const rows = treeRows(top).map((row, i) => {
      const r = row.node.record;
      const line = `${row.prefix}${agentLine(r)} · ${r.meta.role}`;
      return i === this.selected ? this.theme.fg('accent', `▸${line}`) : ` ${line}`;
    });
    const r = this.current()!;
    const details = [
      '', this.theme.fg('dim', '─'.repeat(inner)),
      `과제   ${r.meta.call.task}`,
      ...(r.meta.call.done ? [`완료   ${r.meta.call.done}`] : []),
      `모델   ${r.meta.model} (${r.meta.modelSource}) · 맥락 ${r.meta.call.context}${r.status?.briefing ? ` · 배경 ${r.status.briefing.how}` : ''}`,
      `예산   ${formatBudget(r.meta.call.budget, r.status ? { turns: r.status.turns, ms: (r.result?.endedAt ?? Date.now()) - r.status.startedAt, tokens: r.status.tokens, idleMs: 0 } : undefined)}`,
      ...(r.result ? [`결과   ${STATUS_TEXT[r.result.status]}${r.result.reason ? ` (${r.result.reason})` : ''} · ${r.result.summary.split('\n')[0] ?? ''}`] : []),
    ];
    const listHeight = Math.max(3, height - details.length);
    const start = Math.max(0, Math.min(this.selected - listHeight + 1, rows.length - listHeight));
    const body = [...rows.slice(start, start + listHeight), ...Array(Math.max(0, listHeight - rows.length)).fill(''), ...details].slice(0, height);
    return box(title, [...body, ...Array(height - body.length).fill('')].map(fit), ' ↑↓ 이동 · Enter: 화면 · x: 중지 · Esc: 닫기 ');
  }
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
