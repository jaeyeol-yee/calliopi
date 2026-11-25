import test from 'node:test';
import assert from 'node:assert/strict';
import { TuiAltScreen, visibleWidth, type Component, type Terminal } from '@earendil-works/pi-tui';
import { FooterSlot, findComponent, joinSegments, placement } from '#lib/ui-override/footer-slot.ts';

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '').replace(/\x1b\]8;;[^\x07]*\x07/g, '');

test('placement: one row up per footer line below the first; hidden when the first line has no room', () => {
  assert.deepEqual(placement(['~/r (main)', 'stats'], 10, 80), { offsetY: -1, show: true });
  assert.deepEqual(placement(['~/r (main)', 'stats', 'statuses'], 10, 80), { offsetY: -2, show: true });
  assert.equal(placement(['x'.repeat(70), 'stats'], 10, 80).show, false, '70 + gap 2 + 10 > 80');
  assert.equal(placement(['x'.repeat(68), 'stats'], 10, 80).show, true, '68 + 2 + 10 = 80');
  assert.equal(placement(['\x1b[2m~/r (main)\x1b[22m'], 69, 80).show, false, 'ANSI does not count, text does (10 + 2 + 69)');
  assert.equal(placement([], 10, 80).show, false);
});

test('findComponent searches from the end and returns the parent; joinSegments orders by key', () => {
  const footer = { id: 'footer' };
  const box = { children: [footer] };
  const root = { children: [{ children: [{ id: 'chat' }] }, box] };
  assert.deepEqual(findComponent(root, (c) => c === footer), { node: footer, parent: box });
  assert.equal(findComponent(root, () => false), undefined);
  assert.equal(joinSegments(new Map([['b', 'B'], ['a', 'A']])), 'A  B');
});

class Fake implements Terminal {
  out = '';
  start() {} stop() {} async drainInput() {} write(d: string) { this.out += d; }
  get columns() { return 60; } get rows() { return 8; } get kittyProtocolActive() { return false; }
  moveBy() {} hideCursor() {} showCursor() {} clearLine() {} clearFromCursor() {} clearScreen() {}
  setTitle() {} setProgress() {} setProgramStatus() {}
}
/**
 * pi-tui's own compositor (fullscreen TUI, as Pi uses by default), so the test fails if Pi stops
 * reading the options object each frame.
 */
class Tui extends TuiAltScreen {
  composite(lines: string[]) { return this.compositeOverlays(lines, 60, 8); }
}
class Footer implements Component {
  lines = ['~/calliopi (main)', 'stats                                         demo • medium'];
  render() { return this.lines; }
  invalidate() {}
}

function mounted() {
  const tui = new Tui(new Fake());
  const footer = new Footer();
  const container = { children: [footer] as unknown[], render: () => [], invalidate() {} };
  tui.addChild({ render: () => ['chat'], invalidate() {} });
  tui.addChild(container as never);
  const slot = new FooterSlot((c) => c instanceof Footer);
  const ui = {
    custom: (factory: (...a: never[]) => Component, opts: { overlayOptions: never }) => new Promise<void>((resolve) => {
      const component = factory(tui as never, {} as never, {} as never, (() => { handle.hide(); resolve(); }) as never);
      const handle = tui.showOverlay(component, opts.overlayOptions);
    }),
  };
  slot.mount(ui as never);
  // Screen as Pi draws it (8 rows): the transcript on top, the footer on the bottom rows.
  const screen = () => tui.composite(['chat', ...Array(7 - footer.lines.length).fill(''), ...footer.lines]).map(strip);
  return { slot, footer, container, screen };
}

test('the slot lands on the footer first line, right-aligned, and follows a third footer line', () => {
  const { slot, footer, screen } = mounted();
  assert.deepEqual(screen().slice(-2), ['~/calliopi (main)', 'stats                                         demo • medium']);
  slot.set('b', 'onto o/r#4 open');
  let rows = screen();
  assert.equal(rows[6], `~/calliopi (main)${' '.repeat(60 - 17 - 15)}onto o/r#4 open`);
  assert.equal(rows[7], 'stats                                         demo • medium', 'the stats line is untouched');

  footer.lines = [...footer.lines, 'ext status'];
  rows = screen();
  assert.equal(rows[5], `~/calliopi (main)${' '.repeat(60 - 17 - 15)}onto o/r#4 open`, 'moved up with the third line');
  assert.equal(rows[7], 'ext status');
});

test('the slot hides without room, without segments, and when the footer is replaced', () => {
  const { slot, footer, container, screen } = mounted();
  slot.set('b', 'onto o/r#4 open');
  footer.lines = ['~/' + 'x'.repeat(45), footer.lines[1]!];
  assert.equal(screen().some((l) => l.includes('onto')), false, 'no room');
  footer.lines = ['~/r (main)', footer.lines[1]!];
  assert.equal(screen().some((l) => l.includes('onto')), true);
  slot.set('b', undefined);
  assert.equal(screen().some((l) => l.includes('onto')), false, 'no segments');
  slot.set('b', 'onto o/r#4 open');
  container.children = [{ render: () => ['custom footer'], invalidate() {} }];
  assert.equal(screen().some((l) => l.includes('onto')), false, 'footer replaced by another extension');
  assert.equal(visibleWidth('onto o/r#4 open'), 15);
});
