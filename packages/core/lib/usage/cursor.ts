// Cursor plan usage, with the Cursor app's login read from its state database (cursorAuth/accessToken)
// through the sqlite3 CLI (node:sqlite would print an ExperimentalWarning into Pi's screen).
//
// Reads, all in parallel; any but the first may fail without hiding the rest:
//   GetCurrentPeriodUsage   (api2, Bearer)  plan share of the cycle, on-demand limit   — the fallback
//   usage-status            (web, cookie)   weekly included budget, per product (Grok Bot, Cursor),
//                                            monthly additional usage, each with its reset
//   GetSandUsageStatus      (api2, Bearer)  Grok Bot's own allowance when it is not in a unified plan
//   GetPlanInfo             (api2, Bearer)  plan name
import { getJson, isRecord, jwtClaims, jwtExpired, num, toEpochMs } from '#lib/usage/shared.ts';
import { UsageError, type Credential, type UsageEnv, type UsageMetric, type UsageSnapshot, type UsageStrategy } from '#lib/usage/types.ts';

const API = 'https://api2.cursor.sh/aiserver.v1.DashboardService';
const USAGE_STATUS_URL = 'https://cursor.com/api/dashboard/v2/usage-status?scope=user';

export function cursorStatePath(env: Pick<UsageEnv, 'home' | 'platform' | 'env'>): string {
  if (env.platform === 'darwin') return `${env.home}/Library/Application Support/Cursor/User/globalStorage/state.vscdb`;
  if (env.platform === 'win32') return `${env.env.APPDATA ?? `${env.home}/AppData/Roaming`}/Cursor/User/globalStorage/state.vscdb`;
  return `${env.env.XDG_CONFIG_HOME || `${env.home}/.config`}/Cursor/User/globalStorage/state.vscdb`;
}

export async function cursorCredential(env: UsageEnv): Promise<Credential> {
  const db = cursorStatePath(env);
  if (!env.exists(db)) throw new UsageError('Cursor 로그인을 찾지 못했습니다. Cursor 앱에 로그인하세요.');
  // -readonly: never write to Cursor's database, even by accident.
  const r = await env.run('sqlite3', ['-readonly', db, "SELECT value FROM ItemTable WHERE key = 'cursorAuth/accessToken'"]);
  if (r.code !== 0) throw new UsageError(r.code === -1 ? 'sqlite3가 필요합니다 (Cursor 로그인 읽기).' : 'Cursor 로그인을 읽지 못했습니다.');
  const token = r.stdout.trim();
  if (!token) throw new UsageError('Cursor 로그인을 찾지 못했습니다. Cursor 앱에 로그인하세요.');
  if (jwtExpired(token, env.now())) throw new UsageError('Cursor 로그인이 만료되었습니다. Cursor 앱을 한 번 여세요.');
  return { token, source: 'Cursor 앱' };
}

/** The cursor.com session cookie the dashboard uses: `<user id>::<access token>` from the JWT subject. */
export function sessionCookie(token: string): string | undefined {
  const sub = jwtClaims(token).sub;
  const userId = typeof sub === 'string' ? sub.split('|').pop()?.trim() : undefined;
  return userId ? `WorkosCursorSessionToken=${userId}%3A%3A${token}` : undefined;
}

const periodOf = (start: unknown, end: unknown) => {
  const s = toEpochMs(start);
  const e = toEpochMs(end);
  return { resetsAt: e, periodMs: s && e && e > s ? e - s : undefined };
};

/** GetCurrentPeriodUsage: the plan's share used this cycle, Auto/API pools, on-demand spend. */
export function mapCursorUsage(body: Record<string, unknown>): UsageMetric[] {
  const cycle = periodOf(body.billingCycleStart, body.billingCycleEnd);
  const metrics: UsageMetric[] = [];
  const plan = body.planUsage;
  if (isRecord(plan)) {
    let total = num(plan.totalPercentUsed);
    const limit = num(plan.limit);
    const spend = num(plan.totalSpend) ?? (limit !== undefined ? limit - (num(plan.remaining) ?? limit) : undefined);
    if (total === undefined && limit && spend !== undefined) total = (spend / limit) * 100;
    if (total !== undefined) metrics.push({ label: '플랜', used: total, limit: 100, unit: 'percent', ...cycle });
    const auto = num(plan.autoPercentUsed);
    const api = num(plan.apiPercentUsed);
    // Separate pools only add information when both are reported.
    if (auto !== undefined && api !== undefined) {
      metrics.push({ label: 'Auto', used: auto, limit: 100, unit: 'percent', ...cycle }, { label: 'API', used: api, limit: 100, unit: 'percent', ...cycle });
    }
  }
  const spendLimit = body.spendLimitUsage;
  if (isRecord(spendLimit)) {
    const limit = num(spendLimit.individualLimit) ?? num(spendLimit.pooledLimit);
    const remaining = num(spendLimit.individualRemaining) ?? num(spendLimit.pooledRemaining);
    if (limit && limit > 0 && remaining !== undefined) {
      metrics.push({ label: '추가 사용', used: Math.max(0, limit - remaining) / 100, limit: limit / 100, unit: 'usd', ...cycle });
    }
  }
  return metrics;
}

