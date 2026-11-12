import fs from 'node:fs';
import path from 'node:path';
import { AssistantMessageComponent, UserMessageComponent, getAgentDir } from '@earendil-works/pi-coding-agent';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import {
  DEFAULT_CONFIG, LiveTurns, NO_PAINT, headerLines, headerMarkdown, installHeader, persistedHeaders, uninstallHeader, withHeader,
} from '#lib/turn-headers.ts';
import type { HeaderPaint, HeaderStyle, TurnHeaderConfig } from '#lib/turn-headers.ts';
import { PLAIN_FRAME, frameThinking, installAfterUpdate, uninstallAfterUpdate } from '#lib/thinking-frame.ts';
import type { FramePaint } from '#lib/thinking-frame.ts';

// Global preference (all projects): <agentDir>/calliopi-ui.json → { "turnHeaders": { ... } }
const configFile = () => path.join(getAgentDir(), 'calliopi-ui.json');

function readFile(): Record<string, unknown> {
  try { return JSON.parse(fs.readFileSync(configFile(), 'utf8')) as Record<string, unknown>; } catch { return {}; }
}

type Config = TurnHeaderConfig & { thinkingFrame: boolean };

export function loadConfig(): Config {
  const raw = (readFile().turnHeaders ?? {}) as Partial<Config>;
  const pick = (v: unknown, d: string) => (typeof v === 'string' && v.trim() ? v : d);
  return {
    style: (['full', 'compact', 'off'] as const).includes(raw.style as HeaderStyle) ? raw.style as HeaderStyle : DEFAULT_CONFIG.style,
    userIcon: pick(raw.userIcon, DEFAULT_CONFIG.userIcon),
    userLabel: pick(raw.userLabel, DEFAULT_CONFIG.userLabel),
    assistantIcon: pick(raw.assistantIcon, DEFAULT_CONFIG.assistantIcon),
    assistantLabel: pick(raw.assistantLabel, DEFAULT_CONFIG.assistantLabel),
    assistantHeaders: 'every',
    thinkingFrame: raw.thinkingFrame !== false,
  };
}

function save(patch: Partial<Config>): void {
  const file = readFile();
  const turnHeaders = { ...((file.turnHeaders ?? {}) as Record<string, unknown>), ...patch };
  fs.mkdirSync(path.dirname(configFile()), { recursive: true });
  fs.writeFileSync(configFile(), `${JSON.stringify({ ...file, turnHeaders }, null, 2)}\n`);
}

type ThemeLike = ExtensionContext['ui']['theme'];
type AssistantView = { outputPad?: number; hasToolCalls?: boolean };

