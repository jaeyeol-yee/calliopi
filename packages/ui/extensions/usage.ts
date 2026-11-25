// /cl-usage: subscription usage of Claude, Codex and Cursor as gauges, in an overlay panel.
// Each provider is a strategy in @calliopi/core/usage; credentials come from logins already on this
// machine (Pi's own first), read only. `r` refreshes, Esc or q closes.
import fs from 'node:fs';
import path from 'node:path';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { matchesKey } from '@earendil-works/pi-tui';
import { PROVIDER_IDS, defaultEnv, fetchUsage, type ProviderId, type UsageSnapshot } from '@calliopi/core/usage';
import { renderGauges, type GaugePaint } from '#lib/gauge.ts';
import { panelLines, parseArgs } from '#lib/usage-panel.ts';

// Global preference: <agentDir>/calliopi-ui.json → { "usage": { "providers": ["claude", "codex", "cursor"] } }
const configFile = () => path.join(getAgentDir(), 'calliopi-ui.json');

export function loadProviders(): ProviderId[] {
  try {
    const raw = (JSON.parse(fs.readFileSync(configFile(), 'utf8')) as { usage?: { providers?: unknown } }).usage?.providers;
    const picked = Array.isArray(raw) ? PROVIDER_IDS.filter((id) => raw.includes(id)) : [];
    return picked.length ? picked : PROVIDER_IDS;
  } catch { return PROVIDER_IDS; }
}

type Theme = ExtensionContext['ui']['theme'];
const gaugePaint = (theme: Theme): GaugePaint => ({
  title: (s) => theme.bold(s),
  dim: (s) => theme.fg('dim', s),
  error: (s) => theme.fg('error', s),
  fill: (s, level) => theme.fg(level === 'high' ? 'error' : level === 'warn' ? 'warning' : 'success', s),
  empty: (s) => theme.fg('borderMuted', s),
  pace: (s) => theme.fg('text', s),
});

export default function (pi: ExtensionAPI) {
  pi.registerCommand('cl-usage', {
    description: 'Claude · Codex · Cursor 구독 사용량 (gauge). 인자로 provider를 고를 수 있습니다: claude codex cursor',
    getArgumentCompletions: (prefix: string) => PROVIDER_IDS.filter((s) => s.startsWith(prefix)).map((s) => ({ value: s, label: s })),
    handler: async (args, ctx) => {
      const { ids: picked, unknown } = parseArgs(args);
      if (unknown.length) return ctx.ui.notify(`알 수 없는 provider: ${unknown.join(', ')} (claude, codex, cursor)`, 'warning');
      const ids = picked.length ? picked : loadProviders();
      // Pi's own login comes first: Pi refreshes it, so it is never stale.
      const env = defaultEnv({ piToken: (provider) => ctx.modelRegistry.getApiKeyForProvider(provider) });

      if (ctx.mode !== 'tui') {
        const snapshots = await fetchUsage(ids, env);
        return ctx.ui.notify(renderGauges(snapshots, 80, Date.now()).join('\n'), 'info');
      }

      await ctx.ui.custom<void>((tui, theme, _keys, done) => {
        let snapshots: UsageSnapshot[] | undefined;
        let loading = false;
        let fetchedAt = 0;
        let closed = false;
        const refresh = () => {
          if (loading) return;
          loading = true;
          tui.requestRender();
          void fetchUsage(ids, env).then((result) => {
            snapshots = result; fetchedAt = Date.now();
          }).finally(() => { loading = false; if (!closed) tui.requestRender(); });
        };
        refresh();
        // Reset countdowns move; redraw each minute while the panel is open.
        const timer = setInterval(() => tui.requestRender(), 60_000);
        timer.unref();
        const close = () => { closed = true; clearInterval(timer); done(); };
        return {
          render(width: number) {
            const inner = Math.max(10, width - 4);
            const body = snapshots ? renderGauges(snapshots, inner, Date.now(), gaugePaint(theme)) : [theme.fg('dim', '불러오는 중…')];
            const time = fetchedAt ? new Date(fetchedAt).toLocaleTimeString() : '';
            const footer = theme.fg('dim', `${loading ? '갱신 중…' : time ? `${time} 기준` : ''}  r 새로고침 · Esc 닫기`.trim());
            return panelLines(['', ...body, ''], width, footer, { border: (x) => theme.fg('borderMuted', x), title: (x) => theme.bold(x) });
          },
          handleInput(data: string) {
            if (matchesKey(data, 'escape') || data === 'q') close();
            else if (data === 'r') refresh();
          },
          invalidate() {},
        };
      }, { overlay: true, overlayOptions: { anchor: 'center', width: '80%', minWidth: 60, maxHeight: '80%', margin: 1 } });
    },
  });
}
