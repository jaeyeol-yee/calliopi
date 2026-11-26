import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listAgents, readAgent, type AgentRecord } from '@calliopi/core/agents';
import { TerminalPane } from '@calliopi/ui/terminal-overlay';
import { extensionArgs } from '#lib/launch.ts';
import { agentLine, registryRoot } from '#lib/parent.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..');
const tmp = (t: { after: (fn: () => void) => void }) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'calliopi-agents-parent-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

test('launch: the extensions this Pi was started with go to its children', () => {
  assert.deepEqual(extensionArgs(['node', 'pi', '-e', here, '--model', 'x', '--extension', 'npm:foo', `--extension=${here}`]), [here, 'npm:foo', here]);
});

test('progress line: state mark, what it does, how long, turns', () => {
  const r = { dir: '', meta: { id: 'scout-1', createdAt: 0 }, status: { state: 'running', activity: 'read', turns: 2, tokens: 0, startedAt: 0, updatedAt: 0 } } as unknown as AgentRecord;
  assert.equal(agentLine(r, 12_000), '● scout-1 · read · 12초 · 턴 2');
  const done = { ...r, result: { status: 'done', summary: '', usage: { turns: 3, tokens: 0, ms: 75_000 }, endedAt: 0 } } as AgentRecord;
  assert.equal(agentLine(done), '✓ scout-1 · 완료 · 1분 15초 · 턴 2');
});

