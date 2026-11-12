import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerSecret } from '#lib/util.ts';
import type { Logger } from '#lib/types.ts';

interface StoredLogin {
  apiKey?: string;
  apiKeyExpiresAtMs?: number | string;
  expiresAt?: number | string;
  expires_at?: number | string;
}

/**
 * Resolution order (mirrors @cursor/sdk): explicit apiKey → CURSOR_API_KEY → stored login
 * (~/.cursor/sdk/auth.json, minted by Cursor.auth.login(), ~90 days).
 * Returns { key, source } — `source` is safe to print, `key` never is.
 */
export function resolveApiKey({ explicit }: { explicit?: string } = {}): { key: string; source: string } {
  if (explicit) return done(explicit, 'explicit');
  if (process.env.CURSOR_API_KEY) return done(process.env.CURSOR_API_KEY, 'env:CURSOR_API_KEY');

  const file = process.env.CURSOR_SDK_AUTH_FILE || path.join(os.homedir(), '.cursor', 'sdk', 'auth.json');
  let raw: string;
  try { raw = fs.readFileSync(file, 'utf8'); } catch {
    throw new AuthError('no Cursor credentials: set CURSOR_API_KEY or run Cursor.auth.login() (@cursor/sdk)');
  }
  let data: StoredLogin;
  try { data = JSON.parse(raw) as StoredLogin; } catch { throw new AuthError(`unreadable stored login at ${file}`); }
  if (!data?.apiKey) throw new AuthError(`stored login at ${file} has no apiKey`);

  // @cursor/sdk 1.3.x StoredSdkCredentials: { version, backendUrl, apiKey, apiKeyExpiresAtMs?, email?, createdAtMs }.
  // Absent apiKeyExpiresAtMs = never expires. Older/foreign shapes are tolerated as a fallback.
  const exp = data.apiKeyExpiresAtMs ?? data.expiresAt ?? data.expires_at;
  if (exp != null) {
    const t = typeof exp === 'number' ? (exp < 1e12 ? exp * 1000 : exp) : Date.parse(exp);
    if (Number.isFinite(t) && t <= Date.now()) {
      throw new AuthError('stored Cursor login has expired; run Cursor.auth.login() again');
    }
  }
  try {
    const mode = fs.statSync(file).mode & 0o077;
    if (mode) process.stderr.write(`warn: ${file} is readable by group/other (chmod 600 recommended)\n`);
  } catch { /* ignore */ }
  return done(data.apiKey, 'stored-login');
}

function done(key: string, source: string): { key: string; source: string } {
  registerSecret(key);
  return { key, source };
}

export class AuthError extends Error {}

/**
 * Ensure credentials exist; if not (or expired), run the SDK browser login and persist
 * ~/.cursor/sdk/auth.json (0600). @cursor/sdk is loaded lazily so the tracker core stays
 * dependency-free; only this path needs it. Interactive: the user completes it in a browser.
 */
export async function ensureLogin({ interactive = process.stdin.isTTY, log = console.error, force = false }: {
  interactive?: boolean;
  log?: Logger['error'] | typeof console.error;
  force?: boolean;
} = {}): Promise<{ key: string; source: string }> {
  if (!force) {
    try { return resolveApiKey(); } catch (e: unknown) {
      if (!(e instanceof AuthError)) throw e;
      if (!interactive) throw new AuthError(`${e.message} (non-interactive: run \`tracker login\` first)`);
    }
  }
  let Cursor: typeof import('@cursor/sdk').Cursor;
  try { ({ Cursor } = await import('@cursor/sdk')); } catch {
    throw new AuthError('login needs @cursor/sdk: run `npm i -D @cursor/sdk` in the calliopi workspace');
  }
  if (force) {
    // Clears ~/.cursor/sdk/auth.json only. The old key stays valid until revoked in the dashboard (API Keys).
    const st = await Cursor.auth.status().catch(() => null);
    if (st?.status === 'logged-in') log(`logging out ${st.email || '(unknown email)'} — revoke the old "calliopi-cloud-fanout" key in the dashboard if unused`);
    await Cursor.auth.logout();
  }
  const res = await Cursor.auth.login({
    apiKeyName: 'calliopi-cloud-fanout',
    onLoginUrl: (url) => log(`Open to sign in to Cursor: ${url}`),
  });
  registerSecret(res.apiKey);
  log(`logged in${res.email ? ` as ${res.email}` : ''}; key expires ${new Date(res.apiKeyExpiresAtMs).toISOString().slice(0, 10)}`);
  return resolveApiKey();
}
