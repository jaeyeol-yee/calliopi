import test from 'node:test';
import assert from 'node:assert/strict';
import { AssistantMessageComponent, UserMessageComponent, initTheme } from '@earendil-works/pi-coding-agent';
import { Container, visibleWidth } from '@earendil-works/pi-tui';
import { headerLines, installHeader, uninstallHeader } from '../lib/turn-headers.ts';
import { frameThinking, installAfterUpdate, uninstallAfterUpdate, ThinkingFrame } from '../lib/thinking-frame.ts';

initTheme('dark');
const strip = (s: string) => s.replace(/\x1b\][^\x07]*\x07/g, '').replace(/\x1b_[^\x07]*\x07/g, '').replace(/\x1b\[[0-9;]*m/g, '');
const view = (c: { render(w: number): string[] }, w: number) => c.render(w).map(strip);

type View = { outputPad?: number; hasToolCalls?: boolean; contentContainer?: { children?: never[] } };
function install() {
  installHeader(AssistantMessageComponent as never, (i, w, lines) => ((lines.length || (i as View).hasToolCalls) ? headerLines('⛭', 'Pi', w, 'full', (i as View).outputPad ?? 1) : null));
  installHeader(UserMessageComponent as never, (i, w, lines) => (lines.length ? headerLines('◉', '사용자', w, 'full', (i as View).outputPad ?? 1) : null));
  installAfterUpdate(AssistantMessageComponent as never, (i) => { frameThinking((i as View).contentContainer, { pad: (i as View).outputPad ?? 1 }); });
}
function uninstall() {
  uninstallHeader(AssistantMessageComponent as never);
  uninstallHeader(UserMessageComponent as never);
  uninstallAfterUpdate(AssistantMessageComponent as never);
}
const msg = (...content: object[]) => ({ role: 'assistant', content }) as never;

test('assistant: header → thinking frame → answer, all within the width', (t) => {
  install(); t.after(uninstall);
  const W = 50;
  const a = new AssistantMessageComponent(msg({ type: 'thinking', thinking: 'let me think about it carefully' }, { type: 'text', text: 'Hello there' }), false);
  const lines = view(a, W);
  assert.deepEqual(lines.slice(0, 3), [` ${'─'.repeat(48)}`, ' ⛭ Pi', ` ${'─'.repeat(48)}`]);
  const top = lines.findIndex((l) => l.includes('╭─ ∴ thinking'));
  assert.ok(top > 2, 'frame after the header');
  assert.match(lines[top], /^  ╭─ ∴ thinking ─+╮$/);
  assert.match(lines[top + 1], /^  │ let me think about it carefully +│$/);
  assert.match(lines[top + 2], /^  ╰─+╯$/);
  assert.ok(lines.findIndex((l) => l.trimEnd() === ' Hello there') > top + 2, 'answer after the frame, outside it');
  for (const l of a.render(W)) assert.ok(visibleWidth(l) <= W, `fits: ${strip(l)}`);
});

test('tool-only model turn still gets the header; empty message does not', (t) => {
  install(); t.after(uninstall);
  const tool = new AssistantMessageComponent(msg({ type: 'toolCall', id: 't1', name: 'read', arguments: {} }), false);
  assert.equal(view(tool, 40)[1], ' ⛭ Pi');
  assert.deepEqual(view(new AssistantMessageComponent(msg(), false), 40), []);
});

test('hidden thinking is one ┊ ∴ line, and a click still toggles it open', (t) => {
  install(); t.after(uninstall);
  const a = new AssistantMessageComponent(msg({ type: 'thinking', thinking: 'secret plan' }, { type: 'text', text: 'ok' }), true, undefined, 'Thinking...');
  assert.ok(view(a, 40).includes('  ┊ ∴ Thinking...'));
  const frame = (a as unknown as View).contentContainer!.children!.find((c) => (c as object) instanceof ThinkingFrame) as unknown as ThinkingFrame;
  a.render(40);
  const r = frame.handleMouse({ type: 'click', button: 'left', x: 6, y: 0, screenX: 6, screenY: 0, width: 40, height: 1, shift: false, alt: false, ctrl: false, clickCount: 1 });
  assert.equal(r?.handled, true);
  const opened = view(a, 40);
  assert.ok(opened.some((l) => l.includes('╭─ ∴ thinking')) && opened.some((l) => l.includes('secret plan')), 'toggled to the visible frame');
});

test('user message gets its header; uninstall restores Pi exactly; reinstall never doubles', (t) => {
  const plain = view(new UserMessageComponent('hi there'), 40);
  install(); t.after(uninstall);
  install(); // reload without shutdown: hooks are replaced, not stacked
  const u = view(new UserMessageComponent('hi there'), 40);
  assert.equal(u.filter((l) => l === ' ◉ 사용자').length, 1);
  assert.deepEqual(u.slice(3), plain);
  uninstall();
  assert.deepEqual(view(new UserMessageComponent('hi there'), 40), plain);
  for (const cls of [AssistantMessageComponent, UserMessageComponent]) {
    assert.equal(Object.prototype.hasOwnProperty.call(cls.prototype, 'handleMouse'), false, 'inherited Container.handleMouse again');
  }
});

test('a failing hook never breaks rendering', (t) => {
  installHeader(UserMessageComponent as never, () => { throw new Error('boom'); });
  installAfterUpdate(AssistantMessageComponent as never, () => { throw new Error('boom'); });
  t.after(uninstall);
  assert.ok(view(new UserMessageComponent('still here'), 30).some((l) => l.includes('still here')));
  assert.ok(view(new AssistantMessageComponent(msg({ type: 'text', text: 'fine' }), false), 30).some((l) => l.includes('fine')));
});

test('narrow widths: frame falls back to plain thinking instead of overflowing', (t) => {
  install(); t.after(uninstall);
  const a = new AssistantMessageComponent(msg({ type: 'thinking', thinking: 'x' }, { type: 'text', text: 'y' }), false);
  for (let W = 6; W <= 30; W++) for (const l of a.render(W)) assert.ok(visibleWidth(l) <= W, `W=${W}: ${strip(l)}`);
  assert.ok(view(a, 14).some((l) => /╭─ ∴ ─+╮/.test(l)), 'short title when narrow');
});

test('clicks go through the transcript like in Pi: header rows are not counted twice', (t) => {
  install(); t.after(uninstall);
  const W = 40;
  const a = new AssistantMessageComponent(msg({ type: 'thinking', thinking: 'secret plan' }, { type: 'text', text: 'ok' }), true, undefined, 'Thinking...');
  const chat = new Container();
  chat.addChild(new UserMessageComponent('question'));
  chat.addChild(a);
  const lines = chat.render(W).map(strip);
  const row = lines.findIndex((l) => l.includes('┊ ∴ Thinking...'));
  assert.ok(row > 0);
  const click = (y: number) => chat.handleMouse({ type: 'click', button: 'left', x: 6, y, screenX: 6, screenY: y, width: W, height: lines.length, shift: false, alt: false, ctrl: false, clickCount: 1 });
  assert.equal(click(row)?.handled, true, 'click on the hidden thinking line is handled');
  let now = chat.render(W).map(strip);
  assert.ok(now.some((l) => l.includes('secret plan')), 'expanded');
  const top = now.findIndex((l) => l.includes('╭─ ∴ thinking'));
  click(top + 1); // click inside the expanded frame
  now = chat.render(W).map(strip);
  assert.ok(now.some((l) => l.includes('┊ ∴ Thinking...')) && !now.some((l) => l.includes('secret plan')), 'collapsed again');
  // a click on the header itself does nothing
  const header = now.findIndex((l, i) => i > row - 6 && l === ' ⛭ Pi');
  assert.equal(click(header)?.handled ?? false, false);
});
