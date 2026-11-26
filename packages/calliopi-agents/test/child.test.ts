import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DEFAULT_BUDGET, FILES, createAgent, decodeRequests, postInbox, readAgent, type AgentMeta, type AgentRecord } from '@calliopi/core/agents';
import { briefingMessage, childSystemPrompt, taskMessage } from '#lib/contract.ts';
import { AGENT_DIR_ENV, PROMPT_FILE, childCommand, piInvocation, prepareSession } from '#lib/launch.ts';
import { installChild, spent } from '#lib/child.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..');
const tmp = (t: { after: (fn: () => void) => void }) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'calliopi-agents-child-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const baseMeta = (cwd: string, over: Partial<AgentMeta['call']> = {}): Omit<AgentMeta, 'id' | 'session'> => ({
  root: 'top-session', parent: null, depth: 1, role: 'scout', model: 'faux/demo', modelSource: 'caller', tools: ['read'], cwd, createdAt: Date.now(),
  call: { task: 'Find where login is defined', done: 'The file and line are named', budget: { ...DEFAULT_BUDGET, turns: 6 }, context: 'none', background: false, ...over },
  pane: null,
});

test('contract: the system prompt makes it a subagent that ends with finish; the task carries done and budget', () => {
  const meta = { ...baseMeta('/r'), id: 'scout-1', session: '' } as AgentMeta;
  const system = childSystemPrompt(meta, 'You scout.');
  assert.match(system, /role "scout", id "scout-1", depth 1/);
  assert.match(system, /call the finish tool with status "done", "partial" or "blocked"/);
  assert.match(system, /\n\nYou scout\.$/);
  assert.equal(taskMessage(meta), 'Task: Find where login is defined\nDone when: The file and line are named\nBudget: 턴 6 · 15분 · 300k.\nWhen it is done or blocked, call finish.');
  assert.match(briefingMessage('## Goal\nX', false), /the task itself is in the next message\.\n\n<background>\n## Goal\nX\n<\/background>$/);
  assert.match(briefingMessage('X', true), /arrived after you started/);
  assert.equal(spent({ input: 100, output: 20, cacheWrite: 5 }), 125);
  assert.equal(spent(undefined), 0);
});

test('launch: a session file naming the parent, and a pane command that carries the environment, not the task', t => {
  const root = tmp(t);
  const { dir, meta } = createAgent(root, baseMeta(root));
  const file = prepareSession(dir, meta, '/sessions/top.jsonl', new Date('2026-11-26T07:00:00.000Z'));
  assert.equal(path.basename(file), '2026-11-26T07-00-00-000Z_scout-1.jsonl');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { type: 'session', version: 3, id: 'scout-1', timestamp: '2026-11-26T07:00:00.000Z', cwd: root, parentSession: '/sessions/top.jsonl' });
  assert.throws(() => prepareSession(dir, meta, undefined, new Date('2026-11-26T07:00:00.000Z'))); // never overwrites
  const cmd = childCommand(dir, { ...meta, thinking: 'low' }, { pi: ['node', '/pi/cli.js'], extensions: ['/x/agents.ts'], env: { DEMO_SCENARIO: '/s.yaml' } }, { PI_CODING_AGENT_DIR: '/agent', HOME: '/h' });
  assert.deepEqual(cmd, ['env', `${AGENT_DIR_ENV}=${dir}`, 'PI_CODING_AGENT_DIR=/agent', 'DEMO_SCENARIO=/s.yaml', 'node', '/pi/cli.js',
    '--session-dir', dir, '--session-id', 'scout-1', '-e', '/x/agents.ts', '--model', 'faux/demo', '--thinking', 'low', '--tools', 'read,finish',
    '--append-system-prompt', path.join(dir, PROMPT_FILE)]);
  assert.ok(!cmd.some(a => a.includes('Find where login'))); // the child submits its task itself
  assert.deepEqual(piInvocation(['node', fileURLToPath(import.meta.url)], '/usr/bin/node'), ['/usr/bin/node', fileURLToPath(import.meta.url)]);
  assert.deepEqual(piInvocation(['node', '/nope.js'], '/usr/bin/node'), ['pi']);
});

