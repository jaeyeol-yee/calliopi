// Every model request a child sends, recorded as it went out (Pi's before_provider_request payload),
// so a viewer can show exactly what the model was given. Consecutive requests repeat most of each
// other (the conversation only grows), so each record keeps what changed: top-level keys that
// differ, and for arrays (messages, input, contents …) the shared prefix length and the new tail.
// The payload shape is the provider's; nothing here depends on it.

export interface RequestRecord {
  seq: number;
  at: number;
  /** Keys whose value changed (or array tails, see `prefix`). */
  set: Record<string, unknown>;
  /** For an array key in `set`: how many leading items are the previous request's. */
  prefix?: Record<string, number>;
  /** Keys the previous request had and this one has not. */
  drop?: string[];
  /** A payload that is not a plain object is kept whole. */
  whole?: unknown;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export function encodeRequest(prev: unknown, next: unknown, seq: number, at: number): RequestRecord {
  if (!isObj(next)) return { seq, at, set: {}, whole: next ?? null }; // JSON has no undefined
  const before = isObj(prev) ? prev : {};
  const record: RequestRecord = { seq, at, set: {} };
  for (const [key, value] of Object.entries(next)) {
    if (value === undefined) continue; // not sent: treated as absent (dropped below)
    const old = before[key];
    if (key in before && same(old, value)) continue;
    if (Array.isArray(value) && Array.isArray(old)) {
      let k = 0;
      while (k < value.length && k < old.length && same(value[k], old[k])) k++;
      if (k > 0) (record.prefix ??= {})[key] = k;
      record.set[key] = value.slice(k);
    } else record.set[key] = value;
  }
  const drop = Object.keys(before).filter(k => next[k] === undefined);
  if (drop.length) record.drop = drop;
  return record;
}

export function decodeRequest(prev: unknown, record: RequestRecord): unknown {
  if ('whole' in record) return record.whole;
  const out: Obj = isObj(prev) ? { ...prev } : {};
  for (const key of record.drop ?? []) delete out[key];
  for (const [key, value] of Object.entries(record.set)) {
    const k = record.prefix?.[key];
    // A prefix needs the earlier array; without it (a torn or missing earlier record) keep what there is.
    out[key] = k ? [...(Array.isArray(out[key]) ? out[key].slice(0, k) : []), ...(Array.isArray(value) ? value : [value])] : value;
  }
  return out;
}

/** Full payloads from a requests.jsonl file's text, in order; a torn last line is skipped. */
export function decodeRequests(text: string): { seq: number; at: number; payload: unknown }[] {
  const out: { seq: number; at: number; payload: unknown }[] = [];
  let prev: unknown;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let record: RequestRecord;
    try { record = JSON.parse(line) as RequestRecord; } catch { break; }
    try { prev = decodeRequest(prev, record); } catch { break; }
    out.push({ seq: record.seq, at: record.at, payload: prev });
  }
  return out;
}
