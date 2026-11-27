// One page over HTTP(S), safely: the host is resolved by us and every address checked before the
// connection uses it (so a name cannot be rebound to a private address in between), redirects are
// followed only within the same origin (an http -> https upgrade of the same host included) and
// re-checked on every hop, the body is cut at a size cap after decompression, and the whole fetch
// has a deadline. Only text comes back: HTML as readable text, other text types as they are.
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import zlib from 'node:zlib';
import type { Readable } from 'node:stream';
import { isPublicAddress } from '#lib/web/address.ts';
import { htmlToText } from '#lib/web/html.ts';
import { WebFetchError, bareHost, checkUrl } from '#lib/web/policy.ts';

export interface FetchOptions {
  signal?: AbortSignal;
  /** The whole fetch, redirects included. */
  timeoutMs?: number;
  /** Body bytes kept after decompression; the rest is cut. */
  maxBytes?: number;
  maxRedirects?: number;
  /** Which resolved addresses may be connected to. Tests widen it to the loopback. */
  allowAddress?: (ip: string) => boolean;
  /** Host name to addresses. Tests answer for their own names. */
  resolve?: (host: string) => Promise<string[]>;
}

export interface FetchedPage {
  /** What was asked for, and where the content came from after same-origin redirects. */
  requested: string;
  url: string;
  status: number;
  contentType: string;
  title?: string;
  text: string;
  bytes: number;
  /** The body was longer than the size cap. */
  cut: boolean;
  /** A redirect to another origin, not followed: fetch it if it is wanted. */
  redirect?: string;
  fetchedAt: number;
}

export const DEFAULTS = { timeoutMs: 30_000, maxBytes: 5 * 1024 * 1024, maxRedirects: 5 };
const USER_AGENT = 'Mozilla/5.0 (compatible; calliopi-web-fetch/1; +https://github.com/jaeyeol-yee/calliopi)';

const resolveAll = (host: string) => dns.promises.lookup(host, { all: true, verbatim: true }).then(r => r.map(a => a.address));

const TEXTUAL = /^(text\/[\w.+-]+|application\/([\w.-]+\+)?(json|xml)|application\/(javascript|ecmascript|x-javascript|x-ndjson|ndjson|yaml|x-yaml|toml|x-sh|sql|graphql|x-www-form-urlencoded))$/;
const isHtmlType = (t: string) => t === 'text/html' || t === 'application/xhtml+xml';

/** Media type and charset from a Content-Type header. */
export function parseContentType(header: string | undefined): { type: string; charset?: string } {
  const [type = '', ...params] = (header ?? '').split(';').map(s => s.trim());
  const charset = params.map(p => /^charset\s*=\s*"?([^";\s]+)"?$/i.exec(p)?.[1]).find(Boolean);
  return { type: type.toLowerCase(), charset };
}

/** Bytes to text: the declared charset, else a charset declared in an HTML head, else UTF-8. */
export function decodeBody(body: Buffer, charset: string | undefined, html: boolean): string {
  let label = charset;
  if (!label && html) {
    const head = body.subarray(0, 4096).toString('latin1');
    label = /<meta[^>]+charset\s*=\s*["']?\s*([\w.:-]+)/i.exec(head)?.[1];
  }
  try { return new TextDecoder(label || 'utf-8').decode(body); } catch { return new TextDecoder('utf-8').decode(body); }
}

/** Control characters other than tab and newline off; CRLF and CR as LF. */
export const cleanText = (s: string) => s.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '');

interface Hop { status: number; headers: http.IncomingHttpHeaders; body: Buffer; cut: boolean }

/** The connection's address lookup: resolve, refuse if any address is not allowed, hand over the checked ones. */
function pinnedLookup(resolve: (host: string) => Promise<string[]>, allow: (ip: string) => boolean): net.LookupFunction {
  return ((hostname: string, options: dns.LookupOptions, callback: (...a: unknown[]) => void) => {
    resolve(hostname).then(addresses => {
      if (!addresses.length) throw new WebFetchError(`${hostname} has no address`);
      const refused = addresses.find(a => !allow(a));
      if (refused) throw new WebFetchError(`${hostname} resolves to ${refused}, which is not a public internet address: refused.`);
      const family = options?.family === 6 ? 6 : options?.family === 4 ? 4 : 0;
      const list = addresses.map(address => ({ address, family: net.isIP(address) })).filter(a => !family || a.family === family);
      if (!list.length) throw new WebFetchError(`${hostname} has no IPv${family} address`);
      if (options?.all) callback(null, list);
      else callback(null, list[0]!.address, list[0]!.family);
    }).catch(error => callback(error));
  }) as net.LookupFunction;
}

function decoder(encoding: string | undefined): zlib.Gunzip | zlib.Inflate | zlib.BrotliDecompress | null {
  const e = (encoding ?? '').trim().toLowerCase();
  if (!e || e === 'identity') return null;
  if (e === 'gzip' || e === 'x-gzip') return zlib.createGunzip();
  if (e === 'deflate') return zlib.createInflate();
  if (e === 'br') return zlib.createBrotliDecompress();
  throw new WebFetchError(`Unsupported content encoding: ${e}`);
}

