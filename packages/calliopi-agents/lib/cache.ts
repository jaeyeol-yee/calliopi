// The contract reminder is added at the end of every request and moves on with it. Anthropic's
// payload puts the conversation's cache mark (cache_control) on the last user message, which is the
// reminder: each request then writes a cache entry that ends in the reminder, and the next request,
// whose reminder has moved, can read none of it. Moving the mark to the message before the reminder
// caches the conversation itself; the model is sent the same text. Other payload shapes (OpenAI's
// automatic prefix cache) have no mark and are left alone.
import { CONTRACT_MARK } from '#lib/contract.ts';

type Obj = Record<string, unknown>;
type Block = Obj & { type?: string; text?: string; cache_control?: unknown };
type Message = Obj & { role?: string; content?: unknown };
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const blocks = (m: Message): Block[] => (Array.isArray(m.content) ? m.content.filter(isObj) : []) as Block[];
/** Block types Anthropic accepts a cache mark on, as Pi places it. */
const MARKABLE = new Set(['text', 'image', 'tool_result']);

/** The payload with the cache mark moved off the contract reminder, or undefined when there is nothing to move. */
export function cacheBeforeReminder(payload: unknown): unknown {
  if (!isObj(payload) || !Array.isArray(payload.messages)) return undefined;
  const messages = payload.messages as Message[];
  const at = messages.findLastIndex(m => isObj(m) && blocks(m).some(b => b.type === 'text' && b.text?.startsWith(CONTRACT_MARK)));
  if (at < 1 || !blocks(messages[at]!).some(b => b.cache_control)) return undefined;
  const before = messages[at - 1]!;
  const last = blocks(before).at(-1);
  if (!isObj(before) || before.role !== 'user' || !Array.isArray(before.content) || !last || !MARKABLE.has(String(last.type))) return undefined;
  const mark = blocks(messages[at]!).find(b => b.cache_control)!.cache_control;
  const strip = (b: unknown) => { if (!isObj(b) || !('cache_control' in b)) return b; const { cache_control: _, ...rest } = b; return rest; };
  const next = [...messages];
  next[at] = { ...messages[at], content: (messages[at]!.content as unknown[]).map(strip) };
  next[at - 1] = { ...before, content: [...(before.content as unknown[]).slice(0, -1), { ...last, cache_control: mark }] };
  return { ...payload, messages: next };
}
