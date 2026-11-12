import fs from 'node:fs';
import path from 'node:path';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { DEFAULT_CONFIG, LiveTurns, headerMarkdown, persistedHeaders, withHeader } from '../lib/turn-headers.ts';
import type { HeaderStyle, TurnHeaderConfig } from '../lib/turn-headers.ts';

// Global preference (all projects): <agentDir>/calliopi-ui.json → { "turnHeaders": { ... } }
const configFile = () => path.join(getAgentDir(), 'calliopi-ui.json');

function readFile(): Record<string, unknown> {
  try { return JSON.parse(fs.readFileSync(configFile(), 'utf8')) as Record<string, unknown>; } catch { return {}; }
}

export function loadConfig(): TurnHeaderConfig {
  const raw = (readFile().turnHeaders ?? {}) as Partial<TurnHeaderConfig>;
  const pick = (v: unknown, d: string) => (typeof v === 'string' && v.trim() ? v : d);
  return {
    style: (['full', 'compact', 'off'] as const).includes(raw.style as HeaderStyle) ? raw.style as HeaderStyle : DEFAULT_CONFIG.style,
    userIcon: pick(raw.userIcon, DEFAULT_CONFIG.userIcon),
    userLabel: pick(raw.userLabel, DEFAULT_CONFIG.userLabel),
    assistantIcon: pick(raw.assistantIcon, DEFAULT_CONFIG.assistantIcon),
    assistantLabel: pick(raw.assistantLabel, DEFAULT_CONFIG.assistantLabel),
    assistantHeaders: raw.assistantHeaders === 'first' ? 'first' : DEFAULT_CONFIG.assistantHeaders,
  };
}

function saveStyle(style: HeaderStyle): void {
  const file = readFile();
  const turnHeaders = { ...((file.turnHeaders ?? {}) as Record<string, unknown>), style };
  fs.mkdirSync(path.dirname(configFile()), { recursive: true });
  fs.writeFileSync(configFile(), `${JSON.stringify({ ...file, turnHeaders }, null, 2)}\n`);
}

export default function (pi: ExtensionAPI) {
  let config = loadConfig();
  let live = new LiveTurns();
  let session: ExtensionContext['sessionManager'] | undefined;
  let persisted = new Map<string, string>();
  let scanned = new Set<string>();

  // Rescan only when an entry we have not seen yet is rendered (not on every render).
  const rebuildPersisted = () => {
    const branch = (session?.getBranch() ?? []) as { id?: string }[];
    persisted = persistedHeaders(branch as never, config.assistantHeaders);
    scanned = new Set(branch.map((e) => e.id).filter((id): id is string => Boolean(id)));
  };

  pi.on('session_start', (_event, ctx) => { session = ctx.sessionManager; live = new LiveTurns(config.assistantHeaders); rebuildPersisted(); });
  pi.on('session_tree', () => rebuildPersisted());

  pi.on('message_start', (event) => {
    const m = event.message as { role?: string };
    if (m.role === 'user') live.user();
    else if (m.role === 'assistant') live.assistantStart(event.message as never);
  });
  pi.on('message_update', (event) => { if ((event.message as { role?: string }).role === 'assistant') live.assistant(event.message as never); });
  pi.on('message_end', (event) => { if ((event.message as { role?: string }).role === 'assistant') live.assistantEnd(event.message as never); });

  pi.registerMarkdownTransformer((markdown, ctx) => {
    if (config.style === 'off' || !markdown.trim()) return markdown;
    if (ctx.messageType === 'user') {
      return withHeader(headerMarkdown(config.userIcon, config.userLabel, ctx.availableWidth, config.style), markdown);
    }
    let opens = false;
    if (ctx.messageId) {
      if (!scanned.has(ctx.messageId)) rebuildPersisted(); // entry appended since the last scan
      opens = persisted.get(ctx.messageId) === markdown.trim();
    } else opens = live.matches(markdown);
    return opens ? withHeader(headerMarkdown(config.assistantIcon, config.assistantLabel, ctx.availableWidth, config.style), markdown) : markdown;
  }, { messageTypes: ['user', 'assistant'] });

  pi.registerCommand('calliopi-headers', {
    description: '대화 기록의 사용자/Pi 헤더 모양: full(선·헤더·선) | compact(한 줄) | off',
    getArgumentCompletions: (prefix: string) => ['full', 'compact', 'off'].filter((s) => s.startsWith(prefix)).map((s) => ({ value: s, label: s })),
    handler: async (args, ctx) => {
      const style = args.trim() as HeaderStyle;
      if (!['full', 'compact', 'off'].includes(style)) {
        return ctx.ui.notify(`현재: ${config.style}. 사용법: /calliopi-headers full|compact|off`, 'info');
      }
      saveStyle(style);
      config = loadConfig();
      ctx.ui.notify(`헤더: ${style}. 새 메시지부터 적용되며, 이전 기록은 /reload 후 반영됩니다.`, 'info');
    },
  });
}
