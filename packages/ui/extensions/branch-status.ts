// Branch status in the footer: `onto owner/repo#N open|draft|merged|closed`, next to Pi's
// `~/repo (branch)`, only when the branch is in a PR. The reference links to the PR (OSC 8).
//
// Looked up by commit across every GitHub remote and fork parent (@calliopi/core/pr-lookup).
// Refreshed on start, when HEAD, the branch or the pushed commit changes (checked locally every few
// seconds), after each agent run, and every pollSeconds while the PR is open or a draft.
import fs from 'node:fs';
import path from 'node:path';
import { FooterComponent, getAgentDir } from '@earendil-works/pi-coding-agent';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { hyperlink } from '@earendil-works/pi-tui';
import { capture } from '@calliopi/core/capture';
import { lookupPulls, type BranchPulls } from '@calliopi/core/pr-lookup';
import { FooterSlot } from '#lib/ui-override/footer-slot.ts';
import { STATE_COLOR, describePulls, formatStatus, pollDelay, type StatusPaint } from '#lib/branch-status.ts';

// Global preference (all projects): <agentDir>/calliopi-ui.json → { "branchStatus": { ... } }
const configFile = () => path.join(getAgentDir(), 'calliopi-ui.json');
const readFile = (): Record<string, unknown> => {
  try { return JSON.parse(fs.readFileSync(configFile(), 'utf8')) as Record<string, unknown>; } catch { return {}; }
};

interface Config { enabled: boolean; pollSeconds: number }

export function loadConfig(): Config {
  const raw = (readFile().branchStatus ?? {}) as Partial<Config>;
  return {
    enabled: raw.enabled !== false,
    pollSeconds: typeof raw.pollSeconds === 'number' && raw.pollSeconds >= 10 ? raw.pollSeconds : 60,
  };
}

function save(patch: Partial<Config>): void {
  const file = readFile();
  const branchStatus = { ...((file.branchStatus ?? {}) as Record<string, unknown>), ...patch };
  fs.mkdirSync(path.dirname(configFile()), { recursive: true });
  fs.writeFileSync(configFile(), `${JSON.stringify({ ...file, branchStatus }, null, 2)}\n`);
}

const LOCAL_CHECK_MS = 5_000;
const AFTER_AGENT_MIN_MS = 15_000;
const tuiModeArg = () => {
  const i = process.argv.findIndex((a) => a === '--tui-mode' || a.startsWith('--tui-mode='));
  return i < 0 ? undefined : process.argv[i]!.includes('=') ? process.argv[i]!.split('=')[1] : process.argv[i + 1];
};

export default function (pi: ExtensionAPI) {
  let config = loadConfig();
  const slot = new FooterSlot((c) => c instanceof FooterComponent);
  const run = capture();
  const parents = new Map<string, string>();
  let ctx: ExtensionContext | undefined;
  let last: BranchPulls | undefined;
  let lastAt = 0;
  let localKey = '';
  let inFlight: Promise<void> | undefined;
  let pollTimer: NodeJS.Timeout | undefined;
  let localTimer: NodeJS.Timeout | undefined;

  const paint = (): StatusPaint => {
    const theme = ctx?.ui.theme;
    if (!theme) return { dim: (s) => s, ref: (s, url) => hyperlink(s, url), state: (s) => s };
    return {
      dim: (s) => theme.fg('dim', s),
      // Default text color: the color belongs to the state (merged is the accent color).
      ref: (s, url) => hyperlink(s, url),
      state: (s, state) => theme.fg(STATE_COLOR[state], s),
    };
  };

  const refresh = (): Promise<void> => {
    if (!ctx) return Promise.resolve();
    inFlight ??= (async () => {
      try {
        last = await lookupPulls({ cwd: ctx!.cwd, run, parents });
      } catch { /* keep the last value: offline, gh missing or not logged in */ }
      lastAt = Date.now();
      slot.set('branch-status', formatStatus(last, paint()));
      clearTimeout(pollTimer);
      const delay = pollDelay(last, config.pollSeconds);
      if (delay) (pollTimer = setTimeout(() => void refresh(), delay)).unref();
    })().finally(() => { inFlight = undefined; });
    return inFlight;
  };

  // Cheap and local: HEAD, branch and pushed commit. Any change means a new lookup.
  const checkLocal = async () => {
    if (!ctx) return;
    const out = await Promise.all([
      run('git', ['rev-parse', 'HEAD'], { cwd: ctx.cwd }),
      run('git', ['symbolic-ref', '-q', 'HEAD'], { cwd: ctx.cwd }),
      run('git', ['rev-parse', '--verify', '--quiet', '@{push}'], { cwd: ctx.cwd }),
    ]);
    const key = out.map((r) => r.stdout.trim()).join(' ');
    if (key !== localKey) { localKey = key; void refresh(); }
  };

  const start = (c: ExtensionContext) => {
    ctx = c;
    slot.mount(c.ui as never);
    void checkLocal();
    clearInterval(localTimer);
    (localTimer = setInterval(() => void checkLocal(), LOCAL_CHECK_MS)).unref();
  };
  const stop = () => {
    clearInterval(localTimer); clearTimeout(pollTimer);
    localTimer = pollTimer = undefined;
    slot.set('branch-status', undefined);
    slot.unmount();
  };
  const available = (c: ExtensionContext) => c.mode === 'tui' && (tuiModeArg() || pi.getSettings().tuiMode) !== 'regular';

  pi.on('session_start', (_event, c) => {
    ctx = c;
    if (config.enabled && available(c)) start(c);
  });
  // The agent may have committed or pushed; the local check catches most of it, this catches a PR
  // opened by the agent with gh.
  pi.on('agent_end', () => { if (localTimer && Date.now() - lastAt > AFTER_AGENT_MIN_MS) void refresh(); });
  pi.on('session_shutdown', () => { stop(); ctx = undefined; });

  pi.registerCommand('cl-branch', {
    description: '현재 브랜치의 PR: 목록 보기 | on | off (footer 표시) | refresh',
    getArgumentCompletions: (prefix: string) => ['on', 'off', 'refresh'].filter((s) => s.startsWith(prefix)).map((s) => ({ value: s, label: s })),
    handler: async (args, c) => {
      const arg = args.trim();
      if (arg === 'on' || arg === 'off') {
        save({ enabled: arg === 'on' });
        config = loadConfig();
        if (!config.enabled) stop();
        else if (available(c)) start(c);
        else return c.ui.notify('footer 표시는 fullscreen TUI에서만 동작합니다.', 'warning');
        return c.ui.notify(`브랜치 상태: ${arg}`, 'info');
      }
      ctx ??= c;
      if (arg === 'refresh' || !last) await refresh();
      c.ui.notify(describePulls(last), 'info');
    },
  });
}
