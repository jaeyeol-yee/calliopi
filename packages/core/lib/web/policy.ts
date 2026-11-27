// What web_fetch accepts as a URL, and the user's optional host rules (allow, deny, ask).

/** A failure to report to the model as it is (no stack, no internals). */
export class WebFetchError extends Error {}

/** A URL hostname without the brackets of an IPv6 literal or a trailing dot. */
export const bareHost = (hostname: string) =>
  (hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname).replace(/\.$/, '').toLowerCase();

/** The URL to fetch: http(s) only, no credentials, no fragment. Throws WebFetchError. */
export function checkUrl(raw: string): URL {
  let url: URL;
  try { url = new URL(raw.trim()); } catch { throw new WebFetchError(`Not a valid URL: ${raw}`); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new WebFetchError(`Only http and https URLs can be fetched, not ${url.protocol}`);
  if (url.username || url.password) throw new WebFetchError('URLs with credentials (user:password@) are refused.');
  if (!bareHost(url.hostname)) throw new WebFetchError(`No host in ${raw}`);
  url.hash = '';
  return url;
}

/** Host patterns: `example.com` (that host), `*.example.com` (its subdomains, not itself), `*` (any). */
export interface HostRules { allow: string[]; deny: string[]; ask: string[] }

export const NO_RULES: HostRules = { allow: [], deny: [], ask: [] };

export function matchHost(pattern: string, host: string): boolean {
  const p = pattern.trim().toLowerCase().replace(/\.$/, '');
  const h = host.toLowerCase();
  if (p === '*') return true;
  if (p.startsWith('*.')) return h.endsWith(p.slice(1)) && h.length > p.length - 1;
  return p === h;
}

export type Decision = { action: 'allow' } | { action: 'ask' } | { action: 'deny'; why: string };

/** deny wins, then an allow list (when there is one) must match, then ask; otherwise allowed. */
export function decide(rules: HostRules, host: string): Decision {
  const hit = rules.deny.find(p => matchHost(p, host));
  if (hit) return { action: 'deny', why: `${host} is denied by the rule "${hit}"` };
  if (rules.allow.length && !rules.allow.some(p => matchHost(p, host))) return { action: 'deny', why: `${host} is not in the allow list` };
  if (rules.ask.some(p => matchHost(p, host))) return { action: 'ask' };
  return { action: 'allow' };
}

/** Rules from the settings JSON ({ allow?, deny?, ask? } string arrays). Throws on anything else. */
export function parseRules(json: unknown): HostRules {
  if (json === null || typeof json !== 'object' || Array.isArray(json)) throw new WebFetchError('web_fetch settings must be a JSON object');
  const list = (key: keyof HostRules): string[] => {
    const v = (json as Record<string, unknown>)[key];
    if (v === undefined) return [];
    if (!Array.isArray(v) || !v.every(x => typeof x === 'string')) throw new WebFetchError(`web_fetch settings: "${key}" must be an array of host patterns`);
    return v as string[];
  };
  return { allow: list('allow'), deny: list('deny'), ask: list('ask') };
}
