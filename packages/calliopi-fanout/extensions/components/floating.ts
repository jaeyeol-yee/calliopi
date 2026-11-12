import { truncateToWidth, visibleWidth, matchesKey } from '@earendil-works/pi-tui';
import type { Theme, ThemeColor } from '@earendil-works/pi-coding-agent';
import { TABS, taskState, freshness, plain, defaultTasks } from '#lib/floating-model.ts';
import type { AgentView } from '#lib/types.ts';

// No timers or I/O: all state comes from the local registry subscription.
export function floatingList({ agents, theme, render, open, unfocus }: {
  agents: () => AgentView[]; theme: () => Theme; render: () => void;
  open: (id: string) => void; unfocus: () => void;
}) {
  let tab = 0, selected = 0, start = 0, tabWidth = 10;
  let visible: AgentView[] = [];
  return {
    render(width: number) {
      const t = theme();
      const all = defaultTasks(agents());
      visible = all.filter(a => taskState(a).tab === tab);
      selected = Math.max(0, Math.min(selected, visible.length - 1));
      start = Math.max(0, Math.min(start, Math.max(0, visible.length - 5)));
      if (selected < start) start = selected;
      if (selected >= start + 5) start = selected - 4;
      const inner = Math.max(1, width - 4);
      const contentWidth = Math.max(1, inner - 4);
      tabWidth = Math.max(1, Math.floor(inner / 3));
      const border = (s: string) => t.fg('dim', s);
      const row = (s = '') => {
        const v = truncateToWidth(s, inner);
        return t.bg('customMessageBg', border('│') + ' ' + v + ' '.repeat(Math.max(0, inner - visibleWidth(v))) + ' ' + border('│'));
      };
      const tabs = TABS.map((name, i) => {
        const text = truncateToWidth(`${name} ${all.filter(a => taskState(a).tab === i).length}`, tabWidth);
        return (tab === i ? t.fg('accent', t.bold(text)) : t.fg('dim', text)) + ' '.repeat(Math.max(0, tabWidth - visibleWidth(text)));
      }).join('');
      const content = visible.slice(start, start + 5).map((a, i) => {
        const state = taskState(a);
        return t.fg(state.color as ThemeColor, `${start + i === selected ? '›' : ' '} ${state.icon} ${plain(a.label || a.name)} · ${state.text}`);
      });
      if (!content.length) content.push(t.fg('dim', tab === 0 ? '진행 중인 작업이 없습니다.' : '작업이 없습니다.'));
      const rows = Array.from({ length: 5 }, (_, i) => {
        const text = truncateToWidth(content[i] || '', contentWidth);
        const glyph = i === 0 && start > 0 ? '▲' : i === 4 && start + 5 < visible.length ? '▼' : ' ';
        return row(text + ' '.repeat(Math.max(0, contentWidth - visibleWidth(text))) + t.fg('dim', '│') + ' ' + t.fg('accent', t.bold(glyph)) + ' ');
      });
      return [
        border('╭' + '─'.repeat(Math.max(0, width - 2)) + '╮'),
        row(t.bold('팬아웃')), row(tabs), row(), ...rows, row(),
        row(t.fg('dim', `${visible.length ? `${start + 1}–${Math.min(start + 5, visible.length)} / ${visible.length}` : '0개'}  ·  ${tab === 0 ? '휠 스크롤 · 행 클릭' : visible[selected]?.git?.branches?.some((b) => b.prUrl) ? freshness(visible[selected]) : tab === 1 ? '결과 확인 대기' : '확인/보관'}`)),
        border('╰' + '─'.repeat(Math.max(0, width - 2)) + '╯'),
      ];
    },
    handleMouse(event: { type: string; button?: string; y: number; x: number; wheelDelta?: number }) {
      if (event.type === 'wheel') {
        selected = Math.max(0, Math.min(visible.length - 1, selected + (event.wheelDelta || 0)));
        render(); return { handled: true };
      }
      if (event.type !== 'click' || event.button !== 'left') return;
      if (event.y === 2) { tab = Math.min(2, Math.max(0, Math.floor((event.x - 2) / tabWidth))); selected = start = 0; }
      else if (event.y >= 4 && event.y < 9) {
        const a = visible[start + event.y - 4];
        if (a) { selected = start + event.y - 4; open((a.agentId || a.key) as string); }
      }
      render(); return { handled: true };
    },
    handleInput(data: string) {
      if (matchesKey(data, 'escape')) { unfocus(); return; }
      if (matchesKey(data, 'left') || matchesKey(data, 'right')) { tab = (tab + (matchesKey(data, 'right') ? 1 : 2)) % 3; selected = start = 0; }
      else if (matchesKey(data, 'up')) selected = Math.max(0, selected - 1);
      else if (matchesKey(data, 'down')) selected = Math.min(visible.length - 1, selected + 1);
      else if (matchesKey(data, 'pageup' as Parameters<typeof matchesKey>[1])) selected = Math.max(0, selected - 5);
      else if (matchesKey(data, 'pagedown' as Parameters<typeof matchesKey>[1])) selected = Math.min(visible.length - 1, selected + 5);
      else if (matchesKey(data, 'enter') && visible[selected]) { const a = visible[selected]; open((a.agentId || a.key) as string); }
      render();
    },
    invalidate() {},
  };
}