test('requests: every provider payload is appended as a delta (the faux model sends none, so handlers are driven directly)', t => {
  const root = tmp(t);
  const { dir } = createAgent(root, baseMeta(root));
  const handlers = new Map<string, (event: unknown, ctx?: unknown) => unknown>();
  const fake = { on: (name: string, fn: (event: unknown) => unknown) => handlers.set(name, fn), registerTool: () => {}, setSessionName: () => {}, sendMessage: () => {}, sendUserMessage: () => {} };
  installChild(fake as never, dir);
  const p1 = { model: 'm', system: 'S'.repeat(2000), messages: [{ role: 'user', content: 'Task '.repeat(200) }] };
  const p2 = { ...p1, messages: [...p1.messages, { role: 'assistant', content: 'ok' }] };
  handlers.get('before_provider_request')!({ type: 'before_provider_request', payload: p1 });
  handlers.get('before_provider_request')!({ type: 'before_provider_request', payload: p2 });
  const text = fs.readFileSync(path.join(dir, FILES.requests), 'utf8');
  assert.equal(text.trim().split('\n').length, 2);
  assert.ok(text.trim().split('\n')[1]!.length < JSON.stringify(p2).length); // the second keeps only the new message
  assert.deepEqual(decodeRequests(text).map(r => r.payload), [p1, p2]);
  assert.equal(fs.statSync(path.join(dir, FILES.requests)).mode & 0o777, 0o600);
});

test('contract reminder: added at the end of every request once the task is sent, never stored', async t => {
  const root = tmp(t);
  const { dir } = createAgent(root, baseMeta(root)); // context none: the task goes at once
  const handlers = new Map<string, (event: unknown, ctx?: unknown) => unknown>();
  const sent: string[] = [];
  const fake = { on: (name: string, fn: (event: unknown) => unknown) => handlers.set(name, fn), registerTool: () => {}, setSessionName: () => {}, sendMessage: () => {}, sendUserMessage: (text: string) => sent.push(text) };
  installChild(fake as never, dir);
  const before = handlers.get('context')!({ type: 'context', messages: [] });
  assert.equal(before, undefined); // nothing before the task
  await handlers.get('session_start')!({ type: 'session_start' }, { ui: { setStatus: () => {}, notify: () => {} }, isIdle: () => true, abort: () => {} });
  assert.match(sent[0]!, /^Task: Find where login is defined/);
  const messages = [{ role: 'user', content: [{ type: 'text', text: 'Task' }], timestamp: 1 }];
  const out = handlers.get('context')!({ type: 'context', messages }) as { messages: { role: string; content: { text: string }[] }[] };
  assert.equal(out.messages.length, 2);
  assert.equal(messages.length, 1); // the stored messages are not touched
  assert.match(out.messages[1]!.content[0]!.text, /^\[Subagent contract\] Task: Find where login is defined\nDone when: The file and line are named\nBudget used: 턴 0\/6 · 0\/15분 · 0\/300k\.\nStay within the task; when it is done or blocked, call finish\.$/);
  handlers.get('session_shutdown')!({ type: 'session_shutdown' });
});

