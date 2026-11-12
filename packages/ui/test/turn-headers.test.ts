import test from 'node:test';
import assert from 'node:assert/strict';
import { Markdown, visibleWidth } from '@earendil-works/pi-tui';
import { DEFAULT_CONFIG, LiveTurns, firstText, headerMarkdown, persistedHeaders, withHeader } from '#lib/turn-headers.ts';

const id = (s: string) => s;
const theme = { heading: id, link: id, linkUrl: id, code: id, codeBlock: id, codeBlockBorder: id, quote: id, quoteBorder: id, hr: id, listBullet: id, bold: id, italic: id, strikethrough: id, underline: id } as never;
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');
/** Render like Pi: padding 1 on each side, so the transformer's availableWidth is width - 2. */
const render = (md: string, width: number) => new Markdown(md, 1, 0, theme).render(width).map((l) => strip(l).trimEnd());

test('icons are not emoji (terminals must not swap in colour emoji)', () => {
  for (const icon of [DEFAULT_CONFIG.userIcon, DEFAULT_CONFIG.assistantIcon]) assert.equal(/\p{Emoji}/u.test(icon), false, icon);
});

test('full style: rules span the whole content width above and below the header line', () => {
  const width = 50;
  const lines = render(withHeader(headerMarkdown('◉', '사용자', width - 2, 'full'), 'PR 머지하고 archive 처리하죠'), width);
  assert.deepEqual(lines.slice(0, 5), [` ${'─'.repeat(48)}`, ' ◉ 사용자', ` ${'─'.repeat(48)}`, '', ' PR 머지하고 archive 처리하죠']);
});

test('compact style: one line, exactly the content width, including wide (Korean) labels', () => {
  for (const width of [30, 80, 133]) {
    const [first] = render(headerMarkdown('◉', '사용자', width - 2, 'compact'), width);
    assert.match(first, /^ ── ◉ 사용자 ─+$/);
    assert.equal(visibleWidth(first), width - 1); // left pad + content
  }
});

test('labels cannot inject Markdown structure', () => {
  const md = headerMarkdown('*', '# **x** [y](z)', 40, 'full');
  const lines = render(md, 42);
  // no heading, no bold, no link: the label stays literal text on the header line
  assert.match(lines[1], /^ \* # \*\*x\*\* \[?y\]?\(z\)$/);
  assert.equal(lines.length, 3);
});

test('persisted, first mode: only the first non-empty assistant text after each user message', () => {
  const user = (id: string) => ({ id, type: 'message', message: { role: 'user', content: 'q' } });
  const asst = (id: string, ...blocks: object[]) => ({ id, type: 'message', message: { role: 'assistant', content: blocks } });
  const map = persistedHeaders([
    user('u1'),
    asst('a1', { type: 'toolCall' }), // tool call first: no text yet
    { id: 't1', type: 'message', message: { role: 'toolResult', content: [] } },
    asst('a2', { type: 'thinking', thinking: 'hm' }, { type: 'text', text: '  answer one ' }),
    asst('a3', { type: 'text', text: 'more narration' }),
    { id: 'c1', type: 'custom', customType: 'x' },
    user('u2'),
    asst('a4', { type: 'text', text: 'answer two' }),
  ], 'first');
  assert.deepEqual([...map], [['a2', 'answer one'], ['a4', 'answer two']]);
  assert.equal(firstText({ content: [{ type: 'text', text: '   ' }, { type: 'text', text: 'x' }] }), 'x');
});

test('live, first mode: header follows the streaming first text, not later messages of the same turn', () => {
  const live = new LiveTurns('first');
  const msg = (text?: string) => ({ role: 'assistant', content: text ? [{ type: 'text', text }] : [{ type: 'toolCall' }] });
  live.user();
  live.assistantStart(msg()); // turn opens with a tool call
  live.assistantEnd(msg());
  live.assistantStart(msg('Let me'));
  assert.equal(live.matches('Let me'), true);
  assert.equal(live.matches('Let me check the'), true, 'render one update ahead of the event');
  live.assistant(msg('Let me check the file.'));
  assert.equal(live.matches('Let me check'), true, 'render one update behind');
  live.assistantEnd(msg('Let me check the file.'));
  live.assistantStart(msg('Done.'));
  live.assistantEnd(msg('Done.'));
  assert.equal(live.matches('Done.'), false, 'second message of the same turn');
  assert.equal(live.matches('Let me check the file.'), true, 'earlier header still matches on re-render (resize)');
  live.user();
  live.assistantStart(msg('Second answer'));
  live.assistantEnd(msg('Second answer'));
  assert.equal(live.matches('Second answer'), true);
  assert.equal(live.matches(''), false);
});

test('every mode (default): each assistant message (model turn) with text gets one header', () => {
  const user = (id: string) => ({ id, type: 'message', message: { role: 'user', content: 'q' } });
  const asst = (id: string, ...blocks: object[]) => ({ id, type: 'message', message: { role: 'assistant', content: blocks } });
  const map = persistedHeaders([
    user('u1'),
    asst('a1', { type: 'toolCall' }),                                     // tool only: nothing to put a header on
    asst('a2', { type: 'text', text: 'first' }, { type: 'text', text: 'same message, second block' }),
    asst('a3', { type: 'text', text: 'narration between tools' }),
    asst('a4', { type: 'thinking', thinking: '…' }, { type: 'toolCall' }),
  ]);
  assert.deepEqual([...map], [['a2', 'first'], ['a3', 'narration between tools']]);
  assert.equal(DEFAULT_CONFIG.assistantHeaders, 'every');

  const live = new LiveTurns();
  const msg = (...texts: string[]) => ({ role: 'assistant', content: texts.length ? texts.map((text) => ({ type: 'text', text })) : [{ type: 'toolCall' }] });
  live.user();
  live.assistantStart(msg()); live.assistantEnd(msg());
  live.assistantStart(msg('one')); live.assistantEnd(msg('one', 'one-b'));
  live.assistantStart(msg('two')); live.assistantEnd(msg('two'));
  assert.equal(live.matches('one'), true);
  assert.equal(live.matches('one-b'), false, 'only the first text block of a message');
  assert.equal(live.matches('two'), true, 'next model turn gets its own header');
});
