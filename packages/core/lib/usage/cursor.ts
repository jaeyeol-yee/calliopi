// Cursor plan usage, with the Cursor app's login read from its state database (cursorAuth/accessToken)
// through the sqlite3 CLI (node:sqlite would print an ExperimentalWarning into Pi's screen).
//
// Rows follow OpenUsage's Cursor provider (docs/providers.md#cursor), in percent like the dashboard:
//   전체                 totalPercentUsed of the included usage, resets with the billing cycle
//   └ Grok Bot, └ Cursor (unified plans) each product's share of the same weekly pool — not in
//                        OpenUsage, which shows only the total for a unified plan
//   Cursor 모델, 기타 모델, Grok Bot   (separate plans) the Auto/API pools and Grok Bot's own allowance
//   추가 사용            on-demand spend against its limit: the month's additional usage on a unified
//                        plan, the cycle's spend limit otherwise
//   크레딧 잔액          (unified plans) the credit balance
//
// Reads, all in parallel; any but the first may fail without hiding the rest:
//   GetCurrentPeriodUsage   (api2, Bearer)  total and pool percentages, billing cycle, spend limit
//   usage-status            (web, cookie)   weekly pool by product, monthly additional usage
//   GetSandUsageStatus      (api2, Bearer)  Grok Bot's allowance, whether the plan is unified
//   GetPlanInfo             (api2, Bearer)  plan name, whether the plan is unified
//   GetComplatCreditBalance (api2, Bearer)  credit balance of a unified plan
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

export interface CursorParts {
  usage: Record<string, unknown>;
  status?: Record<string, unknown>;
  sand?: Record<string, unknown>;
  planInfo?: Record<string, unknown>;
  credits?: Record<string, unknown>;
}

/** Cursor, X and Grok merged into one plan with one weekly included pool. */
export const isUnified = (p: Pick<CursorParts, 'planInfo' | 'sand'>) => p.planInfo?.isMerged === true || p.sand?.isUnified === true;

/** "grok-bot" → "Grok Bot". */
export const productLabel = (product: string) =>
  product.split(/[-_]/).filter(Boolean).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

/** Grok Bot's own allowance; none in a unified plan (it shares the pool) or with a pooled or zero one. */
export function mapGrokBot(body: Record<string, unknown>): UsageMetric | undefined {
  if (body.isUnified === true || body.usesPooledEnterpriseAllowance === true || body.hasNonZeroIncludedLimit === false || body.includedLimitZero === true) return undefined;
  const used = num(body.usagePercent);
  if (used === undefined || used < 0) return undefined;
  return { label: 'Grok Bot', used: Math.min(100, used), limit: 100, unit: 'percent', ...periodOf(body.currentPeriodStart, body.nextResetTimestampUtc) };
}

/** Each product's share of a unified plan's weekly pool, in percent of the pool. */
export function mapProducts(status: Record<string, unknown> | undefined): UsageMetric[] {
  const weekly = status?.weeklyIncludedUsage;
  const budget = isRecord(weekly) ? num(weekly.budgetCents) : undefined;
  if (!isRecord(weekly) || !budget || budget <= 0) return [];
  const period = periodOf(weekly.periodStart, weekly.resetsAt);
  return (Array.isArray(status!.weeklyIncludedUsageByProduct) ? status!.weeklyIncludedUsageByProduct : []).flatMap((entry) =>
    isRecord(entry) && typeof entry.product === 'string'
      ? [{ label: `└ ${productLabel(entry.product)}`, used: ((num(entry.cents) ?? 0) / budget) * 100, limit: 100, unit: 'percent' as const, ...period }]
      : []);
}

/** On-demand spend: positive reported spend, else what the limit minus the remainder implies. */
function onDemandCents(reported: (number | undefined)[], limit: number, remaining: number | undefined): number {
  const values = reported.filter((n): n is number => n !== undefined);
  const positive = values.find((n) => n > 0);
  if (positive !== undefined) return positive;
  const inferred = remaining !== undefined ? Math.max(0, limit - remaining) : 0;
  return inferred > 0 ? inferred : values[0] ?? 0;
}

/** The dashboard's Additional usage card on a unified plan: this month's spend past the pool. */
function monthlyAdditional(status: Record<string, unknown> | undefined): UsageMetric | undefined {
  const monthly = status?.monthlyUsage;
  if (!isRecord(monthly) || (status!.availability ?? 'available') !== 'available' || monthly.additionalUsageOff === true) return undefined;
  const limit = num(monthly.limitCents);
  if (limit === 0) return undefined; // additional usage off
  const used = Math.max(0, num(monthly.usedCents) ?? 0) / 100;
  if (limit === undefined || limit < 0) return { label: '추가 사용', used, unit: 'usd' };
  return { label: '추가 사용', used, limit: limit / 100, unit: 'usd', ...periodOf(monthly.periodStart, monthly.resetsAt) };
}

