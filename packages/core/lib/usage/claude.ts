// Claude subscription usage: GET api.anthropic.com/api/oauth/usage with a Claude OAuth token.
//
// Credentials, first found wins:
//   1. Pi's own Anthropic login (Pi refreshes it), when it is an OAuth token (sk-ant-oat…)
//   2. Claude Code's ~/.claude/.credentials.json (Linux, or CLAUDE_CONFIG_DIR)
//   3. Claude Code's macOS Keychain item "Claude Code-credentials" (macOS may ask once for access)
import { DAY, HOUR, getJson, isRecord, num, tilde, toEpochMs } from '#lib/usage/shared.ts';
import { UsageError, type Credential, type UsageEnv, type UsageMetric, type UsageSnapshot, type UsageStrategy } from '#lib/usage/types.ts';

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const PROFILE_URL = 'https://api.anthropic.com/api/oauth/profile';
const headers = (token: string) => ({ Authorization: `Bearer ${token.trim()}`, 'anthropic-beta': 'oauth-2025-04-20' });

/** Claude Code's stored credentials: `{ claudeAiOauth: { accessToken, expiresAt } }`. */
export function parseClaudeCodeCredentials(text: string | undefined, now: number): { token?: string; expired?: boolean } {
  if (!text) return {};
  try {
    const oauth = (JSON.parse(text) as { claudeAiOauth?: { accessToken?: unknown; expiresAt?: unknown } }).claudeAiOauth;
    if (typeof oauth?.accessToken !== 'string' || !oauth.accessToken) return {};
    const expiresAt = num(oauth.expiresAt);
    return { token: oauth.accessToken, expired: expiresAt !== undefined && expiresAt < now + 60_000 };
  } catch { return {}; }
}

export async function claudeCredential(env: UsageEnv): Promise<Credential> {
  const pi = await env.piToken?.('anthropic').catch(() => undefined);
  if (pi?.startsWith('sk-ant-oat')) return { token: pi, source: 'Pi 로그인' };

  let expired = false;
  const file = `${env.env.CLAUDE_CONFIG_DIR || `${env.home}/.claude`}/.credentials.json`;
  const fromFile = parseClaudeCodeCredentials(env.readFile(file), env.now());
  if (fromFile.token && !fromFile.expired) return { token: fromFile.token, source: tilde(file, env.home) };
  expired ||= Boolean(fromFile.expired);

  if (env.platform === 'darwin') {
    const r = await env.run('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w']);
    const fromKeychain = parseClaudeCodeCredentials(r.code === 0 ? r.stdout : undefined, env.now());
    if (fromKeychain.token && !fromKeychain.expired) return { token: fromKeychain.token, source: 'Claude Code (Keychain)' };
    expired ||= Boolean(fromKeychain.expired);
  }
  throw new UsageError(expired
    ? 'Claude Code 로그인이 만료되었습니다. Claude Code를 한 번 실행하거나 Pi에서 /login 하세요.'
    : 'Claude 로그인을 찾지 못했습니다. Pi에서 /login(Anthropic) 하거나 Claude Code에 로그인하세요.');
}

const window = (value: unknown, label: string, periodMs: number): UsageMetric | undefined => {
  if (!isRecord(value)) return undefined;
  const used = num(value.utilization);
  return used === undefined ? undefined : { label, used, limit: 100, unit: 'percent', resetsAt: toEpochMs(value.resets_at), periodMs };
};

/** Map /api/oauth/usage to metrics: 5-hour session, weekly, per-model weekly limits, extra usage. */
export function mapClaudeUsage(body: Record<string, unknown>): UsageMetric[] {
  const metrics = [
    window(body.five_hour, '5시간', 5 * HOUR),
    window(body.seven_day, '주간', 7 * DAY),
    window(body.seven_day_opus, '주간 Opus', 7 * DAY),
    window(body.seven_day_sonnet, '주간 Sonnet', 7 * DAY),
  ].filter((m): m is UsageMetric => Boolean(m));
  // Per-model weekly limits now come in `limits` (kind weekly_scoped, scope.model.display_name).
  for (const entry of Array.isArray(body.limits) ? body.limits : []) {
    if (!isRecord(entry) || entry.kind !== 'weekly_scoped') continue;
    const model = isRecord(entry.scope) && isRecord(entry.scope.model) ? entry.scope.model.display_name : undefined;
    const used = num(entry.percent);
    const label = `주간 ${String(model ?? '모델')}`;
    if (used === undefined || metrics.some((m) => m.label === label)) continue;
    // Shown even while inactive (0%): the limit exists and has its own reset.
    metrics.push({ label, used, limit: 100, unit: 'percent', resetsAt: toEpochMs(entry.resets_at), periodMs: 7 * DAY });
  }
  const extra = body.extra_usage;
  if (isRecord(extra) && extra.is_enabled === true) {
    const scale = 10 ** (num(extra.decimal_places) ?? 2);
    const used = (num(extra.used_credits) ?? 0) / scale;
    const limit = num(extra.monthly_limit);
    metrics.push({ label: '추가 사용', used, limit: limit && limit > 0 ? limit / scale : undefined, unit: 'usd' });
  }
  return metrics;
}

/** "claude_max" + "default_claude_max_20x" → "Max 20x". */
export function claudePlan(profile: Record<string, unknown> | undefined): string | undefined {
  const org = isRecord(profile?.organization) ? profile.organization : undefined;
  const type = typeof org?.organization_type === 'string' ? org.organization_type.replace(/^claude_/, '') : undefined;
  if (!type) return undefined;
  const base = type.charAt(0).toUpperCase() + type.slice(1);
  const tier = typeof org?.rate_limit_tier === 'string' ? org.rate_limit_tier.match(/\d+x/)?.[0] : undefined;
  return tier ? `${base} ${tier}` : base;
}

export const claude: UsageStrategy = {
  id: 'claude',
  label: 'Claude',
  async fetch(env): Promise<UsageSnapshot> {
    const base = { id: 'claude' as const, label: 'Claude', metrics: [], fetchedAt: env.now() };
    try {
      const credential = await claudeCredential(env);
      const [usage, profile] = await Promise.all([
        getJson(env, USAGE_URL, { headers: headers(credential.token) }, 'Claude'),
        getJson(env, PROFILE_URL, { headers: headers(credential.token) }, 'Claude').catch(() => undefined),
      ]);
      return { ...base, plan: claudePlan(profile), metrics: mapClaudeUsage(usage), source: credential.source };
    } catch (error) {
      return { ...base, error: error instanceof UsageError ? error.message : String(error) };
    }
  },
};
