#!/usr/bin/env node
// In-memory mock of the Cursor Cloud Agents v1 endpoints the harness uses.
// A prompt may embed a status script, e.g. "fix x [script:RUNNING,WAITING_FOR_BACKGROUND_WORK,FINISHED]";
// each listRuns/getRun of that agent advances one step. "[pr]" makes it report a PR.
// Env/opts: MOCK_429_EVERY (every Nth request gets 429 Retry-After:1), MOCK_USAGE_403=1, MOCK_STREAM_410=1.
import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';

interface MockRun {
  id: string;
  script: string[];
  step: number;
  status: string;
  createdAt: string;
  updatedAt: string;
  durationMs?: number;
  result?: string;
  resultText?: string;
  ackText?: string;
  fanoutKey?: string;
}
interface MockAgent {
  id: string;
  name?: string;
  createdAt: string;
  updatedAt: string;
  pr: boolean;
  num: number;
  git: { branches: { repoUrl: string; branch: string; prUrl: string }[] } | null;
  runs: MockRun[];
  crashed?: boolean;
}
export interface MockState {
  broke: boolean;
  lastModel?: unknown;
  automation: null | {
    automationId: string;
    name: string;
    enabled: boolean;
    workflow: {
      triggers?: unknown[];
      prompts?: { prompt?: string }[];
      modelSelection?: { modelId?: string };
      gitConfig?: { repo?: string; branch?: string };
    };
  };
  updates?: number;
  webhookPosts?: number;
  webhookFail?: boolean;
  /** Automation prompt text in effect at each webhook POST (what Cursor would start the run from). */
  promptsAtPost?: string[];
  /** Simulate Cursor using another prompt than the staged one (ack mismatch). */
  forcePromptKey?: string;
  /** Simulate an agent that never writes the ack line. */
  noAck?: boolean;
  /** Make UpdateAutomation fail (prompt swap failure). */
  updateFail?: boolean;
}
export interface MockHandle {
  server: http.Server;
  agents: Map<string, MockAgent>;
  stats: { total: number; byRoute: Record<string, number>; rateLimited: number };
  mockState: MockState;
  url: string;
  close: () => Promise<void>;
}

