import { test } from 'node:test';
import assert from 'node:assert/strict';
import { visibleWidth } from '@earendil-works/pi-tui';
import { detailMetadata, renderInspector, viewportHeight, type InspectorState, type ViewEnv } from '#extensions/components/inspector-view.ts';

const plain = { fg: (_c: any, s: string) => s, bold: (s: string) => s };
// Records which color each piece of text was drawn with, without changing its width.
const recording = () => { const colors: [string, string][] = []; return { colors, theme: { fg: (c: string, s: string) => (colors.push([c, s]), s), bold: (s: string) => s } }; };
const env = (extra: Partial<ViewEnv> = {}): ViewEnv => ({ theme: plain, rows: 30, highlight: (t) => t.split('\n'), ...extra });
const agent = (label: string, extra = {}) => ({ agentId: `bc-${label}`, label, summary: `${label} goal`, status: 'RUNNING', runId: 'r1', ...extra }) as any;
const state = (extra: Partial<InspectorState> = {}): InspectorState => ({ agents: [], selected: 0, offset: 0, detail: false, review: null, showMetadata: true, includeArchived: false, ...extra });

// Frame: top border, blank, title, blank, viewport…, blank, divider, hint, blank, bottom border.
const viewport = (lines: string[]) => lines.slice(4, -5);
// Strip the frame ("│  " … "  │"), then split the content from the scroll rail ("│ ▲ ").
const cell = (line: string) => { const body = line.slice(3, -3); const i = body.lastIndexOf('│'); return { text: body.slice(0, i).trimEnd(), glyph: body[i + 2] }; };
const inner = (line: string) => cell(line).text;

test('frame keeps every line at the requested width and the viewport at rows - 14', () => {
  const lines = renderInspector(state({ agents: [agent('a')] }), 60, env());
  assert.equal(viewportHeight(30), 16);
  assert.equal(viewportHeight(20), 6);
  assert.equal(viewportHeight(5), 1);
  assert.equal(lines.length, 16 + 9);
  for (const l of lines) assert.equal(visibleWidth(l), 60);
  assert.match(lines[0], /^╭─+╮$/);
  assert.match(lines.at(-1)!, /^╰─+╯$/);
});

test('list shows title with count, marks the selection and scrolls it into view', () => {
  const agents = Array.from({ length: 10 }, (_, i) => agent(`t${i}`));
  const s = state({ agents, selected: 9 });
  const lines = renderInspector(s, 60, env({ rows: 18 })); // 4-row viewport
  assert.match(lines[2], /☁ Fan-out 현황 · 10개 작업/);
  const rows = viewport(lines).map(cell);
  assert.equal(rows.length, 4);
  assert.match(rows[0].text, /^ {2}.* t6 · /);
  assert.equal(rows[0].glyph, '▲');
  assert.match(rows[3].text, /^› .* t9 · .*t9 goal$/);
  assert.equal(rows[3].glyph, ' ');
  assert.match(lines.at(-3)!, /Enter 상세/);
});

test('selection is clamped and an empty list says so', () => {
  const s = state({ agents: [agent('only')], selected: 5 });
  renderInspector(s, 60, env());
  assert.equal(s.selected, 0);
  const empty = renderInspector(state(), 60, env());
  assert.match(inner(viewport(empty)[0]), /^작업이 없습니다\./);
  assert.match(empty[2], /0개 작업/);
});

test('history title when archived records are included', () => {
  assert.match(renderInspector(state({ includeArchived: true }), 60, env())[2], /전체 기록/);
});