// A top Pi in a pseudo-terminal of this test, typed into like a user would; its children run in its
// own pseudo-terminals. Everything answers with the demo's faux model.
test('top Pi delegates: background by default wakes the model when a child ends; foreground returns the results; briefed children', { timeout: 180_000 }, async t => {
  const agentHome = tmp(t), project = tmp(t), scenarios = tmp(t);
  fs.writeFileSync(path.join(project, 'login.ts'), 'export function login() {}\n');
  const until = async (what: string, ok: () => boolean, ms = 60_000) => {
    for (const end = Date.now() + ms; Date.now() < end && !ok();) await new Promise(r => setTimeout(r, 250));
    if (!ok()) fs.writeFileSync(path.join(os.tmpdir(), 'calliopi-agents-parent-screen.txt'), screenRef?.() ?? '');
    assert.ok(ok(), what);
  };
  let screenRef: (() => string) | undefined;
  // Pi's summarizer asks for a "context checkpoint summary" (or to update one in <previous-summary>).
  let completions: { match: string; text: string }[] = [];
  const scenario = (name: string, replies: unknown[]) => {
    const file = path.join(scenarios, `${name}.yaml`);
    fs.writeFileSync(file, JSON.stringify({ title: name, turns: replies.map(reply => ({ prompt: 'x', reply })), completions }));
    return file;
  };
  completions = [{ match: 'checkpoint summary|previous-summary', text: '## Goal\nFind login fast\n\n## Progress\n### Done\n- [x] asked twice\n\n## Key Decisions\n- **Scouts first**: cheap\n' }];
  const parent = scenario('parent', [
    // the first delegation of the session starts two at once: one shared import of the terminal module
    // (two imports at the same moment gave the second an unfinished module); the wait gives one reply
    [{ tool: 'subagent', args: { background: false, tasks: [{ role: 'scout', task: 'Find where login is defined', done: 'The file is named', context: 'none' }, { role: 'scout', task: 'Find it again', context: 'none' }] } }, { text: 'The scout found it.' }],
    [{ tool: 'subagent', args: { tasks: [{ role: 'scout', task: 'Look in the background', context: 'none' }] } }, { text: 'Started; carrying on.' }],
    [{ text: 'Background scout reported back.' }],
    [{ tool: 'subagent', args: { background: false, tasks: [{ role: 'scout', task: 'Check login with background' }] } }, { text: 'Briefed scout done.' }],
  ]);
  completions = [];
  const child = scenario('child', [[{ tool: 'read', args: { path: 'login.ts' } }, { tool: 'finish', args: { status: 'done', summary: 'login is in login.ts:1', evidence: 'read login.ts' } }]]);

  const top = new TerminalPane({ getCwd: () => project, requestRender: () => {} });
  t.after(() => top.dispose());
  top.resize(150, 45);
  // CALLIOPI_TEST_PI: another Pi's cli.js (e.g. the installed release), whose extension loader may differ.
  void top.run(process.execPath, [process.env.CALLIOPI_TEST_PI || path.join(repo, 'node_modules/@earendil-works/pi-coding-agent/dist/cli.js'),
    '-e', path.join(repo, 'demo/faux-extension.ts'), '-e', path.join(repo, 'packages/calliopi-agents/extensions/agents.ts'), '--model', 'faux/demo'],
  { ...process.env, PI_CODING_AGENT_DIR: agentHome, DEMO_SCENARIO: parent, DEMO_CHILD_SCENARIO: child });
  const screen = () => {
    const b = top.terminal.buffer.active;
    return Array.from({ length: b.length }, (_, i) => b.getLine(i)?.translateToString(true) ?? '').join('\n');
  };
  screenRef = screen;
  const type = async (text: string) => { top.write(text); await new Promise(r => setTimeout(r, 100)); top.write('\r'); };
  await until('pi up', () => /faux/.test(screen()), 40_000);

  const registry = registryRoot(agentHome);
  const agents = (): AgentRecord[] => {
    let roots: string[] = [];
    try { roots = fs.readdirSync(registry); } catch { return []; }
    return roots.flatMap(r => listAgents(registry, r));
  };
  const sessionOf = (r: AgentRecord) => {
    const file = fs.readdirSync(r.dir).find(f => new RegExp(`_${r.meta.id}\\.jsonl$`).test(f))!;
    return fs.readFileSync(path.join(r.dir, file), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  };

  // foreground: the tool waits, then hands the result to the model
  await type('Where is login?');
  await until('foreground reply', () => /The scout found it\./.test(screen()));
  const second = agents().find(r => r.meta.id === 'scout-1')!;
  assert.equal(second.result!.status, 'done');
  assert.equal(agents().find(r => r.meta.id === 'scout-2')!.result!.status, 'done'); // started together with scout-1
  assert.deepEqual(second.meta.tools.sort(), ['bash', 'find', 'grep', 'ls', 'read']);
  const header = sessionOf(second)[0];
  assert.match(header.parentSession, new RegExp(`${second.meta.root}\\.jsonl$`)); // the child's session names the top Pi's
  const topSession = () => fs.readFileSync(header.parentSession, 'utf8');
  assert.match(topSession(), /Subagent \\"scout-1\\" \(role scout, model faux\/demo\) ended: done\./);

  // background (the default): the tool returns at once; when the child ends, the model is woken
  await type('Look in the background');
  await until('background reply', () => /Background scout reported back\./.test(screen()));
  const first = agents().find(r => r.meta.id === 'scout-3')!;
  assert.deepEqual([first.meta.parent, first.meta.depth, first.meta.call.background, first.meta.pane], [null, 1, true, null]); // no pane opened
  assert.equal(readAgent(first.dir)!.result!.status, 'done');
  assert.match(topSession(), /Started scout-3 \(scout\)\. You will be told as each one ends/);
  assert.match(topSession(), /"customType":"calliopi-agent"/);

  // /cl-agents: the list in a floating window, an agent's last screen, back, closed
  await type('/cl-agents');
  await until('list', () => /서브에이전트 · 실행 중 0 · 끝남 3/.test(screen()));
  assert.match(screen(), /▸├─ ✓ scout-1 · 완료/);
  top.write('\r');
  await until('its screen', () => /✓ scout-1 · scout · 완료/.test(screen()) && /ctrl\+\]: 목록 · 끝난 화면/.test(screen()));
  top.write('\x1d'); // ctrl+]
  await until('back to the list', () => /Enter: 화면/.test(screen()));
  top.write('\x1b');
  await until('closed', () => !/서브에이전트 · 실행 중/.test(screen()));

  // context summary (the role default): the delegation summarizes the conversation, and the child
  // gets its slice of that summary before its task
  await type('Once more, with background');
  await until('briefed reply', () => /Briefed scout done\./.test(screen()));
  const third = agents().find(r => r.meta.id === 'scout-4')!;
  assert.equal(third.meta.call.context, 'summary');
  assert.equal(readAgent(third.dir)!.status!.briefing!.how, 'first');
  assert.match(topSession(), /"customType":"calliopi-summary"[^\n]*Find login fast/); // the delegation summary, kept in the parent's session
  const childEntries = sessionOf(third);
  const briefing = childEntries.find(e => e.type === 'custom_message' && e.customType === 'calliopi-briefing');
  assert.ok(briefing, 'briefed');
  assert.match(briefing.content, /Find login fast[\s\S]*Scouts first/);
  assert.doesNotMatch(briefing.content, /## Progress/); // a read-only scout does not get Progress
  const firstUser = childEntries.findIndex(e => e.type === 'message' && e.message.role === 'user');
  assert.ok(childEntries.indexOf(briefing) < firstUser, 'background before the task');
});
