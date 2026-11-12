// Turn headers: a header block before each user message and before the first assistant text that
// answers it. Display-only (Markdown transformer): stored messages and model context are unchanged.
import { visibleWidth } from '@earendil-works/pi-tui';

export type HeaderStyle = 'full' | 'compact' | 'off';

export interface TurnHeaderConfig {
  style: HeaderStyle;
  userIcon: string;
  userLabel: string;
  assistantIcon: string;
  assistantLabel: string;
}

// Non-emoji glyphs only (no Emoji property), so terminals never swap in colour emoji.
export const DEFAULT_CONFIG: TurnHeaderConfig = {
  style: 'full', userIcon: '◉', userLabel: '사용자', assistantIcon: '⛭', assistantLabel: 'Pi',
};

/** Keep labels/icons single-line and free of Markdown syntax that could restructure the header. */
const plain = (s: string): string => s.replace(/[\x00-\x1f\x7f]/g, ' ').replace(/([\\`*_[\]#<>|~])/g, '\\$1').trim();

/**
 * full:    rule / icon label / rule     (rules span the whole content width)
 * compact: ── icon label ─────────       (one line)
 */
export function headerMarkdown(icon: string, label: string, width: number, style: HeaderStyle): string {
  const w = Math.max(1, Math.floor(width));
  const title = `${plain(icon)} **${plain(label)}**`;
  if (style === 'compact') {
    const lead = '── ';
    const used = visibleWidth(`${lead}${icon} ${label} `);
    return `${lead}${title} ${'─'.repeat(Math.max(1, w - used))}`;
  }
  const rule = '─'.repeat(w);
  return `${rule}\n${title}\n${rule}`;
}

export const withHeader = (header: string, markdown: string): string => `${header}\n\n${markdown}`;

// ---- which assistant text block gets the header --------------------------------------------
// Pi renders one Markdown per assistant text block, and a tool-using turn splits the reply into
// several messages. Only the FIRST non-empty text after a user message gets the header.
// Persisted messages carry an entry id; live (streaming) ones do not, so they are tracked
// from message events and matched by text.

type Block = { type?: string; text?: string };
type Msg = { role?: string; content?: string | Block[] };

export function firstText(message: Msg | undefined): string | null {
  const content = message?.content;
  if (typeof content === 'string') return content.trim() || null;
  for (const block of content || []) if (block?.type === 'text' && block.text?.trim()) return block.text.trim();
  return null;
}

type Entry = { id?: string; type?: string; message?: Msg; [key: string]: unknown };

/** entry id → the text of the assistant block that opens each answer, from a session branch. */
export function persistedHeaders(entries: Entry[]): Map<string, string> {
  const out = new Map<string, string>();
  let pending = false;
  for (const e of entries) {
    if (e.type !== 'message' || !e.message) continue;
    if (e.message.role === 'user') { pending = true; continue; }
    if (e.message.role !== 'assistant' || !pending || !e.id) continue;
    const text = firstText(e.message);
    if (text) { out.set(e.id, text); pending = false; }
  }
  return out;
}

export class LiveTurns {
  private pending = false;
  private seq = 0;
  private holderSeq = -1;
  private holderText: string | null = null;
  private streaming = false;
  /** Texts of finished live header blocks (earlier turns re-render on resize, still without ids). */
  private done = new Set<string>();

  user(): void { this.pending = true; }

  assistantStart(message: Msg): void { this.seq += 1; this.assistant(message); }

  assistant(message: Msg): void {
    const text = firstText(message);
    if (this.holderSeq === this.seq) { if (text) this.holderText = text; return; }
    if (this.pending && text) {
      this.pending = false;
      this.holderSeq = this.seq;
      this.holderText = text;
      this.streaming = true;
    }
  }

  assistantEnd(message: Msg): void {
    this.assistant(message);
    if (this.holderSeq === this.seq) {
      if (this.holderText) this.done.add(this.holderText);
      this.streaming = false;
    }
  }

  /** Is this rendered assistant block the one that opens the answer? */
  matches(markdown: string): boolean {
    const t = markdown.trim();
    if (!t) return false;
    if (this.done.has(t)) return true;
    // While streaming, the render may run one update ahead of or behind our event.
    return this.streaming && !!this.holderText && (t.startsWith(this.holderText) || this.holderText.startsWith(t));
  }
}
