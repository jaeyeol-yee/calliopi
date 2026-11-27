import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_BUDGET, FILES, createAgent, decodeRequests, postInbox, readAgent, writeStatus, type AgentMeta, type AgentRecord } from '@calliopi/core/agents';
import { briefingMessage, childSystemPrompt, taskMessage } from '#lib/contract.ts';
import { AGENT_DIR_ENV, PROMPT_FILE, childSpawn, piInvocation, prepareSession } from '#lib/launch.ts';
import { Fleet, closeOrphans } from '#lib/fleet.ts';
import { isChildOf } from '#extensions/agents.ts';
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

test('launch: a session file naming the parent, and a command that carries the agent directory in its environment, not the task', t => {
  const root = tmp(t);
  const { dir, meta } = createAgent(root, baseMeta(root));
  const file = prepareSession(dir, meta, '/sessions/top.jsonl', new Date('2026-11-26T07:00:00.000Z'));
  assert.equal(path.basename(file), '2026-11-26T07-00-00-000Z_scout-1.jsonl');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { type: 'session', version: 3, id: 'scout-1', timestamp: '2026-11-26T07:00:00.000Z', cwd: root, parentSession: '/sessions/top.jsonl' });
  assert.throws(() => prepareSession(dir, meta, undefined, new Date('2026-11-26T07:00:00.000Z'))); // never overwrites
  const spawn = childSpawn(dir, { ...meta, thinking: 'low' }, { pi: ['node', '/pi/cli.js'], extensions: ['/x/agents.ts'], env: { EXTRA: '1' } }, { HOME: '/h', DEMO_CHILD_SCENARIO: '/c.yaml' });
  assert.equal(spawn.command, 'node');
  assert.deepEqual(spawn.args, ['/pi/cli.js', '--session-dir', dir, '--session-id', 'scout-1', '-e', '/x/agents.ts', '--model', 'faux/demo', '--thinking', 'low', '--tools', 'read,finish', '--no-mcp',
    '--append-system-prompt', path.join(dir, PROMPT_FILE)]);
  assert.deepEqual(spawn.env, { HOME: '/h', DEMO_CHILD_SCENARIO: '/c.yaml', [AGENT_DIR_ENV]: dir, DEMO_SCENARIO: '/c.yaml', EXTRA: '1' }); // the parent's environment, inherited
  assert.ok(!spawn.args.some(a => a.includes('Find where login'))); // the child submits its task itself
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

test('idle only when nothing runs; a steer that comes before the task waits for it', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: 1_000_000 });
  const root = tmp(t);
  const handlers = new Map<string, (event: unknown, ctx?: unknown) => unknown>();
  const sent: string[] = [];
  const fake = {
    on: (name: string, fn: (event: unknown) => unknown) => handlers.set(name, fn), registerTool: () => {}, setSessionName: () => {},
    sendMessage: (m: { content: string }) => sent.push(`briefing:${/<background>\n([^\n]*)/.exec(m.content)?.[1]}`), sendUserMessage: (text: string) => sent.push(text.split('\n')[0]!),
  };
  const ctx = { ui: { setStatus: () => {}, notify: () => {} }, isIdle: () => true, abort: () => {} };
  const { dir } = createAgent(root, { ...baseMeta(root, { context: 'summary' }), call: { ...baseMeta(root).call, context: 'summary', budget: { ...DEFAULT_BUDGET, idleMinutes: 1 } } });
  postInbox(dir, { id: 'steer-1', kind: 'steer', text: 'Also check logout', at: 1 });
  installChild(fake as never, dir);
  await handlers.get('session_start')!({ type: 'session_start' }, ctx);
  t.mock.timers.tick(1000);
  assert.deepEqual(sent, []); // the steer waits: the task has not gone yet
  postInbox(dir, { id: 'brief-1', kind: 'briefing', text: '## Goal\nShip', at: 2 });
  t.mock.timers.tick(1000);
  t.mock.timers.tick(200);
  assert.equal(sent[0], 'briefing:## Goal'); // the briefing came after the steer, yet goes first
  assert.equal(sent[1], 'Task: Find where login is defined');
  t.mock.timers.tick(1000);
  assert.equal(sent[2], 'Message from the agent that delegated this task:'); // then the steer, in order

  // a long tool call is not idleness; once it ends, the idle clock runs again
  handlers.get('tool_execution_start')!({ type: 'tool_execution_start', toolName: 'bash' });
  t.mock.timers.tick(3 * 60_000);
  assert.equal(readAgent(dir)!.result, undefined);
  handlers.get('tool_execution_end')!({ type: 'tool_execution_end' });
  t.mock.timers.tick(61_000);
  assert.equal(readAgent(dir)!.result!.status, 'idle');
});

test('a child whose own subagents still run is neither reminded nor ended, nor idle', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: 1_000_000 });
  const root = tmp(t);
  const { dir } = createAgent(root, { ...baseMeta(root), call: { ...baseMeta(root).call, budget: { ...DEFAULT_BUDGET, idleMinutes: 1 } } });
  const handlers = new Map<string, (event: unknown, ctx?: unknown) => unknown>();
  const sent: string[] = [];
  const fake = { on: (name: string, fn: (event: unknown) => unknown) => handlers.set(name, fn), registerTool: () => {}, setSessionName: () => {}, sendMessage: () => {}, sendUserMessage: (text: string) => sent.push(text.split('\n')[0]!) };
  let busy = true;
  installChild(fake as never, dir, () => busy);
  await handlers.get('session_start')!({ type: 'session_start' }, { ui: { setStatus: () => {}, notify: () => {} }, isIdle: () => true, abort: () => {}, shutdown: () => {} });
  handlers.get('agent_end')!({ type: 'agent_end', messages: [] }); // it delegated in the background and stopped
  t.mock.timers.tick(5 * 60_000);
  assert.deepEqual(sent, ['Task: Find where login is defined']); // no reminder: results are on their way
  assert.equal(readAgent(dir)!.result, undefined); // and not idle
  busy = false; // they have reported
  handlers.get('agent_end')!({ type: 'agent_end', messages: [] });
  assert.match(sent[1]!, /^You stopped without calling finish/);
  handlers.get('session_shutdown')!({ type: 'session_shutdown' });
});

