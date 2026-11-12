import { hyperlink, truncateToWidth, visibleWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui';
import type { Theme } from '@earendil-works/pi-coding-agent';
import { plain } from '../../lib/floating-model.ts';

export type MetadataLink = { text: string; url?: string };
export type MetadataValue = string | MetadataLink | (string | MetadataLink)[];

function valueText(value: MetadataValue, theme: Theme) {
  return (Array.isArray(value) ? value : [value]).map(part => {
    if (typeof part === 'string') return part.split('\n').map(plain).join('\n');
    const text = plain(part.text);
    try {
      const url = new URL(part.url || '');
      if (url.protocol === 'https:' && ['github.com', 'cursor.com', 'www.cursor.com'].includes(url.hostname) && !url.username && !url.password && !/[\x00-\x20\x7f]/.test(part.url || '')) {
        return theme.fg('accent', hyperlink(text, url.href));
      }
    } catch { /* Invalid or unsupported links stay readable text. */ }
    return text;
  }).join('') || '—';
}

/** Width-aware table with row separators. Only explicitly supplied safe links emit OSC 8. */
export function metadataTable(rows: [string, MetadataValue][], width: number, theme: Theme): string[] {
  if (width < 24) return rows.flatMap(([key, value]) => valueText(value, theme).split('\n').flatMap((line, i) => wrapTextWithAnsi(`${i ? '' : key + ': '}${line}`, Math.max(1, width))));
  const keyWidth = 8;
  const valueWidth = width - keyWidth - 7;
  const border = (s: string) => theme.fg('dim', s);
  const edge = (left: string, middle: string, right: string) => border(left + '─'.repeat(keyWidth + 2) + middle + '─'.repeat(valueWidth + 2) + right);
  const cell = (s: string, size: number) => {
    const text = truncateToWidth(s, size);
    return text + ' '.repeat(Math.max(0, size - visibleWidth(text)));
  };
  const lines = [edge('┌', '┬', '┐')];
  for (const [index, [key, value]] of rows.entries()) {
    if (index) lines.push(edge('├', '┼', '┤'));
    const wrapped = valueText(value, theme).split('\n').flatMap(s => wrapTextWithAnsi(s, valueWidth));
    for (let i = 0; i < wrapped.length; i++) {
      lines.push(border('│') + ' ' + theme.fg('dim', cell(i ? '' : key, keyWidth)) + ' ' + border('│') + ' ' + cell(wrapped[i], valueWidth) + ' ' + border('│'));
    }
  }
  lines.push(edge('└', '┴', '┘'));
  return lines;
}
