import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { listAgents, readAgent, type AgentRecord } from '@calliopi/core/agents';
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

// A top Pi and its children in a private tmux server, all answering with the demo's faux model.
const hasTmux = spawnSync('tmux', ['-V']).status === 0;
test('top Pi delegates: foreground returns the result as the tool output; background wakes the model when it ends', { skip: !hasTmux, timeout: 180_000 }, async t => {
  const agentHome = tmp(t), project = tmp(t), scenarios = tmp(t);
  fs.writeFileSync(path.join(project, 'login.ts'), 'export function login() {}\n');
  const socket = `calliopi-agents-parent-${process.pid}`;
  const tmux = (...args: string[]) => spawnSync('tmux', ['-L', socket, '-f', '/dev/null', ...args], { encoding: 'utf8' });
  t.after(() => tmux('kill-server'));
  const until = async (what: string, ok: () => boolean, ms = 60_000) => {
    for (const end = Date.now() + ms; Date.now() < end && !ok();) await new Promise(r => setTimeout(r, 250));
    assert.ok(ok(), what);
  };
  const scenario = (name: string, replies: unknown[]) => {
    const file = path.join(scenarios, `${name}.yaml`);
    fs.writeFileSync(file, JSON.stringify({ title: name, turns: replies.map(reply => ({ prompt: 'x', reply })) }));
    return file;
  };
  const parent = scenario('parent', [
    [{ tool: 'subagent', args: { tasks: [{ role: 'scout', task: 'Find where login is defined', done: 'The file is named', context: 'none' }] } }, { text: 'The scout found it.' }],
    [{ tool: 'subagent', args: { background: true, tasks: [{ role: 'scout', task: 'Look again', context: 'none' }] } }, { text: 'Started; waiting.' }],
    [{ text: 'Background scout reported back.' }],
  ]);
  const child = scenario('child', [[{ tool: 'read', args: { path: 'login.ts' } }, { tool: 'finish', args: { status: 'done', summary: 'login is in login.ts:1', evidence: 'read login.ts' } }]]);
  const pi = [process.execPath, path.join(repo, 'node_modules/@earendil-works/pi-coding-agent/dist/cli.js'),
    '-e', path.join(repo, 'demo/faux-extension.ts'), '-e', path.join(repo, 'packages/calliopi-agents/extensions/agents.ts'), '--model', 'faux/demo'];
  assert.equal(tmux('new-session', '-d', '-x', '150', '-y', '45', '-c', project, '--', 'env', `PI_CODING_AGENT_DIR=${agentHome}`, `DEMO_SCENARIO=${parent}`, `DEMO_CHILD_SCENARIO=${child}`, ...pi).status, 0);
  const screen = () => tmux('capture-pane', '-p', '-t', '0.0').stdout;
  await until('pi up', () => /faux/.test(screen()), 40_000);

  const registry = registryRoot(agentHome);
  const agents = (): AgentRecord[] => {
    let roots: string[] = [];
    try { roots = fs.readdirSync(registry); } catch { return []; }
    return roots.flatMap(r => listAgents(registry, r));
  };

  // foreground: the tool waits, then hands the child's result to the model
  tmux('send-keys', '-t', '0.0', 'Where is login?', 'Enter');
  await until('foreground reply', () => /The scout found it\./.test(screen()));
  const [first] = agents();
  assert.ok(first, 'a record');
  assert.deepEqual([first.meta.id, first.meta.parent, first.meta.depth, first.meta.role, first.meta.modelSource], ['scout-1', null, 1, 'scout', 'inherit']);
  assert.equal(first.result!.status, 'done');
  assert.deepEqual(first.meta.tools.sort(), ['bash', 'find', 'grep', 'ls', 'read']);
  assert.ok(first.meta.pane?.pane, 'opened in a pane');
  const childSession = fs.readdirSync(first.dir).find(f => /_scout-1\.jsonl$/.test(f))!;
  const header = JSON.parse(fs.readFileSync(path.join(first.dir, childSession), 'utf8').split('\n')[0]!);
  assert.match(header.parentSession, new RegExp(`${first.meta.root}\\.jsonl$`)); // the child's session names the top Pi's
  const parentSession = fs.readFileSync(header.parentSession, 'utf8');
  assert.match(parentSession, /Subagent \\"scout-1\\" \(role scout, model faux\/demo\) ended: done\./); // the tool result
  assert.match(parentSession, /login is in login\.ts:1/);
  assert.equal(tmux('list-windows').stdout.trim().split('\n').length, 2, 'the child ran in a background window');

  // background: the tool returns at once; when the child ends, the model is woken without a prompt
  tmux('send-keys', '-t', '0.0', 'Look again in the background', 'Enter');
  await until('background reply', () => /Background scout reported back\./.test(screen()));
  const second = agents().find(r => r.meta.id === 'scout-2')!;
  assert.equal(readAgent(second.dir)!.result!.status, 'done');
  const after = fs.readFileSync(header.parentSession, 'utf8');
  assert.match(after, /Started scout-2 \(scout\) in the background/);
  assert.match(after, /"customType":"calliopi-agent"/);
});