export default function (pi: ExtensionAPI) {
  let config = loadConfig();
  let theme: ThemeLike | undefined;
  const paint = (): HeaderPaint => (theme
    ? { rule: (s) => theme!.fg('borderMuted', s), icon: (s) => theme!.fg('accent', s), label: (s) => theme!.bold(s) }
    : NO_PAINT);

  // Primary path: the message components draw the header themselves, so it precedes everything
  // the message shows (thinking, text) and — for a tool-only model turn — the tool boxes after it.
  // Every assistant component is one model turn, so no turn tracking is needed.
  const patched = installHeader(AssistantMessageComponent as never, (instance, width, lines) => {
    const view = instance as AssistantView;
    if (!lines.length && !view.hasToolCalls) return null; // nothing streamed yet
    return headerLines(config.assistantIcon, config.assistantLabel, width, config.style, view.outputPad ?? 1, paint());
  }) && installHeader(UserMessageComponent as never, (instance, width, lines) => {
    if (!lines.length) return null;
    return headerLines(config.userIcon, config.userLabel, width, config.style, (instance as AssistantView).outputPad ?? 1, paint());
  });

  // Thinking runs become an indented frame (hidden thinking: one ┊ ∴ line). Re-applied whenever the
  // message rebuilds its children (every streaming update).
  const framePaint = (): FramePaint => (theme
    ? { border: (s) => theme!.fg('borderMuted', s), title: (s) => theme!.fg('thinkingText', s) }
    : PLAIN_FRAME);
  const framed = installAfterUpdate(AssistantMessageComponent as never, (instance) => {
    if (!config.thinkingFrame) return;
    const view = instance as AssistantView & { contentContainer?: { children?: never[] } };
    frameThinking(view.contentContainer, { pad: view.outputPad ?? 1, paint: framePaint });
  });

  pi.on('session_start', (_event, ctx) => { theme = ctx.ui.theme; });
  // Put Pi's own functions back; the next load installs again.
  pi.on('session_shutdown', () => {
    uninstallHeader(AssistantMessageComponent as never);
    uninstallHeader(UserMessageComponent as never);
    uninstallAfterUpdate(AssistantMessageComponent as never);
  });

  if (!patched) {
    // Fallback when the component classes do not look as expected: Markdown transformer headers
    // (no header before tool-only turns or hidden thinking; see README).
    uninstallHeader(AssistantMessageComponent as never);
    let live = new LiveTurns();
    let session: ExtensionContext['sessionManager'] | undefined;
    let persisted = new Map<string, string>();
    let scanned = new Set<string>();
    const rebuild = () => {
      const branch = (session?.getBranch() ?? []) as { id?: string }[];
      persisted = persistedHeaders(branch as never);
      scanned = new Set(branch.map((e) => e.id).filter((id): id is string => Boolean(id)));
    };
    pi.on('session_start', (_event, ctx) => { session = ctx.sessionManager; live = new LiveTurns(); rebuild(); });
    pi.on('session_tree', () => rebuild());
    pi.on('message_start', (event) => {
      const m = event.message as { role?: string };
      if (m.role === 'user') live.user();
      else if (m.role === 'assistant') live.assistantStart(event.message as never);
    });
    pi.on('message_update', (event) => { if ((event.message as { role?: string }).role === 'assistant') live.assistant(event.message as never); });
    pi.on('message_end', (event) => { if ((event.message as { role?: string }).role === 'assistant') live.assistantEnd(event.message as never); });
    pi.registerMarkdownTransformer((markdown, ctx) => {
      if (config.style === 'off' || !markdown.trim()) return markdown;
      if (ctx.messageType === 'user') return withHeader(headerMarkdown(config.userIcon, config.userLabel, ctx.availableWidth, config.style), markdown);
      let opens = false;
      if (ctx.messageId) {
        if (!scanned.has(ctx.messageId)) rebuild();
        opens = persisted.get(ctx.messageId) === markdown.trim();
      } else opens = live.matches(markdown);
      return opens ? withHeader(headerMarkdown(config.assistantIcon, config.assistantLabel, ctx.availableWidth, config.style), markdown) : markdown;
    }, { messageTypes: ['user', 'assistant'] });
  }

  pi.registerCommand('calliopi-headers', {
    description: '대화 기록 헤더: full(선·헤더·선) | compact(한 줄) | off · thinking on|off (thinking 테두리)',
    getArgumentCompletions: (prefix: string) => ['full', 'compact', 'off', 'thinking on', 'thinking off'].filter((s) => s.startsWith(prefix)).map((s) => ({ value: s, label: s })),
    handler: async (args, ctx) => {
      const [first, second] = args.trim().split(/\s+/);
      if (first === 'thinking' && (second === 'on' || second === 'off')) {
        if (!framed) return ctx.ui.notify('이 Pi 버전에서는 thinking 테두리를 적용할 수 없습니다.', 'warning');
        save({ thinkingFrame: second === 'on' });
        config = loadConfig();
        return ctx.ui.notify(`thinking 테두리: ${second}. 새로 그려지는 메시지부터 적용되며, 이전 기록은 /reload 후 반영됩니다.`, 'info');
      }
      const style = first as HeaderStyle;
      if (!['full', 'compact', 'off'].includes(style)) {
        return ctx.ui.notify(`현재: ${config.style}, thinking ${config.thinkingFrame ? 'on' : 'off'} (${patched ? '컴포넌트 헤더' : 'Markdown 대체 경로'}). 사용법: /calliopi-headers full|compact|off · thinking on|off`, 'info');
      }
      save({ style });
      config = loadConfig();
      ctx.ui.notify(`헤더: ${style}${patched ? '. 대화 기록 전체에 바로 적용됩니다.' : '. 새 메시지부터 적용되며, 이전 기록은 /reload 후 반영됩니다.'}`, 'info');
    },
  });
}
