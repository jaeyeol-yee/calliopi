// The contract reminder is added at the end of every request and moves on with it. Anthropic's
// payload puts the conversation's cache mark (cache_control) on the last user message, which is the
// reminder: each request then writes a cache entry that ends in the reminder, and the next request,
// whose reminder has moved, can read none of it. Moving the mark to the message before the reminder
// caches the conversation itself; the model is sent the same text. Other payload shapes (OpenAI's
// automatic prefix cache) have no mark and are left alone.
//
// Anthropic looks for an earlier cache entry only about 20 content blocks back from a mark. A turn of
// many parallel tool calls adds more than that, so the previous request's mark position is marked
// again; that is a fifth mark, and the limit is four, so it takes the one on the tools, which sit
// before the system prompt and are read back with it.
import { CONTRACT_MARK } from '#lib/contract.ts';

type Obj = Record<string, unknown>;
type Block = Obj & { type?: string; text?: string; cache_control?: unknown };
type Message = Obj & { role?: string; content?: unknown };
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const blocks = (m: unknown): Block[] => (isObj(m) && Array.isArray(m.content) ? m.content.filter(isObj) : []) as Block[];
const marked = (list: unknown) => (Array.isArray(list) ? list : []).filter(b => isObj(b) && b.cache_control).length;
const strip = (b: unknown) => { if (!isObj(b) || !('cache_control' in b)) return b; const { cache_control: _, ...rest } = b; return rest; };
/** Block types Anthropic accepts a cache mark on, as Pi places it. */
const MARKABLE = new Set(['text', 'image', 'tool_result']);
/** Blocks after the previous mark beyond which it is marked again (Anthropic looks back about 20). */
export const LOOKBACK = 15;
const MAX_MARKS = 4;

const markable = (m: Message | undefined) => {
  const last = blocks(m).at(-1);
  return !!m && m.role === 'user' && Array.isArray(m.content) && !!last && MARKABLE.has(String(last.type));
};
const withMark = (m: Message, mark: unknown): Message =>
  ({ ...m, content: [...(m.content as unknown[]).slice(0, -1), { ...blocks(m).at(-1), cache_control: mark }] });

/** The payload with the cache mark moved off the contract reminder, or undefined when there is nothing to move.
 *  `previous` is the payload last sent, to mark its position again when the new tail is too long to find it. */
export function cacheBeforeReminder(payload: unknown, previous?: unknown): unknown {
  if (!isObj(payload) || !Array.isArray(payload.messages)) return undefined;
  const messages = payload.messages as Message[];
  const at = messages.findLastIndex(m => blocks(m).some(b => b.type === 'text' && b.text?.startsWith(CONTRACT_MARK)));
  if (at < 1 || !blocks(messages[at]).some(b => b.cache_control)) return undefined;
  if (!markable(messages[at - 1])) return undefined;
  const mark = blocks(messages[at]).find(b => b.cache_control)!.cache_control;
  const next = [...messages];
  next[at] = { ...messages[at], content: (messages[at]!.content as unknown[]).map(strip) };
  next[at - 1] = withMark(messages[at - 1]!, mark);
  const out: Obj = { ...payload, messages: next };

  const prior = isObj(previous) && Array.isArray(previous.messages) ? previous.messages as Message[] : [];
  const was = prior.findLastIndex(m => blocks(m).some(b => b.cache_control));
  const tail = next.slice(was + 1, at).reduce((n, m) => n + blocks(m).length, 0);
  if (was >= 0 && was < at - 1 && tail > LOOKBACK && markable(next[was])
    && JSON.stringify(blocks(next[was]).map(strip)) === JSON.stringify(blocks(prior[was]).map(strip))) {
    const tools = Array.isArray(payload.tools) ? payload.tools : [];
    const count = marked(payload.system) + marked(tools) + next.reduce((n, m) => n + marked(m.content), 0);
    if (count < MAX_MARKS || marked(tools)) {
      if (count >= MAX_MARKS) out.tools = tools.map(strip);
      next[was] = withMark(next[was]!, mark);
    }
  }
  return out;
}