// Real child Pis in pseudo-terminals of this test process (lib/fleet.ts, as the parent runs them),
// answering with the faux model of the demo harness.
test('child Pi: background before task, finish ends it, inbox stop, reminder then unanswered', { timeout: 120_000 }, async t => {
  const root = tmp(t), agentHome = tmp(t), project = tmp(t);
  fs.writeFileSync(path.join(project, 'login.ts'), 'export function login() {}\n');
  const fleet = new Fleet();
  t.after(() => fleet.dispose());
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
    return fleet.start(record, childSpawn(record.dir, record.meta, {
      pi: [process.execPath, path.join(repo, 'node_modules/@earendil-works/pi-coding-agent/dist/cli.js')],
      extensions: [path.join(repo, 'demo/faux-extension.ts'), path.join(repo, 'packages/calliopi-agents/extensions/agents.ts')],
      env: { DEMO_SCENARIO: scenarioFile, PI_CODING_AGENT_DIR: agentHome },
    }));
  };
  const session = (record: AgentRecord) => fs.readdirSync(record.dir).find(f => f.endsWith('.jsonl') && f !== FILES.requests)!;
  const entries = (record: AgentRecord) => fs.readFileSync(path.join(record.dir, session(record)), 'utf8').trim().split('\n').map(l => JSON.parse(l));

  // 1. a briefing that is already there comes first, then the task; finish ends the work and the Pi
  const a = createAgent(root, baseMeta(project, { context: 'summary' }));
  postInbox(a.dir, { id: 'brief-1', kind: 'briefing', text: '## Goal\nShip login retries', at: Date.now() });
  const childA = await start(a, scenario('finish', [[{ tool: 'read', args: { path: 'login.ts' } }, { tool: 'finish', args: { status: 'done', summary: 'login is in login.ts:1', evidence: 'read login.ts' } }]]));
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
  await until('a exited', () => !!childA.exited); // its Pi quits once it has reported
  const buffer = childA.pane.terminal.buffer.active;
  const screen = Array.from({ length: buffer.length }, (_, i) => buffer.getLine(i)?.translateToString(true) ?? '').join('\n');
  assert.match(screen, /finish/); // the last screen stays to be looked at

  // 2. stopped while it works
  const b = createAgent(root, { ...baseMeta(project), tools: ['bash'] });
  await start(b, scenario('slow', [[{ tool: 'bash', args: { command: 'sleep 30' } }]]));
  await until('b running', () => readAgent(b.dir)?.status?.activity === 'bash');
  fleet.stop(b.meta.id);
  await until('b stopped', () => readAgent(b.dir)?.result?.status === 'stopped');

  // 3. no finish: reminded once, then reported as unanswered with its last words
  const c = createAgent(root, baseMeta(project));
  await start(c, scenario('chatty', [[{ text: 'I think it is in login.ts' }], [{ text: 'Still in login.ts' }]]));
  await until('c unanswered', () => !!readAgent(c.dir)?.result);
  const rc = readAgent(c.dir)!.result!;
  assert.equal(rc.status, 'unanswered');
  assert.equal(rc.summary, 'Still in login.ts');
  assert.ok(entries(c).some(e => e.type === 'message' && JSON.stringify(e.message.content).includes('You stopped without calling finish')));

  // 4. a child whose Pi dies without a result is recorded, so nobody waits for it
  const d = createAgent(root, { ...baseMeta(project), tools: ['bash'] });
  const childD = await start(d, scenario('slow', [[{ tool: 'bash', args: { command: 'sleep 30' } }]]));
  await until('d running', () => readAgent(d.dir)?.status?.activity === 'bash');
  childD.pane.stop(); // killed outright
  await until('d recorded', () => !!readAgent(d.dir)?.result);
  assert.equal(readAgent(d.dir)!.result!.status, 'stopped');
});

test('a Pi that only inherited CALLIOPI_AGENT_DIR is not the child; orphans of an ended Pi are closed with their usage', t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'calliopi-orphan-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const r = createAgent(root, { root: 'top', parent: null, depth: 1, role: 'scout', model: 'm', modelSource: 'inherit', tools: [], cwd: root, createdAt: 1,
    call: { task: 't', budget: DEFAULT_BUDGET, context: 'none', background: true }, pane: null } as never);
  assert.equal(isChildOf(r.dir, ['node', 'pi', '--session-id', r.meta.id]), true);
  assert.equal(isChildOf(r.dir, ['node', 'pi']), false);
  assert.equal(isChildOf(r.dir, ['node', 'pi', '--session-id', 'other']), false);
  writeStatus(r.dir, { state: 'running', turns: 3, tokens: 500, startedAt: Date.now(), updatedAt: Date.now(), pid: 999_999 });
  const fresh = createAgent(root, { ...readAgent(r.dir)!.meta, createdAt: Date.now() } as never); // no status yet, just made: maybe another Pi's
  assert.deepEqual(closeOrphans([readAgent(r.dir)!, readAgent(fresh.dir)!], new Fleet()), [r.meta.id]);
  assert.deepEqual([readAgent(r.dir)!.result!.status, readAgent(r.dir)!.result!.usage.tokens], ['stopped', 500]);
});