export function startMock({ port = 0, key = 'test-key', every429 = 0, usage403 = false, stream410 = false }: {
  port?: number; key?: string; every429?: number; usage403?: boolean; stream410?: boolean;
} = {}): Promise<MockHandle> {
  const agents = new Map<string, MockAgent>();
  const mockState: MockState = { broke: false, automation: null };
  const stats = { total: 0, byRoute: {} as Record<string, number>, rateLimited: 0 };
  let n = 0;

  const send = (res: ServerResponse, code: number, body?: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(code, { 'content-type': 'application/json', ...headers });
    res.end(body === undefined ? '' : JSON.stringify(body));
  };
  const err = (res: ServerResponse, code: number, c: string, m: string, h?: Record<string, string>) => send(res, code, { error: { code: c, message: m } }, h);

  const advance = (ag: MockAgent) => {
    const run = ag.runs[0];
    if (run.step < run.script.length - 1) run.step += 1;
    run.status = run.script[run.step];
    run.updatedAt = new Date().toISOString();
    if (['FINISHED', 'ERROR', 'CANCELLED', 'EXPIRED'].includes(run.status)) {
      run.durationMs ??= 1234 * (run.step + 1);
      run.result ??= run.resultText || `summary for ${ag.name}: ${run.status.toLowerCase()}`;
      if (ag.pr && run.status === 'FINISHED') ag.git = { branches: [{ repoUrl: 'github.com/org/repo', branch: `cursor/${ag.id.slice(3, 11)}`, prUrl: `https://github.com/org/repo/pull/${ag.num}` }] };
    }
    ag.updatedAt = run.updatedAt;
  };
  const runView = (ag: MockAgent, run: MockRun) => ({
    id: run.id, agentId: ag.id, status: run.status, createdAt: run.createdAt, updatedAt: run.updatedAt,
    ...(run.durationMs != null ? { durationMs: run.durationMs } : {}),
    ...(run.result ? { result: run.result } : {}),
    ...(ag.git ? { git: ag.git } : {}),
  });
  const summary = (ag: MockAgent) => ({ id: ag.id, name: ag.name, status: 'ACTIVE', env: { type: 'cloud' }, url: `https://cursor.com/agents/${ag.id}`, createdAt: ag.createdAt, updatedAt: ag.updatedAt, latestRunId: ag.runs[0].id });

  const server = http.createServer(async (req: IncomingMessage, res: ServerResponse) => {
    stats.total += 1; n += 1;
    const url = new URL(req.url as string, 'http://x');
    const route = `${req.method} ${url.pathname.replace(/bc-[^/]+/, ':id').replace(/run-[^/]+/, ':run')}`;
    stats.byRoute[route] = (stats.byRoute[route] || 0) + 1;
    if (!url.pathname.startsWith('/automations/webhook/') && !url.pathname.startsWith('/aiserver.v1.') && url.pathname !== '/auth/exchange_user_api_key' && req.headers.authorization !== `Bearer ${key}`) return send(res, 401, { code: 'error', message: 'Invalid User API Key' });
    if (every429 && n % every429 === 0) { stats.rateLimited += 1; return err(res, 429, 'rate_limit_exceeded', 'slow down', { 'retry-after': '1' }); }
    let body = '';
    for await (const c of req) body += c;
    const json = body ? JSON.parse(body) : null;
    const parts = url.pathname.split('/').filter(Boolean); // v1 agents :id runs :run ...
    const ag = parts[2] ? agents.get(parts[2]) : null;

    if (req.method === 'POST' && url.pathname === '/v1/agents') {
      if (!json?.prompt?.text) return err(res, 400, 'validation_error', 'prompt.text required');
      if (/\[reject\]/.test(json.prompt.text)) return err(res, 400, 'validation_error', 'rejected by mock');
      if (mockState.broke) return err(res, 400, 'usage_limit_exceeded', 'Your prepaid balance is used up.');
      if (json.model && !['auto', 'default', 'grok-4.7', 'composer-2.5', 'composer'].includes(json.model.id)) return err(res, 400, 'invalid_model', 'bad model');
      mockState.lastModel = json.model ?? null;
      const id = json.agentId || `bc-${randomUUID()}`;
      if (agents.has(id)) return err(res, 409, 'agent_id_conflict', 'exists');
      const script = (/\[script:([A-Z_,]+)\]/.exec(json.prompt.text)?.[1] || 'CREATING,RUNNING,FINISHED').split(',');
      const now = new Date().toISOString();
      const a: MockAgent = {
        id, name: json.name, createdAt: now, updatedAt: now, pr: /\[pr\]/.test(json.prompt.text), num: agents.size + 1, git: null,
        runs: [{ id: `run-${randomUUID()}`, script, step: 0, status: script[0], createdAt: now, updatedAt: now }],
      };
      agents.set(id, a);
      if (/\[crash-after-create\]/.test(json.prompt.text) && !a.crashed) { a.crashed = true; req.socket.destroy(); return; }
      return send(res, 201, { agent: { ...summary(a), repos: json.repos || [] }, run: runView(a, a.runs[0]) });
    }
    // Official automation CRUD surface (as used by cursor/terraform-provider-cursor)
    if (req.method === 'POST' && url.pathname === '/auth/exchange_user_api_key') return send(res, 200, { accessToken: 'session-token' });
    if (req.method === 'POST' && url.pathname.startsWith('/aiserver.v1.AutomationsService/')) {
      const m = url.pathname.split('/').pop();
      mockState.automation ??= { automationId: 'auto-1', name: 'CallioPiAutomation', enabled: true,
        workflow: { triggers: [{ webhook: {} }], prompts: [{ prompt: 'p0' }], modelSelection: { modelId: 'grok-4.7' }, gitConfig: { repo: 'https://github.com/o/r', branch: 'main' } } };
      if (m === 'GetAutomation') return send(res, 200, { workflow: { workflow: mockState.automation } });
      if (m === 'UpdateAutomation' && mockState.updateFail) return err(res, 500, 'internal', 'update failed');
      if (m === 'UpdateAutomation') { mockState.updates = (mockState.updates || 0) + 1; if (json.workflow) mockState.automation.workflow = json.workflow; return send(res, 200, { workflow: { workflow: mockState.automation } }); }
      return err(res, 404, 'not_found', m as string);
    }
    if (req.method === 'POST' && url.pathname.startsWith('/automations/webhook/')) {
      // Documented webhook trigger: Bearer <sender key>, JSON body → {success, backgroundComposerId}
      if (req.headers.authorization !== 'Bearer hook-key') return send(res, 401, { error: 'bad sender key' });
      const payload = json || {};
      mockState.webhookPosts = (mockState.webhookPosts || 0) + 1;
      if (mockState.webhookFail) { req.socket.destroy(); return; }
      const id = `bc-${randomUUID()}`;
      const script = (/\[script:([A-Z_,]+)\]/.exec(payload.instruction || payload.task || '')?.[1] || 'RUNNING,FINISHED').split(',');
      const now = new Date().toISOString();
      const a: MockAgent = { id, name: 'Calliopi webhook task', createdAt: now, updatedAt: now, pr: false, num: agents.size + 1, git: null,
        runs: [{ id: `run-${randomUUID()}`, script, step: 0, status: script[0], createdAt: now, updatedAt: now,
          result: undefined, fanoutKey: payload.fanout_key }] };
      // Like Cursor: the run starts from the automation prompt in effect NOW, plus the webhook body.
      const prompt = mockState.automation?.workflow.prompts?.[0]?.prompt ?? '';
      (mockState.promptsAtPost ??= []).push(prompt);
      const promptKey = mockState.forcePromptKey ?? /fanout_key="([^"]+)"/.exec(prompt)?.[1] ?? 'none';
      const ack = mockState.noAck ? '' : `<calliopi_ack body_key="${payload.fanout_key}" prompt_key="${promptKey}"/>\n`;
      a.runs[0].ackText = ack;
      a.runs[0].resultText = `${ack}<calliopi_result fanout_key="${payload.fanout_key}" agent_id="${id}">\n<understood>${payload.summary || payload.label}</understood>\n</calliopi_result>\n\ndone: ${payload.label}`;
      agents.set(id, a);
      return send(res, 200, { success: true, backgroundComposerId: id });
    }
    if (req.method === 'GET' && url.pathname === '/v1/models') {
      return send(res, 200, { items: [
        { id: 'default', displayName: 'Auto', aliases: ['auto'] },
        { id: 'grok-4.7', displayName: 'Grok 4.7' },
        { id: 'composer-2.5', displayName: 'Composer 2.5', aliases: ['composer'] },
      ] });
    }
    if (req.method === 'GET' && url.pathname === '/v1/me') {
      return send(res, 200, { apiKeyName: 'calliopi-cloud-fanout', createdAt: new Date().toISOString(), userEmail: 'dev@example.com' });
    }
    if (req.method === 'GET' && url.pathname === '/v1/agents') {
      return send(res, 200, { items: [...agents.values()].reverse().map(summary) });
    }
    if (!ag) return err(res, 404, 'agent_not_found', 'no such agent');
    const rest = parts.slice(3).join('/');
    if (req.method === 'GET' && rest === '') return send(res, 200, summary(ag));
    if (req.method === 'GET' && rest === 'runs') {
      // Real API (observed 2026-11): listRuns items omit `result`; only GET run returns it.
      advance(ag);
      return send(res, 200, { items: ag.runs.map((r) => { const { result, ...v } = runView(ag, r); return v; }) });
    }
    if (req.method === 'GET' && parts[3] === 'runs' && parts[5] === undefined) {
      const run = ag.runs.find((r) => r.id === parts[4]);
      if (!run) return err(res, 404, 'run_not_found', 'no run');
      if (run === ag.runs[0]) advance(ag);
      return send(res, 200, runView(ag, run));
    }
    if (req.method === 'GET' && parts[5] === 'stream') {
      if (stream410) return err(res, 410, 'stream_expired', 'gone');
      res.writeHead(200, { 'content-type': 'text/event-stream', 'x-cursor-stream-retention-seconds': '3600' });
      const run = ag.runs[0];
      res.write(`event: status\ndata: {"runId":"${run.id}","status":"RUNNING"}\n\n`);
      res.write(`id: 1-0\nevent: assistant\ndata: ${JSON.stringify({ text: `${run.ackText ?? ''}working on it…` })}\n\n`);
      while (!['FINISHED', 'ERROR', 'CANCELLED', 'EXPIRED'].includes(run.status)) advance(ag);
      res.write(`id: 2-0\nevent: result\ndata: ${JSON.stringify({ runId: run.id, status: run.status, text: run.result, durationMs: run.durationMs, git: ag.git })}\n\n`);
      res.end('id: 2-0\nevent: done\ndata: {}\n\n');
      return;
    }
    if (req.method === 'GET' && rest === 'usage') {
      if (usage403) return err(res, 403, 'feature_unavailable', 'early access');
      const u = { inputTokens: 100, outputTokens: 50, cacheWriteTokens: 10, cacheReadTokens: 40, totalTokens: 200 };
      return send(res, 200, { totalUsage: u, runs: [{ id: url.searchParams.get('runId'), usage: u }] });
    }
    if (req.method === 'POST' && rest === 'runs') {
      const now = new Date().toISOString();
      const run = { id: `run-${randomUUID()}`, script: ['RUNNING', 'FINISHED'], step: 0, status: 'RUNNING', createdAt: now, updatedAt: now };
      ag.runs.unshift(run);
      return send(res, 201, { run: runView(ag, run) });
    }
    if (req.method === 'POST' && parts[5] === 'cancel') {
      const run = ag.runs.find((r) => r.id === parts[4]);
      run!.script = [...run!.script.slice(0, run!.step + 1), 'CANCELLED']; return send(res, 200, { id: run!.id });
    }
    if (req.method === 'POST' && rest === 'archive') return send(res, 200, { id: ag.id });
    return err(res, 404, 'not_found', route);
  });

  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => {
    resolve({ server, agents, stats, mockState, url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, close: () => new Promise((r) => server.close(r as () => void)) });
  }));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const m = await startMock({
    port: Number(process.env.MOCK_PORT || 8787),
    every429: Number(process.env.MOCK_429_EVERY || 0),
    usage403: process.env.MOCK_USAGE_403 === '1',
    stream410: process.env.MOCK_STREAM_410 === '1',
  });
  process.stdout.write(`mock Cursor API on ${m.url} (key: test-key)\n`);
}