// A real child Pi in a private tmux server, answering with the faux model of the demo harness.
const hasTmux = spawnSync('tmux', ['-V']).status === 0;
test('child Pi: background before task, finish ends it, inbox stop, reminder then unanswered', { skip: !hasTmux, timeout: 120_000 }, async t => {
  const root = tmp(t), agentHome = tmp(t), project = tmp(t);
  fs.writeFileSync(path.join(project, 'login.ts'), 'export function login() {}\n');
  const socket = `calliopi-agents-${process.pid}`;
  const tmux = (...args: string[]) => spawnSync('tmux', ['-L', socket, '-f', '/dev/null', ...args], { encoding: 'utf8' });
  t.after(() => tmux('kill-server'));
  assert.equal(tmux('new-session', '-d', '-x', '140', '-y', '40', 'sleep 300').status, 0);
  const until = async (what: string, ok: () => boolean, ms = 40_000) => {
    for (const end = Date.now() + ms; Date.now() < end && !ok();) await new Promise(r => setTimeout(r, 200));
    assert.ok(ok(), what);
  };
  const scenario = (name: string, replies: unknown[]) => {
    const file = path.join(root, `${name}.yaml`);
    fs.writeFileSync(file, JSON.stringify({ title: name, turns: replies.map(reply => ({ prompt: 'x', reply })) }));
    return file;
  };
  const start = (record: AgentRecord, scenarioFile: string) => {
    fs.writeFileSync(path.join(record.dir, PROMPT_FILE), childSystemPrompt(record.meta, 'You scout.'));
    prepareSession(record.dir, record.meta, '/sessions/top.jsonl');
    const cmd = childCommand(record.dir, record.meta, {
      pi: [process.execPath, path.join(repo, 'node_modules/@earendil-works/pi-coding-agent/dist/cli.js')],
      extensions: [path.join(repo, 'demo/faux-extension.ts'), path.join(repo, 'packages/calliopi-agents/extensions/agents.ts')],
      env: { DEMO_SCENARIO: scenarioFile, PI_CODING_AGENT_DIR: agentHome },
    });
    assert.equal(tmux('new-window', '-d', '-c', project, '--', ...cmd).status, 0);
  };
  const session = (record: AgentRecord) => fs.readdirSync(record.dir).find(f => f.endsWith('.jsonl') && f !== FILES.requests)!;
  const entries = (record: AgentRecord) => fs.readFileSync(path.join(record.dir, session(record)), 'utf8').trim().split('\n').map(l => JSON.parse(l));

  // 1. a briefing that is already there comes first, then the task; finish ends the work
  const a = createAgent(root, baseMeta(project, { context: 'summary' }));
  postInbox(a.dir, { id: 'brief-1', kind: 'briefing', text: '## Goal\nShip login retries', at: Date.now() });
  start(a, scenario('finish', [[{ tool: 'read', args: { path: 'login.ts' } }, { tool: 'finish', args: { status: 'done', summary: 'login is in login.ts:1', evidence: 'read login.ts' } }]]));
  await until('a finished', () => !!readAgent(a.dir)?.result);
  const ra = readAgent(a.dir)!;
  assert.equal(ra.result!.status, 'done');
  assert.equal(ra.result!.summary, 'login is in login.ts:1');
  assert.equal(ra.result!.evidence, 'read login.ts');
  assert.equal(ra.status!.briefing!.how, 'first');
  assert.ok(ra.status!.turns >= 1 && ra.status!.tokens > 0);
  const ea = entries(a);
  assert.equal(ea[0].parentSession, '/sessions/top.jsonl');
  const order = ea.flatMap(e => e.type === 'custom_message' ? ['briefing'] : e.type === 'message' && e.message.role === 'user' ? ['task'] : []);
  assert.deepEqual(order.slice(0, 2), ['briefing', 'task']);

  // 2. stopped from the inbox while it works
  const b = createAgent(root, { ...baseMeta(project), tools: ['bash'] });
  start(b, scenario('slow', [[{ tool: 'bash', args: { command: 'sleep 30' } }]]));
  await until('b running', () => readAgent(b.dir)?.status?.activity === 'bash');
  postInbox(b.dir, { id: 'stop-1', kind: 'stop', text: '', at: Date.now() });
  await until('b stopped', () => readAgent(b.dir)?.result?.status === 'stopped');

  // 3. no finish: reminded once, then reported as unanswered with its last words
  const c = createAgent(root, baseMeta(project));
  start(c, scenario('chatty', [[{ text: 'I think it is in login.ts' }], [{ text: 'Still in login.ts' }]]));
  await until('c unanswered', () => !!readAgent(c.dir)?.result);
  const rc = readAgent(c.dir)!.result!;
  assert.equal(rc.status, 'unanswered');
  assert.equal(rc.summary, 'Still in login.ts');
  assert.ok(entries(c).some(e => e.type === 'message' && JSON.stringify(e.message.content).includes('You stopped without calling finish')));
});
