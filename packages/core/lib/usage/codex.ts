// Codex (ChatGPT plan) usage: GET chatgpt.com/backend-api/wham/usage with the Codex CLI's login,
// read from $CODEX_HOME/auth.json (default ~/.codex). An API-key-only login has no plan usage.
import { DAY, HOUR, getJson, isRecord, jwtClaims, jwtExpired, num, tilde, toEpochMs } from '#lib/usage/shared.ts';
import { UsageError, type Credential, type UsageEnv, type UsageMetric, type UsageSnapshot, type UsageStrategy } from '#lib/usage/types.ts';

const USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';

export function codexCredential(env: UsageEnv): Credential {
  const file = `${env.env.CODEX_HOME || `${env.home}/.codex`}/auth.json`;
  const text = env.readFile(file);
  if (!text) throw new UsageError('Codex 로그인을 찾지 못했습니다. Codex CLI에서 ChatGPT로 로그인하세요.');
  let tokens: { access_token?: unknown; account_id?: unknown } | undefined;
  try { tokens = (JSON.parse(text) as { tokens?: typeof tokens }).tokens; } catch { /* unreadable */ }
  const token = typeof tokens?.access_token === 'string' ? tokens.access_token : undefined;
  if (!token) throw new UsageError('Codex가 ChatGPT 로그인이 아닙니다 (API 키 로그인에는 플랜 사용량이 없습니다).');
  if (jwtExpired(token, env.now())) throw new UsageError('Codex 로그인이 만료되었습니다. Codex CLI를 한 번 실행하세요.');
  const claim = jwtClaims(token)['https://api.openai.com/auth'];
  const accountId = typeof tokens?.account_id === 'string' ? tokens.account_id
    : isRecord(claim) && typeof claim.chatgpt_account_id === 'string' ? claim.chatgpt_account_id : undefined;
  return { token, source: tilde(file, env.home), extra: accountId ? { accountId } : undefined };
}

/** 18000 s → "5시간", 604800 s → "주간". */
export function windowLabel(seconds: number | undefined, prefix = ''): string {
  const name = seconds === 7 * DAY / 1000 ? '주간' : seconds === undefined ? '한도'
    : seconds % (DAY / 1000) === 0 ? `${seconds / (DAY / 1000)}일` : `${Math.round(seconds / (HOUR / 1000))}시간`;
  return prefix ? `${prefix} ${name}` : name;
}

function windows(rateLimit: unknown, prefix = ''): UsageMetric[] {
  if (!isRecord(rateLimit)) return [];
  return [rateLimit.primary_window, rateLimit.secondary_window].flatMap((w) => {
    if (!isRecord(w)) return [];
    const used = num(w.used_percent);
    if (used === undefined) return [];
    const seconds = num(w.limit_window_seconds);
    return [{ label: windowLabel(seconds, prefix), used, limit: 100, unit: 'percent' as const, resetsAt: toEpochMs(w.reset_at), periodMs: seconds ? seconds * 1000 : undefined }];
  });
}

/** Map wham/usage: the plan's windows, extra model limits, and the credit balance. */
export function mapCodexUsage(body: Record<string, unknown>): UsageMetric[] {
  const metrics = windows(body.rate_limit);
  for (const entry of Array.isArray(body.additional_rate_limits) ? body.additional_rate_limits : []) {
    if (!isRecord(entry)) continue;
    const name = typeof entry.limit_name === 'string' ? entry.limit_name : typeof entry.metered_feature === 'string' ? entry.metered_feature : '추가';
    metrics.push(...windows(entry.rate_limit, name));
  }
  const credits = body.credits;
  if (isRecord(credits) && credits.has_credits === true && credits.unlimited !== true) {
    const balance = num(credits.balance);
    if (balance !== undefined) metrics.push({ label: '크레딧', used: balance, unit: 'credits' });
  }
  return metrics;
}

export const codexPlan = (value: unknown) => (typeof value === 'string' && value ? value.charAt(0).toUpperCase() + value.slice(1) : undefined);

export const codex: UsageStrategy = {
  id: 'codex',
  label: 'Codex',
  async fetch(env): Promise<UsageSnapshot> {
    const base = { id: 'codex' as const, label: 'Codex', metrics: [], fetchedAt: env.now() };
    try {
      const credential = codexCredential(env);
      const body = await getJson(env, USAGE_URL, {
        headers: { Authorization: `Bearer ${credential.token}`, ...(credential.extra?.accountId ? { 'ChatGPT-Account-Id': credential.extra.accountId } : {}) },
      }, 'ChatGPT');
      return { ...base, plan: codexPlan(body.plan_type), metrics: mapCodexUsage(body), source: credential.source };
    } catch (error) {
      return { ...base, error: error instanceof UsageError ? error.message : String(error) };
    }
  },
};
