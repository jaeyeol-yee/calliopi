// Thinking blocks as an indented frame inside the assistant message:
//
//   ╭─ ∴ thinking ─────────────╮      visible thinking
//   │ reasoning text …          │
//   ╰───────────────────────────╯
//   ┊ ∴ Thinking...                    hidden thinking (one line)
//
// Pi wraps each thinking run of an AssistantMessageComponent in a MouseRegion (click toggles it);
// the frame wraps that region, so clicks still toggle (coordinates shifted by the border).
import { MouseRegion, Text, truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
import type { Component, TuiMouseEvent, TuiMouseEventResult } from '@earendil-works/pi-tui';

export const THINKING_MARK = '∴';

export interface FramePaint { border: (s: string) => string; title: (s: string) => string }
export const PLAIN_FRAME: FramePaint = { border: (s) => s, title: (s) => s };

const fit = (line: string, width: number) => {
  const cut = truncateToWidth(line, width, '');
  return cut + ' '.repeat(Math.max(0, width - visibleWidth(cut)));
};

export class ThinkingFrame implements Component {
  readonly region: Component;
  readonly hidden: boolean;
  readonly pad: number;
  readonly paint: () => FramePaint;
  private offsetX = 0;
  private offsetY = 0;

  constructor(region: Component, { hidden, pad = 1, paint = () => PLAIN_FRAME }: { hidden: boolean; pad?: number; paint?: () => FramePaint }) {
    this.region = region; this.hidden = hidden; this.pad = pad; this.paint = paint;
  }

  render(width: number): string[] {
    const p = this.paint();
    const indent = ' '.repeat(this.pad + 1);
    const box = width - indent.length - this.pad; // frame spans indent … right padding
    if (box < 8) return this.region.render(width); // too narrow to frame
    if (this.hidden) {
      // The hidden label renders with Pi's own padding; keep its text only.
      const label = this.region.render(box).map((l) => l.trim()).filter(Boolean).join(' ');
      const lead = `${p.border('┊')} ${p.title(THINKING_MARK)} `;
      this.offsetX = indent.length + 4; this.offsetY = 0;
      return [`${indent}${lead}${truncateToWidth(label, box - 4, '…')}`];
    }
    // Child renders between the side borders; its own 1-column padding gives the inner margin.
    const inner = box - 2;
    const body = this.region.render(inner).map((l) => `${p.border('│')}${fit(l, inner)}${p.border('│')}`);
    // Shorten the title when narrow; without room for even the mark, draw no frame at all.
    const title = [` ${THINKING_MARK} thinking `, ` ${THINKING_MARK} `].find((t) => box - 3 - visibleWidth(t) >= 0);
    if (!title) return this.region.render(width);
    const top = `${p.border('╭─')}${p.title(title)}${p.border(`${'─'.repeat(Math.max(0, box - 3 - visibleWidth(title)))}╮`)}`;
    const bottom = p.border(`╰${'─'.repeat(box - 2)}╯`);
    this.offsetX = indent.length + 1; this.offsetY = 1;
    return [indent + top, ...body.map((l) => indent + l), indent + bottom];
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    const shifted = { ...event, x: Math.max(0, event.x - this.offsetX), y: Math.max(0, event.y - this.offsetY) };
    return this.region.handleMouse?.(shifted) as TuiMouseEventResult | undefined;
  }

  invalidate(): void { this.region.invalidate(); }
}

type ContainerLike = { children?: Component[] };
type RegionLike = { child?: Component };

/**
 * Replace each thinking MouseRegion in an assistant message's content container with a frame.
 * Leaves anything it does not recognise untouched (returns the number of frames applied).
 */
export function frameThinking(container: ContainerLike | undefined, options: { pad?: number; paint?: () => FramePaint } = {}): number {
  const children = container?.children;
  if (!Array.isArray(children)) return 0;
  let n = 0;
  for (let i = 0; i < children.length; i++) {
    const c = children[i];
    if (!(c instanceof MouseRegion)) continue;
    const child = (c as unknown as RegionLike).child;
    children[i] = new ThinkingFrame(c, { hidden: child instanceof Text, ...options });
    n++;
  }
  return n;
}

// ---- installing on AssistantMessageComponent ------------------------------------------------
const PATCH = Symbol.for('calliopi.thinkingFrame.patch');
type UpdateFn = (this: object, ...args: unknown[]) => unknown;
type Patchable = { prototype: { updateContent?: UpdateFn; [PATCH]?: { original: UpdateFn; hook: (instance: object) => void } } };

/**
 * Run `hook(instance)` after every updateContent() (which rebuilds the message's children).
 * The hook can never break the update: errors are swallowed and Pi's own children stay.
 * Returns false when the class does not look as expected.
 */
export function installAfterUpdate(cls: Patchable, hook: (instance: object) => void): boolean {
  const proto = cls?.prototype;
  if (!proto || typeof proto.updateContent !== 'function') return false;
  const existing = proto[PATCH];
  if (existing) { existing.hook = hook; return true; }
  const state = { original: proto.updateContent, hook };
  proto.updateContent = function (this: object, ...args: unknown[]) {
    const result = state.original.apply(this, args);
    try { state.hook(this); } catch { /* keep Pi's rendering */ }
    return result;
  };
  proto[PATCH] = state;
  return true;
}

export function uninstallAfterUpdate(cls: Patchable): void {
  const proto = cls?.prototype;
  const state = proto?.[PATCH];
  if (!proto || !state) return;
  proto.updateContent = state.original;
  delete proto[PATCH];
}