/** The spend limit on a separate plan, over the billing cycle. */
function spendLimit(usage: Record<string, unknown>, cycle: ReturnType<typeof periodOf>): UsageMetric | undefined {
  const s = usage.spendLimitUsage;
  if (!isRecord(s)) return undefined;
  const individual = num(s.individualLimit);
  const pooled = num(s.pooledLimit) ?? 0;
  const [limit, spent, remaining] = individual !== undefined
    ? [individual, [num(s.individualUsed), num(s.totalSpend)], num(s.individualRemaining)]
    : pooled > 0 ? [pooled, [num(s.pooledUsed)], num(s.pooledRemaining)] : [0, [num(s.individualUsed), num(s.pooledUsed), num(s.totalSpend)], undefined];
  const cents = onDemandCents(spent, limit, remaining);
  if (limit > 0) return { label: '추가 사용', used: cents / 100, limit: limit / 100, unit: 'usd', ...cycle };
  return cents > 0 ? { label: '추가 사용', used: cents / 100, unit: 'usd' } : undefined;
}

/** All rows for Cursor, from whatever reads answered (only GetCurrentPeriodUsage is required). */
export function mapCursor(parts: CursorParts): UsageMetric[] {
  const { usage } = parts;
  if (usage.enabled === false || !isRecord(usage.planUsage)) throw new UsageError('활성화된 Cursor 구독이 없습니다.');
  const plan = usage.planUsage;
  const cycle = periodOf(usage.billingCycleStart, usage.billingCycleEnd);
  const unified = isUnified(parts);
  const metrics: UsageMetric[] = [];

  const limit = num(plan.limit);
  const spend = num(plan.totalSpend) ?? (limit !== undefined ? limit - (num(plan.remaining) ?? 0) : undefined);
  const total = num(plan.totalPercentUsed) ?? (limit && spend !== undefined ? (spend / limit) * 100 : undefined);
  if (total !== undefined) metrics.push({ label: '전체', used: total, limit: 100, unit: 'percent', ...cycle });

  if (unified) {
    metrics.push(...mapProducts(parts.status));
  } else {
    const auto = num(plan.autoPercentUsed);
    const api = num(plan.apiPercentUsed);
    if (auto !== undefined) metrics.push({ label: 'Cursor 모델', used: auto, limit: 100, unit: 'percent', ...cycle });
    if (api !== undefined) metrics.push({ label: '기타 모델', used: api, limit: 100, unit: 'percent', ...cycle });
    const grok = parts.sand ? mapGrokBot(parts.sand) : undefined;
    if (grok) metrics.push(grok);
  }

  const extra = unified ? monthlyAdditional(parts.status) : spendLimit(usage, cycle);
  if (extra) metrics.push(extra);
  if (unified && parts.credits) {
    metrics.push({ label: '크레딧 잔액', used: Math.max(0, num(parts.credits.usdRemainingCents) ?? 0) / 100, unit: 'usd' });
  }
  return metrics;
}

/** Plan name, title-cased, marked when unified. */
export function cursorPlan(parts: Pick<CursorParts, 'planInfo' | 'sand'>): string | undefined {
  const info = isRecord(parts.planInfo?.planInfo) ? parts.planInfo.planInfo : undefined;
  const raw = typeof info?.planName === 'string' ? info.planName.trim() : '';
  const name = raw.split(/\s+/).filter(Boolean).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  if (!name) return undefined;
  return isUnified(parts) ? `${name} (통합)` : name;
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
      const optional = (p: Promise<Record<string, unknown>>) => p.catch(() => undefined);
      const [usage, status, sand, planInfo, credits] = await Promise.all([
        connect('GetCurrentPeriodUsage'),
        cookie ? optional(getJson(env, USAGE_STATUS_URL, { headers: { Cookie: cookie } }, 'Cursor')) : undefined,
        optional(connect('GetSandUsageStatus')),
        optional(connect('GetPlanInfo')),
        optional(connect('GetComplatCreditBalance')),
      ]);
      const parts = { usage, status, sand, planInfo, credits };
      return { ...base, plan: cursorPlan(parts), metrics: mapCursor(parts), source: credential.source };
    } catch (error) {
      return { ...base, error: error instanceof UsageError ? error.message : String(error) };
    }
  },
};
