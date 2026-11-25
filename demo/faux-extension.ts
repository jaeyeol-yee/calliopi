// Pi extension for demos: registers the `faux/demo` model, which answers with the replies scripted
// in the scenario named by $DEMO_SCENARIO. Loaded only by demo/build.ts (pi -e), never installed.
import { fauxAssistantMessage, fauxProvider, fauxText, fauxThinking, fauxToolCall } from '@earendil-works/pi-ai';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { loadScenario, replies, type ReplyBlock } from './lib/scenario.ts';

type Block = ReturnType<typeof fauxText> | ReturnType<typeof fauxThinking> | ReturnType<typeof fauxToolCall>;

/** Split one reply into model calls: a tool call ends a call, the tool result starts the next. */
export function toCalls(reply: ReplyBlock[]): { blocks: Block[]; toolUse: boolean }[] {
  const calls: { blocks: Block[]; toolUse: boolean }[] = [];
  let blocks: Block[] = [];
  for (const b of reply) {
    if ('tool' in b) {
      // YAML parses to JSON-compatible values, so the arguments are a JSON object.
      blocks.push(fauxToolCall(b.tool, (b.args ?? {}) as Parameters<typeof fauxToolCall>[1]));
      calls.push({ blocks, toolUse: true });
      blocks = [];
    } else {
      blocks.push('text' in b ? fauxText(b.text) : fauxThinking(b.thinking));
    }
  }
  if (blocks.length) calls.push({ blocks, toolUse: false });
  return calls;
}

export default function (pi: ExtensionAPI) {
  const file = process.env.DEMO_SCENARIO;
  if (!file) throw new Error('DEMO_SCENARIO가 설정되지 않았습니다');
  const scenario = loadScenario(file);
  const script = replies(scenario).map(toCalls);

  const faux = fauxProvider({
    provider: 'faux',
    models: [{ id: 'demo', name: 'demo', reasoning: true }],
    tokensPerSecond: scenario.tokensPerSecond,
  });

  // Pick the reply by position in the transcript, not by queue order: after n finished replies comes
  // the n-th reply (from 0), and each tool call inside that turn moves on to the reply's next call.
  const completions = scenario.completions.map((c) => ({ match: new RegExp(c.match), text: c.text }));
  const textOf = (content: unknown) => typeof content === 'string' ? content
    : Array.isArray(content) ? content.map((b: { text?: unknown }) => typeof b?.text === 'string' ? b.text : '').join('') : '';
  const respond = (context: { messages: { role: string; content?: unknown; stopReason?: string }[] }) => {
    const messages = context.messages;
    // A one-off request from an extension: its text is what the patterns are written for.
    const asked = textOf(messages.findLast((m) => m.role === 'user')?.content);
    const oneOff = completions.find((c) => c.match.test(asked));
    if (oneOff) return fauxAssistantMessage(oneOff.text);
    // Count finished replies, not user messages: an extension may add messages of its own to a turn
    // (/cl-run passes a finished job's output on), and those reach the model as user messages too.
    const assistant = messages.filter((m) => m.role === 'assistant');
    const turn = assistant.filter((m) => m.stopReason !== 'toolUse').length;
    const step = assistant.length - 1 - assistant.findLastIndex((m) => m.stopReason !== 'toolUse');
    const call = script[turn]?.[step];
    if (!call) return fauxAssistantMessage(`(시나리오에 ${turn + 1}번째 답변이 없습니다)`);
    return fauxAssistantMessage(call.blocks, { stopReason: call.toolUse ? 'toolUse' : 'stop' });
  };
  const total = script.reduce((n, calls) => n + calls.length, 0);
  faux.setResponses(Array.from({ length: total + completions.length + 1 }, () => respond));

  pi.registerProvider(faux.provider);
}
