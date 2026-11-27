import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'calliopi-web-'));
process.env.PI_CODING_AGENT_DIR = home;
const { default: install, SETTINGS_FILE, TOOL, loadRules } = await import('#extensions/web-fetch.ts');

function fakePi() {
  const tools = new Map<string, { execute: (...a: unknown[]) => Promise<{ content: { text: string }[]; isError?: boolean }>; promptGuidelines?: string[] }>();
  let gate: ((e: unknown, c: unknown) => Promise<unknown>) | undefined;
  const pi = { registerTool: (t: { name: string }) => tools.set(t.name, t as never), on: (n: string, fn: never) => { if (n === 'tool_call') gate = fn; } };
  install(pi as never);
  const asks: string[] = [];
  let answer = true;
  const ctx = (hasUI = true) => ({ hasUI, ui: { confirm: async (_t: string, body: string) => { asks.push(body); return answer; } } });
  const call = (url: unknown, hasUI = true) => gate!({ toolName: TOOL, input: { url } }, ctx(hasUI)) as Promise<{ block?: boolean; reason?: string } | undefined>;
  return { tools, call, asks, setAnswer: (v: boolean) => { answer = v; } };
}
const settings = (json: string | null) => {
  const file = path.join(home, SETTINGS_FILE);
  if (json === null) fs.rmSync(file, { force: true }); else fs.writeFileSync(file, json);
};

test('web_fetch is registered as a primitive tool with guidelines naming it', async () => {
  const f = fakePi();
  const tool = f.tools.get(TOOL)!;
  assert.ok(tool && tool.promptGuidelines!.every(g => g.includes(TOOL)));
  const r = await tool.execute('id', { url: 'http://127.0.0.1:1/' }, undefined);
  assert.equal(r.isError, true);
  assert.match(r.content[0]!.text, /not a public internet address/);
  const bad = await tool.execute('id', { url: 'file:///etc/passwd' }, undefined);
  assert.equal(bad.isError, true);
});

test('host rules gate: none = allow; deny; allow list; ask once per host; no UI; broken settings deny all', async () => {
  settings(null);
  let f = fakePi();
  assert.equal(await f.call('https://example.com/'), undefined);
  assert.equal(await f.call(42), undefined); // not a URL string: the tool's own validation reports it
  settings(JSON.stringify({ deny: ['*.evil.test'], allow: ['*.ok.test', 'ask.test'], ask: ['ask.test'] }));
  f = fakePi();
  assert.match((await f.call('https://a.evil.test/'))!.reason!, /denied by the rule/);
  assert.match((await f.call('https://elsewhere.test/'))!.reason!, /not in the allow list/);
  assert.equal(await f.call('https://x.ok.test/'), undefined);
  assert.equal(await f.call('https://ask.test/a'), undefined);
  assert.equal(await f.call('https://ask.test/b'), undefined);
  assert.equal(f.asks.length, 1, 'asked once for the host');
  const g = fakePi();
  g.setAnswer(false);
  assert.match((await g.call('https://ask.test/'))!.reason!, /declined/);
  assert.match((await fakePi().call('https://ask.test/', false))!.reason!, /no UI to ask/);
  settings('{ not json');
  assert.equal(loadRules(home).deny[0], '*');
  assert.match((await fakePi().call('https://example.com/'))!.reason!, /settings cannot be read/);
  settings(null);
  fs.rmSync(home, { recursive: true, force: true });
});
