// UI override: the empty right side of Pi's footer first line (`~/repo (branch)`), as a slot that
// extensions fill with short segments. Pi's footer is left untouched: a one-line, non-capturing
// overlay is drawn over that spot.
//
//   ~/calliopi (feat/x)                      onto jaeyeol-yee/calliopi#4 open   ← slot
//   ↑52 R4.2k W2.1k 1.7%/128k (auto)                       (faux) demo • medium
//
// Pi's footer component is found in the TUI tree and rendered at the terminal width each frame, so
// the slot follows its height (2 lines, 3 with extension statuses) and hides when the first line has
// no room left. No footer found (another extension replaced it): the slot hides.
import { visibleWidth } from '@earendil-works/pi-tui';

/** Columns kept free between the footer's first line and the slot. */
export const GAP = 2;

type Node = { children?: unknown[] };

/**
 * Depth-first search of a component tree (containers expose `children`), last child first: Pi's
 * footer sits at the end of the tree, after the whole transcript. Returns the match and its parent.
 */
export function findComponent(root: unknown, match: (c: unknown) => boolean): { node: unknown; parent: unknown } | undefined {
  const stack: { node: unknown; parent: unknown }[] = [{ node: root, parent: undefined }];
  while (stack.length) {
    const { node, parent } = stack.pop()!;
    if (!node || typeof node !== 'object') continue;
    if (match(node)) return { node, parent };
    const children = (node as Node).children;
    if (Array.isArray(children)) for (const child of children) stack.push({ node: child, parent: node });
  }
  return undefined;
}

export interface Placement {
  /** Rows up from the bottom edge (overlay offsetY with anchor bottom-right). */
  offsetY: number;
  show: boolean;
}

/** Where the slot goes for this footer render, and whether it fits beside the first line. */
export function placement(footerLines: readonly string[], slotWidth: number, termWidth: number): Placement {
  if (!footerLines.length || slotWidth <= 0) return { offsetY: 0, show: false };
  const left = visibleWidth(footerLines[0]!.trimEnd());
  return { offsetY: -(footerLines.length - 1), show: left + GAP + slotWidth <= termWidth };
}

/** Segments in key order, joined by two spaces. */
export function joinSegments(segments: ReadonlyMap<string, string>): string {
  return [...segments.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, text]) => text).join('  ');
}

type Footer = { render(width: number): string[] };
type Tui = { terminal: { columns: number }; requestRender(): void };
type Ui = {
  custom<T>(factory: (tui: never, theme: never, keys: never, done: (result: T) => void) => unknown, options: unknown): Promise<T>;
};

export class FooterSlot {
  private segments = new Map<string, string>();
  private tui: Tui | undefined;
  private footer: { node: Footer; parent: Node } | undefined;
  private lastSearch = 0;
  private close: (() => void) | undefined;
  // Pi keeps this object and reads it on every frame, so changing it moves and resizes the overlay.
  private readonly options = { anchor: 'bottom-right', width: 1, offsetY: 0, nonCapturing: true };

  private readonly isFooter: (c: unknown) => boolean;

  constructor(isFooter: (c: unknown) => boolean) { this.isFooter = isFooter; }

  /** Set (or clear, with undefined) one segment. Text may carry ANSI styles and OSC 8 links. */
  set(key: string, text: string | undefined): void {
    if (text) this.segments.set(key, text); else this.segments.delete(key);
    // The width is resolved before render, so it is set here, not while rendering.
    this.options.width = Math.max(1, visibleWidth(joinSegments(this.segments)));
    this.tui?.requestRender();
  }

  get mounted(): boolean { return this.close !== undefined; }

  mount(ui: Ui): void {
    if (this.close) return;
    void ui.custom<void>((tui: never, _theme, _keys, done) => {
      this.tui = tui as Tui;
      this.close = () => done();
      return { render: (width: number) => this.render(width), invalidate() {} };
    }, { overlay: true, overlayOptions: this.options }).finally(() => {
      this.tui = undefined; this.footer = undefined; this.close = undefined;
    });
  }

  unmount(): void { this.close?.(); }

  private render(width: number): string[] {
    const text = joinSegments(this.segments);
    if (!text || !this.tui) return [];
    // Pi swaps the footer container's child when an extension sets its own footer: look it up again
    // then, at most once a second (a replaced footer stays replaced).
    if (this.footer && !this.footer.parent.children?.includes(this.footer.node)) this.footer = undefined;
    if (!this.footer && Date.now() - this.lastSearch > 1000) {
      this.lastSearch = Date.now();
      this.footer = findComponent(this.tui, this.isFooter) as { node: Footer; parent: Node } | undefined;
    }
    if (!this.footer) return [];
    let lines: string[];
    try { lines = this.footer.node.render(this.tui.terminal.columns); } catch { return []; }
    const at = placement(lines, visibleWidth(text), this.tui.terminal.columns);
    this.options.offsetY = at.offsetY; // read again after render, for this frame's row
    return at.show ? [' '.repeat(Math.max(0, width - visibleWidth(text))) + text] : [];
  }
}
