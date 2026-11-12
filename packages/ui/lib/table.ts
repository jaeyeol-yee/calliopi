// Width-aware key/value table with row separators, for floating panels.
//
//   ┌──────────┬──────────────────┐
//   │ key      │ value            │
//   ├──────────┼──────────────────┤
//   │ links    │ wrapped value …  │
//   └──────────┴──────────────────┘
//
// Values are untrusted (agent output, PR titles): control characters are replaced, and only links
// to a small allow-list of https hosts become OSC 8 hyperlinks.
import { hyperlink, truncateToWidth, visibleWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui';

export type MetadataLink = { text: string; url?: string };
export type MetadataValue = string | MetadataLink | (string | MetadataLink)[];
/** The subset of Pi's Theme the table uses. */
export interface TableTheme { fg(token: 'accent' | 'dim', text: string): string }

const LINK_HOSTS = ['github.com', 'cursor.com', 'www.cursor.com'];
const plain = (s: string | null | undefined): string => String(s || '').replace(/[\x00-\x1f\x7f-\x9f]/g, ' ');

function safeUrl(raw: string | undefined): URL | undefined {
  if (!raw || /[\x00-\x20\x7f]/.test(raw)) return undefined;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && LINK_HOSTS.includes(url.hostname) && !url.username && !url.password ? url : undefined;
  } catch { return undefined; }
}

function valueText(value: MetadataValue, theme: TableTheme) {
  return (Array.isArray(value) ? value : [value]).map((part) => {
    if (typeof part === 'string') return part.split('\n').map(plain).join('\n');
    const text = plain(part.text);
    const url = safeUrl(part.url);
    return url ? theme.fg('accent', hyperlink(text, url.href)) : text;
  }).join('') || '—';
}

/** Render rows as a bordered table `width` cells wide (a plain `key: value` list below 24). */
export function metadataTable(rows: [string, MetadataValue][], width: number, theme: TableTheme): string[] {
  if (width < 24) return rows.flatMap(([key, value]) => valueText(value, theme).split('\n').flatMap((line, i) => wrapTextWithAnsi(`${i ? '' : `${key}: `}${line}`, Math.max(1, width))));
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
    const wrapped = valueText(value, theme).split('\n').flatMap((s) => wrapTextWithAnsi(s, valueWidth));
    for (let i = 0; i < wrapped.length; i++) {
      lines.push(`${border('│')} ${theme.fg('dim', cell(i ? '' : plain(key), keyWidth))} ${border('│')} ${cell(wrapped[i], valueWidth)} ${border('│')}`);
    }
  }
  lines.push(edge('└', '┴', '┘'));
  return lines;
}