test('detail shows metadata then the highlighted result, and m hides the table', () => {
  const a = agent('job', { status: 'FINISHED', runs: { r1: { result: 'line one\nline two' } } });
  const seen: string[] = [];
  const e = env({ highlight: (t) => { seen.push(t); return t.split('\n'); } });
  // The table is taller than the viewport: it leads, and the result follows once scrolled.
  const top = viewport(renderInspector(state({ agents: [a], detail: true }), 80, e)).map(inner).join('\n');
  assert.match(top, /작업 .*job/);
  assert.doesNotMatch(top, /line one/);
  const end = viewport(renderInspector(state({ agents: [a], detail: true, offset: 10_000 }), 80, e)).map(inner).join('\n');
  assert.match(end, /결과\n\nline one\nline two$/);
  assert.deepEqual(new Set(seen), new Set(['line one\nline two'])); // the result alone is highlighted, not the table
  const bare = viewport(renderInspector(state({ agents: [a], detail: true, showMetadata: false }), 80, e)).map(inner);
  assert.deepEqual(bare.slice(0, 4), ['결과', '', 'line one', 'line two']);
});

test('detail without a result says so', () => {
  const out = viewport(renderInspector(state({ agents: [agent('x')], detail: true, showMetadata: false }), 60, env())).map(inner);
  assert.equal(out[2], '아직 결과가 없습니다.');
});

test('diff review colors +/-/@@ lines and clamps scrolling to the end', () => {
  const review = ['head', '@@ -1 +1 @@', '-old', '+new', ...Array.from({ length: 30 }, (_, i) => ` ctx ${i}`)].join('\n');
  const s = state({ review, detail: true, offset: 10_000 });
  const end = renderInspector(s, 60, env({ rows: 20 }));
  assert.match(end[2], /☁ Diff 리뷰/);
  assert.equal(s.offset, 34 - 6);
  assert.equal(inner(viewport(end).at(-1)!), ' ctx 29');
  const r = recording();
  const top = renderInspector(state({ review, detail: true }), 60, env({ theme: r.theme, rows: 20 }));
  const color = (text: string) => r.colors.find(([, t]) => t === text)?.[0];
  assert.equal(color('@@ -1 +1 @@'), 'accent');
  assert.equal(color('-old'), 'error');
  assert.equal(color('+new'), 'success');
  assert.equal(color('head'), 'text');
  assert.equal(cell(viewport(top).at(-1)!).glyph, '▼');
});

test('wrapped content is cached per text, width and theme', () => {
  let calls = 0;
  const e = env({ highlight: (t) => { calls++; return [t]; }, themeKey: 'dark' });
  const s = state({ agents: [agent('c', { runs: { r1: { result: 'r' } } })], detail: true });
  renderInspector(s, 60, e); renderInspector(s, 60, e);
  assert.equal(calls, 1);
  renderInspector(s, 70, e);
  renderInspector(s, 70, { ...e, themeKey: 'light' });
  assert.equal(calls, 3);
});

test('narrow widths degrade to a bare title', () => {
  const tiny = renderInspector(state(), 7, env());
  assert.equal(tiny.length, 1);
  assert.ok(visibleWidth(tiny[0]) <= 7);
  assert.match(tiny[0], /^☁ Fa/);
  for (const l of renderInspector(state({ agents: [agent('n')] }), 12, env())) assert.equal(visibleWidth(l), 12);
});

test('metadata links agent, repository, branch and PR review state', () => {
  const a = agent('m', {
    batch: 'b1', git: { branches: [{ repoUrl: 'github.com/o/r', branch: 'feat/x', prUrl: 'https://github.com/o/r/pull/1' }] },
    reviews: { 'https://github.com/o/r/pull/1': { state: 'approved' } },
  });
  const meta = Object.fromEntries(detailMetadata(a, true));
  assert.deepEqual(meta['에이전트'], { text: 'bc-m', url: 'https://cursor.com/agents/bc-m' });
  assert.deepEqual(meta['저장소'], [{ text: 'github.com/o/r', url: 'https://github.com/o/r' }]);
  assert.deepEqual(meta['브랜치'], [{ text: 'feat/x', url: 'https://github.com/o/r/tree/feat%2Fx' }]);
  assert.deepEqual(meta['PR'], [{ text: 'https://github.com/o/r/pull/1', url: 'https://github.com/o/r/pull/1' }, ' · approved']);
  assert.match(meta['갱신'] as string, /^갱신 중 · /);
  assert.equal(meta['보관 시각'], '미기록');
});
