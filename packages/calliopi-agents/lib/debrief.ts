// Debriefs: when a top-level session ends with a smell, a separate `pi -p` reviews short excerpts
// around the flagged points and writes its reading to a file (@calliopi/core/debrief). The run is
// detached from this Pi, so it goes on after Pi quits, has no tools and saves no session, is stopped
// after a time limit, and ends by itself; nothing waits for it. It is off until turned on with
// /cl-debrief on: every run is a model call, and it sends excerpts of the session to that model.
import { spawn as nodeSpawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { privateDir, readJson, writeJson } from '@calliopi/core/agents';
import { debriefFiles, debriefPrompt, debriefSummary, excerpt, listDebriefs, readDebrief, type DebriefRecord } from '@calliopi/core/debrief';
import { sessionSmells, type SessionEntry } from '@calliopi/core/smells';
import { CONFIG_FILE } from '#lib/gc.ts';
import { extensionArgs, piInvocation } from '#lib/launch.ts';

/** Set in the reviewing Pi: it must not start a debrief of its own. */
export const DEBRIEF_ENV = 'CALLIOPI_DEBRIEF';
export const DEFAULT_TIMEOUT_MINUTES = 5;
export const SYSTEM_PROMPT = 'You review excerpts of coding-agent sessions for the person who maintains the agent harness. You have no tools.';

export const debriefRoot = (agentDir: string) => path.join(agentDir, 'calliopi-debriefs');

export interface DebriefConfig { enabled: boolean; model?: string; timeoutMinutes: number }
/** `<Pi agent dir>/calliopi-agents.json`: `{ "debrief": { "enabled": true, "model": "provider/id", "timeoutMinutes": 5 } }`. */
export function debriefConfig(agentDir: string): DebriefConfig {
  const c = readJson<{ debrief?: { enabled?: unknown; model?: unknown; timeoutMinutes?: unknown } }>(path.join(agentDir, CONFIG_FILE))?.debrief ?? {};
  const minutes = typeof c.timeoutMinutes === 'number' && Number.isFinite(c.timeoutMinutes) && c.timeoutMinutes > 0 ? Math.min(c.timeoutMinutes, 60) : DEFAULT_TIMEOUT_MINUTES;
  return { enabled: c.enabled === true, model: typeof c.model === 'string' && /^[\w.:@-]+\/[\w.:@/-]+$/.test(c.model) ? c.model : undefined, timeoutMinutes: minutes };
}
/** Changes the debrief settings and leaves the rest of the file as it is. */
export function setDebriefConfig(agentDir: string, change: { enabled: boolean; model?: string }): void {
  const file = path.join(agentDir, CONFIG_FILE);
  const all = readJson<Record<string, unknown>>(file) ?? {};
  const debrief = { ...(all.debrief && typeof all.debrief === 'object' ? all.debrief : {}), enabled: change.enabled, ...(change.model ? { model: change.model } : {}) };
  fs.mkdirSync(agentDir, { recursive: true });
  writeJson(file, { ...all, debrief });
}

export interface DebriefSpawn { command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv }
export type Spawn = (s: DebriefSpawn) => void;

// Runs the command given after `sh` with its output in the answer file, stops it after $1 seconds, and
// writes its exit status last (143 when it was stopped). The timer's own sleep is ended with it, so no
// process is left behind either way.
const RUNNER = [
  'secs=$1; answer=$2; exitfile=$3; shift 3',
  '"$@" > "$answer" 2> "$answer.log" < /dev/null &',
  'pid=$!',
  '( sleep "$secs" & s=$!; trap \'kill $s 2>/dev/null; exit 0\' TERM; wait $s; kill $pid 2>/dev/null ) &',
  'timer=$!',
  'wait $pid; code=$?',
  'kill $timer 2>/dev/null',
  'echo $code > "$exitfile"',
].join('\n');

const detached: Spawn = s => {
  const child = nodeSpawn(s.command, s.args, { cwd: s.cwd, env: s.env, detached: true, stdio: 'ignore' });
  child.on('error', () => { /* no sh, or it cannot start: the record stays without an exit status and reads as lost */ });
  child.unref();
};

/** What starts a review of `record`, whose prompt is already in its file. */
export function debriefSpawn(root: string, record: DebriefRecord, prompt: string, launch: { pi: string[]; extensions: string[] }, env: NodeJS.ProcessEnv = process.env): DebriefSpawn {
  const files = debriefFiles(root, record.session)!;
  return {
    command: 'sh',
    args: ['-c', RUNNER, 'sh', String(Math.round(record.timeoutMs / 1000)), files.answer, files.exit,
      ...launch.pi, '-p', '--no-session', '--no-tools', '--no-mcp', '--no-skills', '--no-context-files', '--no-prompt-templates',
      ...launch.extensions.flatMap(e => ['-e', e]), '--model', record.model, '--system-prompt', SYSTEM_PROMPT, prompt],
    cwd: root, // not the project: nothing of it is read
    env: { ...env, [DEBRIEF_ENV]: '1' },
  };
}

/** Why no debrief was started, or the record of the one that was. */
export type Started = { started: DebriefRecord } | { skipped: 'off' | 'no-session-file' | 'no-smell' | 'no-model' | 'already' | 'bad-id' };

/** Starts a debrief of the session in `ctx` if it is due. Never throws; nothing is awaited. */
export function startDebrief(ctx: Pick<ExtensionContext, 'sessionManager' | 'model' | 'cwd'>, opts: { agentDir: string; spawn?: Spawn; now?: () => number; launch?: { pi: string[]; extensions: string[] } }): Started {
  const config = debriefConfig(opts.agentDir);
  if (!config.enabled) return { skipped: 'off' };
  const sessionFile = ctx.sessionManager.getSessionFile();
  if (!sessionFile) return { skipped: 'no-session-file' };
  const session = ctx.sessionManager.getSessionId();
  const entries = ctx.sessionManager.getEntries() as SessionEntry[];
  const { text, points } = excerpt(entries, sessionSmells(entries));
  if (!points.length) return { skipped: 'no-smell' };
  const model = config.model ?? (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined);
  if (!model) return { skipped: 'no-model' };
  const root = privateDir(debriefRoot(opts.agentDir));
  const files = debriefFiles(root, session);
  if (!files) return { skipped: 'bad-id' };
  const now = (opts.now ?? Date.now)();
  // Reviewed already and not grown since (a session that was resumed and went on is reviewed again).
  const before = readDebrief(root, session, now);
  if (before && before.record.entries >= entries.length) return { skipped: 'already' };
  const record: DebriefRecord = {
    session, sessionFile, cwd: ctx.cwd, model, startedAt: now, timeoutMs: config.timeoutMinutes * 60_000, entries: entries.length,
    points: points.map(p => ({ kind: p.kind, entry: p.entry, detail: p.detail })),
  };
  const prompt = debriefPrompt(text);
  for (const f of [files.answer, files.exit, files.log]) fs.rmSync(f, { force: true });
  fs.writeFileSync(files.prompt, prompt, { mode: 0o600 });
  writeJson(files.record, record);
  (opts.spawn ?? detached)(debriefSpawn(root, record, prompt, opts.launch ?? { pi: piInvocation(), extensions: extensionArgs() }));
  return { started: record };
}

const STATUS_KO = { running: '진행 중', done: '완료', timeout: '시간 초과', error: '오류', lost: '결과 없음' } as const;

export function installDebrief(pi: ExtensionAPI, opts: { agentDir: () => string; spawn?: Spawn; env?: NodeJS.ProcessEnv }): void {
  if ((opts.env ?? process.env)[DEBRIEF_ENV]) return; // this Pi is a review: it starts none, shows none
  const root = () => debriefRoot(opts.agentDir());
  const unread = () => listDebriefs(root()).filter(d => d.status === 'done' && !d.record.readAt);

  pi.registerCommand('cl-debrief', {
    description: '세션이 smell과 함께 끝나면 백그라운드에서 별도 모델이 그 지점을 읽고 적어 둡니다. 인자 없이: 아직 안 본 결과 보기 · on [provider/model]: 켜기 · off: 끄기 · status: 상태',
    getArgumentCompletions: (prefix: string) => ['on', 'off', 'status'].filter(s => s.startsWith(prefix)).map(s => ({ value: s, label: s })),
    handler: async (args, ctx) => {
      const [word, model] = args.trim().split(/\s+/);
      const agentDir = opts.agentDir();
      if (word === 'on' || word === 'off') {
        if (model && !/^[\w.:@-]+\/[\w.:@/-]+$/.test(model)) return ctx.ui.notify(`모델은 provider/model 꼴로 적습니다: ${model}`, 'warning');
        try { setDebriefConfig(agentDir, { enabled: word === 'on', model: word === 'on' ? model : undefined }); }
        catch (error) { return ctx.ui.notify(`설정을 쓰지 못했습니다: ${error instanceof Error ? error.message : String(error)}`, 'error'); }
        const c = debriefConfig(agentDir);
        return ctx.ui.notify(c.enabled
          ? `debrief를 켰습니다. 대화형 세션이 smell과 함께 끝나면 ${c.model ?? '그 세션의 모델'}로 걸린 지점의 발췌를 보내 읽게 합니다(세션마다 모델 호출 한 번, 최대 ${c.timeoutMinutes}분).`
          : 'debrief를 껐습니다. 이미 받은 결과는 남아 있습니다.', 'info');
      }
      if (word === 'status') {
        const c = debriefConfig(agentDir);
        const all = listDebriefs(root());
        const counts = Object.entries(STATUS_KO).map(([s, ko]) => [ko, all.filter(d => d.status === s).length] as const).filter(([, n]) => n);
        return ctx.ui.notify(`debrief: ${c.enabled ? '켜짐' : '꺼짐'} · 모델 ${c.model ?? '세션의 모델'} · ${all.length}건${counts.length ? ` (${counts.map(([ko, n]) => `${ko} ${n}`).join(', ')})` : ''}`, 'info');
      }
      if (word) return ctx.ui.notify('사용법: /cl-debrief · /cl-debrief on [provider/model] · /cl-debrief off · /cl-debrief status', 'warning');
      const fresh = unread();
      if (!fresh.length) return ctx.ui.notify(debriefConfig(agentDir).enabled ? '새 debrief가 없습니다.' : '새 debrief가 없습니다. 꺼져 있습니다: /cl-debrief on', 'info');
      const d = fresh.at(-1)!;
      const files = debriefFiles(root(), d.record.session)!;
      try { writeJson(files.record, { ...d.record, readAt: Date.now() }); } catch { /* shown anyway */ }
      ctx.ui.notify([`debrief · 세션 ${d.record.session} · ${d.record.model} · ${new Date(d.record.startedAt).toISOString().slice(0, 16).replace('T', ' ')}Z${fresh.length > 1 ? ` · 남은 ${fresh.length - 1}건` : ''}`, '', d.text].join('\n'), 'info');
    },
  });

  // New results are announced when a session starts, to the person only.
  pi.on('session_start', (event, ctx) => {
    if ((event as { reason?: string }).reason !== 'startup') return;
    try {
      const fresh = unread();
      if (fresh.length) ctx.ui.notify(`지난 세션 debrief ${fresh.length}건${debriefSummary(fresh.at(-1)!.text) ? ` · 최근: ${debriefSummary(fresh.at(-1)!.text)}` : ''} · /cl-debrief`, 'info');
    } catch { /* a notice is not worth a failed start */ }
  });

  // The session is left for good (quit) or for another (/new, /resume): a reload or a fork goes on with it.
  pi.on('session_shutdown', (event, ctx) => {
    const reason = (event as { reason?: string }).reason;
    if (reason !== 'quit' && reason !== 'new' && reason !== 'resume') return;
    if (ctx.mode !== 'tui') return; // a scripted run (pi -p, rpc) is not a person's session
    try { startDebrief(ctx, { agentDir: opts.agentDir(), spawn: opts.spawn }); } catch { /* never in the way of quitting */ }
  });
}