function hop(url: URL, o: Required<Pick<FetchOptions, 'maxBytes'>> & FetchOptions, signal: AbortSignal): Promise<Hop> {
  const allow = o.allowAddress ?? isPublicAddress;
  const host = bareHost(url.hostname);
  if (net.isIP(host) && !allow(host)) return Promise.reject(new WebFetchError(`${host} is not a public internet address: refused.`));
  return new Promise<Hop>((resolve, reject) => {
    const request = (url.protocol === 'https:' ? https : http).request(url, {
      // agent: false: a fresh connection through our lookup; no proxy from the environment is used.
      method: 'GET', agent: false, signal,
      lookup: pinnedLookup(o.resolve ?? resolveAll, allow),
      headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,application/json;q=0.9,*/*;q=0.5', 'accept-encoding': 'gzip, deflate, br' },
    }, response => {
      const status = response.statusCode ?? 0;
      if (status >= 300 && status < 400 && response.headers.location) {
        response.resume();
        return resolve({ status, headers: response.headers, body: Buffer.alloc(0), cut: false });
      }
      const { type } = parseContentType(response.headers['content-type']);
      if (type && !TEXTUAL.test(type)) {
        response.destroy();
        return reject(new WebFetchError(`Cannot read ${type} content: web_fetch returns text (HTML, plain text, JSON, XML).`));
      }
      let stream: Readable = response;
      try {
        const d = decoder(response.headers['content-encoding']);
        if (d) stream = response.pipe(d);
      } catch (error) { response.destroy(); return reject(error); }
      const chunks: Buffer[] = [];
      let size = 0;
      let done = false;
      const finish = (cut: boolean) => {
        if (done) return;
        done = true;
        resolve({ status, headers: response.headers, body: Buffer.concat(chunks, size), cut });
      };
      stream.on('data', (chunk: Buffer) => {
        if (done) return;
        const room = o.maxBytes - size;
        if (chunk.length > room) {
          chunks.push(chunk.subarray(0, room)); size += room;
          finish(true);
          response.destroy(); stream.destroy();
          return;
        }
        chunks.push(chunk); size += chunk.length;
      });
      stream.on('end', () => finish(false));
      stream.on('error', error => { if (!done) { done = true; reject(error); } });
      response.on('error', error => { if (!done) { done = true; reject(error); } });
    });
    request.on('error', reject);
    request.end();
  });
}

/** Fetch `raw` and return its text. Throws WebFetchError for anything to tell the model. */
export async function fetchPage(raw: string, options: FetchOptions = {}): Promise<FetchedPage> {
  const o = { ...DEFAULTS, ...options };
  const requested = checkUrl(raw);
  const deadline = AbortSignal.timeout(o.timeoutMs);
  const signal = o.signal ? AbortSignal.any([o.signal, deadline]) : deadline;
  let url = requested;
  try {
    for (let redirects = 0; ; redirects++) {
      const r = await hop(url, o, signal);
      const location = r.status >= 300 && r.status < 400 ? r.headers.location : undefined;
      if (location) {
        let next: URL;
        try { next = checkUrl(new URL(location, url).href); } catch (error) {
          throw new WebFetchError(`${url.href} redirects to ${location}, which cannot be fetched: ${(error as Error).message}`);
        }
        // http -> https of the same host, default ports only: not a way to reach another port of the host.
        const upgrade = url.protocol === 'http:' && next.protocol === 'https:' && url.hostname === next.hostname && url.port === '' && next.port === '';
        if (next.origin !== url.origin && !upgrade) {
          return { requested: requested.href, url: url.href, status: r.status, contentType: '', text: '', bytes: 0, cut: false, redirect: next.href, fetchedAt: Date.now() };
        }
        if (redirects >= o.maxRedirects) throw new WebFetchError(`Too many redirects (more than ${o.maxRedirects}) from ${requested.href}`);
        url = next;
        continue;
      }
      const { type, charset } = parseContentType(r.headers['content-type']);
      if (!type && r.body.subarray(0, 1024).includes(0)) throw new WebFetchError('The response looks binary: web_fetch returns text only.');
      const sniffedHtml = !type && /^\s*(<!doctype html|<html[\s>])/i.test(r.body.subarray(0, 512).toString('latin1'));
      const html = isHtmlType(type) || sniffedHtml;
      const decoded = decodeBody(r.body, charset, html);
      const page = html ? htmlToText(decoded, url.href) : { text: decoded, title: undefined };
      return {
        requested: requested.href, url: url.href, status: r.status, contentType: type || (html ? 'text/html' : 'text/plain'),
        title: page.title === undefined ? undefined : cleanText(page.title), text: cleanText(page.text), bytes: r.body.length, cut: r.cut, fetchedAt: Date.now(),
      };
    }
  } catch (error) {
    if (error instanceof WebFetchError) throw error;
    if (deadline.aborted) throw new WebFetchError(`Timed out after ${Math.round(o.timeoutMs / 1000)}s fetching ${url.href}`);
    if (o.signal?.aborted) throw new WebFetchError('Cancelled.');
    const e = error as NodeJS.ErrnoException;
    throw new WebFetchError(`Could not fetch ${url.href}: ${e.code ?? e.message}`);
  }
}
