// Helpers shared by the usage strategies: JSON over HTTP with a timeout, JWT claims, time parsing.
import { UsageError, type UsageEnv } from '#lib/usage/types.ts';

export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;

/** Decoded JWT payload (no signature check: only for expiry and ids of our own tokens). */
export function jwtClaims(token: string): Record<string, unknown> {
  try { return JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')) as Record<string, unknown>; } catch { return {}; }
}

/** True when a JWT's `exp` has passed (with a minute of slack). Unknown expiry counts as valid. */
export function jwtExpired(token: string, now: number): boolean {
  const exp = jwtClaims(token).exp;
  return typeof exp === 'number' && exp * 1000 < now + 60_000;
}

/** Epoch ms from an ISO string, epoch seconds or epoch ms (number or numeric string). */
export function toEpochMs(value: unknown): number | undefined {
  if (typeof value === 'string' && value.trim() && !/^\d+(\.\d+)?$/.test(value.trim())) {
    const t = Date.parse(value);
    return Number.isNaN(t) ? undefined : t;
  }
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return n < 1e11 ? n * 1000 : n;
}

export const num = (v: unknown): number | undefined => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
};

export const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Fetch JSON; auth failures and other HTTP errors become UsageErrors with a readable message. */
export async function getJson(env: UsageEnv, url: string, init: RequestInit, who: string): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await env.fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
  } catch (error) {
    throw new UsageError(`${who}에 연결하지 못했습니다 (${error instanceof Error ? error.message : String(error)})`);
  }
  if (response.status === 401 || response.status === 403) {
    throw new UsageError(`${who} 인증이 거부되었습니다 (HTTP ${response.status}). 로그인을 갱신하세요.`);
  }
  if (!response.ok) throw new UsageError(`${who} 응답 오류 (HTTP ${response.status})`);
  const body = await response.json().catch(() => undefined) as unknown;
  if (!isRecord(body)) throw new UsageError(`${who} 응답을 읽지 못했습니다`);
  return body;
}

/** `~/…` for display. */
export const tilde = (path: string, home: string) => (path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path);
