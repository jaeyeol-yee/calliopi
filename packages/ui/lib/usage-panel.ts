// /cl-usage panel pieces that need no Pi: the frame and the argument parser.
import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
import { PROVIDER_IDS, type ProviderId } from '@calliopi/core/usage';

export interface PanelPaint { border(s: string): string; title(s: string): string }
export const PLAIN_PANEL: PanelPaint = { border: (s) => s, title: (s) => s };

/** `/cl-usage claude cursor` → those providers; unknown names are reported. */
export function parseArgs(args: string): { ids: ProviderId[]; unknown: string[] } {
  const words = args.trim().split(/\s+/).filter(Boolean);
  const ids = PROVIDER_IDS.filter((id) => words.includes(id));
  return { ids, unknown: words.filter((w) => !PROVIDER_IDS.includes(w as ProviderId)) };
}

/** The panel: a frame around the gauges, with the refresh time and key hints in the bottom edge. */
export function panelLines(body: string[], width: number, footer: string, paint: PanelPaint = PLAIN_PANEL): string[] {
  const border = paint.border;
  const inner = Math.max(10, width - 4);
  const edge = (left: string, text: string, right: string) => {
    const label = text ? ` ${text} ` : '';
    return border(left + '─') + label + border('─'.repeat(Math.max(0, width - 3 - visibleWidth(label))) + right);
  };
  return [
    edge('╭', paint.title('사용량'), '╮'),
    ...body.map((line) => {
      const fitted = truncateToWidth(line, inner);
      return `${border('│')} ${fitted}${' '.repeat(Math.max(0, inner - visibleWidth(fitted)))} ${border('│')}`;
    }),
    edge('╰', footer, '╯'),
  ];
}