/** "grok-bot" → "Grok Bot". */
export const productLabel = (product: string) =>
  product.split(/[-_]/).filter(Boolean).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

/**
 * usage-status: the weekly included budget, what each product (Grok Bot, Cursor) took of it, and the
 * month's additional usage. Amounts are cents. Empty when the account has no weekly budget.
 */
export function mapUsageStatus(body: Record<string, unknown>): UsageMetric[] {
  const metrics: UsageMetric[] = [];
  const weekly = body.weeklyIncludedUsage;
  const budget = isRecord(weekly) ? num(weekly.budgetCents) : undefined;
  if (isRecord(weekly) && budget && budget > 0) {
    const period = periodOf(weekly.periodStart, weekly.resetsAt);
    metrics.push({ label: '주간 포함', used: (num(weekly.usedCents) ?? 0) / 100, limit: budget / 100, unit: 'usd', ...period });
    for (const entry of Array.isArray(body.weeklyIncludedUsageByProduct) ? body.weeklyIncludedUsageByProduct : []) {
      if (!isRecord(entry) || typeof entry.product !== 'string') continue;
      metrics.push({ label: `└ ${productLabel(entry.product)}`, used: (num(entry.cents) ?? 0) / 100, limit: budget / 100, unit: 'usd', ...period });
    }
  }
  const monthly = body.monthlyUsage;
  const limit = isRecord(monthly) ? num(monthly.limitCents) : undefined;
  if (isRecord(monthly) && limit && limit > 0) {
    metrics.push({ label: '월 추가 사용', used: (num(monthly.usedCents) ?? 0) / 100, limit: limit / 100, unit: 'usd', ...periodOf(monthly.periodStart, monthly.resetsAt) });
  }
  return metrics;
}

/**
 * GetSandUsageStatus: Grok Bot's own allowance. In a unified plan it shares the weekly budget (shown
 * per product from usage-status), and pooled or zero allowances have no personal meter.
 */
export function mapGrokBot(body: Record<string, unknown>): UsageMetric | undefined {
  if (body.isUnified === true || body.usesPooledEnterpriseAllowance === true || body.hasNonZeroIncludedLimit === false || body.includedLimitZero === true) return undefined;
  const used = num(body.usagePercent);
  if (used === undefined || used < 0) return undefined;
  return { label: 'Grok Bot', used: Math.min(100, used), limit: 100, unit: 'percent', ...periodOf(body.currentPeriodStart, body.nextResetTimestampUtc) };
}

export function cursorPlan(planInfo: Record<string, unknown> | undefined): string | undefined {
  const info = isRecord(planInfo?.planInfo) ? planInfo.planInfo : undefined;
  const name = typeof info?.planName === 'string' && info.planName.trim() ? info.planName.trim() : undefined;
  return name && planInfo?.isMerged === true ? `${name} (통합)` : name;
}

export const cursor: UsageStrategy = {
  id: 'cursor',
  label: 'Cursor',
  async fetch(env): Promise<UsageSnapshot> {
    const base = { id: 'cursor' as const, label: 'Cursor', metrics: [], fetchedAt: env.now() };
    try {
      const credential = await cursorCredential(env);
      const connect = (method: string) => getJson(env, `${API}/${method}`, {
        method: 'POST', body: '{}',
        headers: { Authorization: `Bearer ${credential.token}`, 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1' },
      }, 'Cursor');
      const cookie = sessionCookie(credential.token);
      const optional = <T>(p: Promise<T>) => p.catch(() => undefined);
      const [usage, status, sand, plan] = await Promise.all([
        connect('GetCurrentPeriodUsage'),
        optional(cookie ? getJson(env, USAGE_STATUS_URL, { headers: { Cookie: cookie } }, 'Cursor') : Promise.reject(new Error('no session'))),
        optional(connect('GetSandUsageStatus')),
        optional(connect('GetPlanInfo')),
      ]);
      // The weekly budget breakdown is the fuller picture; the plan share is the fallback.
      const fromStatus = status ? mapUsageStatus(status) : [];
      const metrics = fromStatus.length ? fromStatus : mapCursorUsage(usage);
      const grok = sand ? mapGrokBot(sand) : undefined;
      if (grok) metrics.push(grok);
      return { ...base, plan: cursorPlan(plan), metrics, source: credential.source };
    } catch (error) {
      return { ...base, error: error instanceof UsageError ? error.message : String(error) };
    }
  },
};
