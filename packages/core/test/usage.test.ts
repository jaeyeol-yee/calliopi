import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Capture } from '#lib/capture.ts';
import { claudeCredential, claudePlan, mapClaudeUsage } from '#lib/usage/claude.ts';
import { codexCredential, mapCodexUsage, windowLabel } from '#lib/usage/codex.ts';
import { cursor, cursorCredential, cursorPlan, cursorStatePath, mapCursorUsage, mapGrokBot, mapUsageStatus, productLabel, sessionCookie } from '#lib/usage/cursor.ts';
import { defaultEnv, fetchUsage, type UsageEnv } from '#lib/usage/index.ts';
import { toEpochMs } from '#lib/usage/shared.ts';

const NOW = Date.UTC(2026, 10, 25);
const jwt = (claims: Record<string, unknown>) => `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;

/** A fake machine: files, commands and HTTP answers by URL. Records requests. */
function env(opts: {
  files?: Record<string, string>; commands?: Record<string, string>; http?: Record<string, [number, unknown]>;
  pi?: Record<string, string>; platform?: NodeJS.Platform;
} = {}) {
  const requests: { url: string; headers: Record<string, string> }[] = [];
  const run: Capture = async (command, args) => {
    const out = opts.commands?.[[command, ...args].join(' ')];
    return out === undefined ? { code: 1, stdout: '', stderr: '' } : { code: 0, stdout: out, stderr: '' };
  };
  const e: UsageEnv = defaultEnv({
    run, home: '/h', platform: opts.platform ?? 'linux', env: {}, now: () => NOW,
    readFile: (p) => opts.files?.[p],
    exists: (p) => p in (opts.files ?? {}),
    piToken: async (p) => opts.pi?.[p],
    fetch: (async (url: string, init: RequestInit) => {
      requests.push({ url, headers: init.headers as Record<string, string> });
      const [status, body] = opts.http?.[url] ?? [404, {}];
      return new Response(JSON.stringify(body), { status });
    }) as typeof fetch,
  });
  return { env: e, requests };
}

const CLAUDE_USAGE = {
  five_hour: null,
  seven_day: { utilization: 4, resets_at: '2026-11-30T02:00:00.494784+00:00' },
  limits: [
    { kind: 'weekly_all', percent: 4 },
    { kind: 'weekly_scoped', percent: 12, is_active: true, resets_at: '2026-11-30T02:00:00Z', scope: { model: { display_name: 'Fable' } } },
    { kind: 'weekly_scoped', percent: 0, is_active: false, scope: { model: { display_name: 'Idle' } } },
  ],
  extra_usage: { is_enabled: true, used_credits: 1234, monthly_limit: 5000, decimal_places: 2 },
};

test('Claude: windows, every per-model weekly limit (inactive ones too) and extra usage; plan from the profile', () => {
  assert.deepEqual(mapClaudeUsage(CLAUDE_USAGE).map((m) => [m.label, m.used, m.limit, m.unit]), [
    ['주간', 4, 100, 'percent'], ['주간 Fable', 12, 100, 'percent'], ['주간 Idle', 0, 100, 'percent'], ['추가 사용', 12.34, 50, 'usd'],
  ]);
  assert.equal(mapClaudeUsage(CLAUDE_USAGE)[0]!.resetsAt, Date.parse('2026-11-30T02:00:00.494Z'));
  assert.equal(claudePlan({ organization: { organization_type: 'claude_max', rate_limit_tier: 'default_claude_max_20x' } }), 'Max 20x');
  assert.equal(claudePlan({ organization: { organization_type: 'claude_pro' } }), 'Pro');
  assert.equal(claudePlan(undefined), undefined);
});

test("Claude credentials: Pi's OAuth login first, then Claude Code's file, then the macOS Keychain", async () => {
  const fresh = JSON.stringify({ claudeAiOauth: { accessToken: 'sk-ant-oat-file', expiresAt: NOW + 3_600_000 } });
  const stale = JSON.stringify({ claudeAiOauth: { accessToken: 'sk-ant-oat-old', expiresAt: NOW - 1 } });
  const keychain = JSON.stringify({ claudeAiOauth: { accessToken: 'sk-ant-oat-kc', expiresAt: NOW + 3_600_000 } });
  const kc = { 'security find-generic-password -s Claude Code-credentials -w': keychain };
  assert.equal((await claudeCredential(env({ pi: { anthropic: 'sk-ant-oat-pi' }, files: { '/h/.claude/.credentials.json': fresh } }).env)).source, 'Pi 로그인');
  assert.equal((await claudeCredential(env({ pi: { anthropic: 'sk-ant-api-key' }, files: { '/h/.claude/.credentials.json': fresh } }).env)).token, 'sk-ant-oat-file', 'an API key has no plan usage');
  assert.equal((await claudeCredential(env({ files: { '/h/.claude/.credentials.json': stale }, commands: kc, platform: 'darwin' }).env)).source, 'Claude Code (Keychain)');
  await assert.rejects(claudeCredential(env({ files: { '/h/.claude/.credentials.json': stale } }).env), /만료/);
  await assert.rejects(claudeCredential(env().env), /찾지 못했습니다/);
});

test('Codex: windows named by length, extra model limits, credits; credential and account id', async () => {
  const body = {
    plan_type: 'plus',
    rate_limit: { primary_window: { used_percent: 30, limit_window_seconds: 18000, reset_at: 1795613131 }, secondary_window: { used_percent: 5, limit_window_seconds: 604800, reset_at: 1796000000 } },
    additional_rate_limits: [{ limit_name: 'Spark', rate_limit: { primary_window: { used_percent: 50, limit_window_seconds: 604800 } } }],
    credits: { has_credits: true, unlimited: false, balance: '120' },
  };
  assert.deepEqual(mapCodexUsage(body).map((m) => [m.label, m.used, m.unit]), [['5시간', 30, 'percent'], ['주간', 5, 'percent'], ['Spark 주간', 50, 'percent'], ['크레딧', 120, 'credits']]);
  assert.equal(mapCodexUsage(body)[0]!.resetsAt, 1795613131000);
  assert.equal(windowLabel(86400), '1일');

  const token = jwt({ exp: NOW / 1000 + 3600, 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-claim' } });
  const auth = (t: Record<string, unknown>) => ({ '/h/.codex/auth.json': JSON.stringify({ tokens: t }) });
  assert.deepEqual(codexCredential(env({ files: auth({ access_token: token }) }).env).extra, { accountId: 'acct-claim' });
  assert.equal(codexCredential(env({ files: auth({ access_token: token, account_id: 'acct-file' }) }).env).extra?.accountId, 'acct-file');
  assert.throws(() => codexCredential(env({ files: auth({ access_token: jwt({ exp: NOW / 1000 - 10 }) }) }).env), /만료/);
  assert.throws(() => codexCredential(env({ files: { '/h/.codex/auth.json': '{"OPENAI_API_KEY":"sk"}' } }).env), /API 키/);
});

test('Cursor: plan share over the billing cycle and on-demand spend; credential from the state database', async () => {
  const body = {
    billingCycleStart: '1795587538465', billingCycleEnd: '1796192338465',
    planUsage: { totalPercentUsed: 1.57, autoPercentUsed: 1.57 },
    spendLimitUsage: { individualLimit: 500, individualRemaining: 380 },
  };
  const metrics = mapCursorUsage(body);
  assert.deepEqual(metrics.map((m) => [m.label, m.used, m.limit, m.unit]), [['플랜', 1.57, 100, 'percent'], ['추가 사용', 1.2, 5, 'usd']]);
  assert.equal(metrics[0]!.periodMs, 1796192338465 - 1795587538465);
  assert.equal(mapCursorUsage({ planUsage: { limit: 2000, remaining: 500 } })[0]!.used, 75, 'percent from spend when not given');

  const db = cursorStatePath({ home: '/h', platform: 'darwin', env: {} });
  const query = `sqlite3 -readonly ${db} SELECT value FROM ItemTable WHERE key = 'cursorAuth/accessToken'`;
  const ok = jwt({ exp: NOW / 1000 + 3600 });
  assert.equal((await cursorCredential(env({ platform: 'darwin', files: { [db]: '' }, commands: { [query]: `${ok}\n` } }).env)).token, ok);
  await assert.rejects(cursorCredential(env({ platform: 'darwin' }).env), /찾지 못했습니다/);
  assert.equal(cursorStatePath({ home: '/h', platform: 'linux', env: {} }), '/h/.config/Cursor/User/globalStorage/state.vscdb');
});

test('fetchUsage: each provider reports its own error; headers carry the credential', async () => {
  const { env: e, requests } = env({
    pi: { anthropic: 'sk-ant-oat-pi' },
    http: {
      'https://api.anthropic.com/api/oauth/usage': [200, CLAUDE_USAGE],
      'https://api.anthropic.com/api/oauth/profile': [500, {}],
    },
  });
  const [c, x] = await fetchUsage(['claude', 'codex'], e);
  assert.equal(c!.error, undefined);
  assert.equal(c!.plan, undefined, 'a failed profile read only drops the plan');
  assert.equal(c!.metrics.length, 4);
  assert.match(x!.error!, /Codex 로그인을 찾지 못했습니다/);
  assert.equal(requests[0]!.headers.Authorization, 'Bearer sk-ant-oat-pi');
  assert.equal(requests[0]!.headers['anthropic-beta'], 'oauth-2025-04-20');

  const denied = env({ pi: { anthropic: 'sk-ant-oat-pi' }, http: { 'https://api.anthropic.com/api/oauth/usage': [401, {}] } });
  assert.match((await fetchUsage(['claude'], denied.env))[0]!.error!, /인증이 거부/);
});

test('toEpochMs reads ISO strings, epoch seconds and epoch milliseconds', () => {
  assert.equal(toEpochMs('2026-11-30T02:00:00Z'), Date.UTC(2026, 10, 30, 2));
  assert.equal(toEpochMs(1795613131), 1795613131000);
  assert.equal(toEpochMs('1796192338465'), 1796192338465);
  assert.equal(toEpochMs(null), undefined);
});

const USAGE_STATUS = {
  monthlyUsage: { usedCents: 43, limitCents: 500, periodStart: '2026-11-01T00:00:00.000Z', resetsAt: '2026-12-01T00:00:00.000Z' },
  weeklyIncludedUsage: { usedCents: 928, budgetCents: 55395, periodStart: '2026-11-25T06:18:58.465Z', resetsAt: '2026-12-02T06:18:58.465Z' },
  weeklyIncludedUsageByProduct: [{ product: 'grok-bot', cents: 693 }, { product: 'cursor', cents: 239 }],
};

test('Cursor usage-status: weekly budget, its share per product (Grok Bot, Cursor), monthly additional usage, with resets', () => {
  const metrics = mapUsageStatus(USAGE_STATUS);
  assert.deepEqual(metrics.map((m) => [m.label, m.used, m.limit]), [
    ['주간 포함', 9.28, 553.95], ['└ Grok Bot', 6.93, 553.95], ['└ Cursor', 2.39, 553.95], ['월 추가 사용', 0.43, 5],
  ]);
  assert.equal(metrics[1]!.resetsAt, Date.parse('2026-12-02T06:18:58.465Z'));
  assert.equal(metrics[1]!.periodMs, 7 * 24 * 3_600_000);
  assert.equal(metrics[3]!.resetsAt, Date.parse('2026-12-01T00:00:00.000Z'));
  assert.deepEqual(mapUsageStatus({ weeklyIncludedUsage: { budgetCents: 0 } }), []);
  assert.equal(productLabel('grok-bot'), 'Grok Bot');
});

test('Cursor Grok Bot: its own allowance unless unified, pooled or zero; plan name', () => {
  const sand = { usagePercent: 12.5, currentPeriodStart: '2026-11-25T06:18:58.465Z', nextResetTimestampUtc: '2026-12-02T06:18:58.465Z', hasNonZeroIncludedLimit: true };
  assert.deepEqual(mapGrokBot(sand), { label: 'Grok Bot', used: 12.5, limit: 100, unit: 'percent', resetsAt: Date.parse('2026-12-02T06:18:58.465Z'), periodMs: 7 * 24 * 3_600_000 });
  assert.equal(mapGrokBot({ ...sand, isUnified: true }), undefined, 'unified: shown per product instead');
  assert.equal(mapGrokBot({ ...sand, hasNonZeroIncludedLimit: false }), undefined);
  assert.equal(cursorPlan({ planInfo: { planName: 'Ultra' }, isMerged: true }), 'Ultra (통합)');
  assert.equal(cursorPlan({ planInfo: { planName: 'Pro' } }), 'Pro');
  assert.equal(sessionCookie(jwt({ sub: 'github|user_1' })), `WorkosCursorSessionToken=user_1%3A%3A${jwt({ sub: 'github|user_1' })}`);
});

test('Cursor fetch: usage-status when it answers, plan share when it does not; Grok Bot added when separate', async () => {
  const token = jwt({ exp: NOW / 1000 + 3600, sub: 'github|user_1' });
  const db = cursorStatePath({ home: '/h', platform: 'darwin', env: {} });
  const commands = { [`sqlite3 -readonly ${db} SELECT value FROM ItemTable WHERE key = 'cursorAuth/accessToken'`]: token };
  const api = 'https://api2.cursor.sh/aiserver.v1.DashboardService';
  const http: Record<string, [number, unknown]> = {
    [`${api}/GetCurrentPeriodUsage`]: [200, { planUsage: { totalPercentUsed: 2 } }],
    'https://cursor.com/api/dashboard/v2/usage-status?scope=user': [200, USAGE_STATUS],
    [`${api}/GetSandUsageStatus`]: [200, { usagePercent: 5, hasNonZeroIncludedLimit: true }],
    [`${api}/GetPlanInfo`]: [200, { planInfo: { planName: 'Pro' } }],
  };
  const full = env({ platform: 'darwin', files: { [db]: '' }, commands, http });
  const snap = await cursor.fetch(full.env);
  assert.equal(snap.plan, 'Pro');
  assert.deepEqual(snap.metrics.map((m) => m.label), ['주간 포함', '└ Grok Bot', '└ Cursor', '월 추가 사용', 'Grok Bot']);
  const cookieRequest = full.requests.find((r) => r.url.startsWith('https://cursor.com'));
  assert.match(cookieRequest!.headers.Cookie!, /^WorkosCursorSessionToken=user_1%3A%3A/);

  delete http['https://cursor.com/api/dashboard/v2/usage-status?scope=user'];
  delete http[`${api}/GetSandUsageStatus`];
  const fallback = await cursor.fetch(env({ platform: 'darwin', files: { [db]: '' }, commands, http }).env);
  assert.deepEqual(fallback.metrics.map((m) => [m.label, m.used]), [['플랜', 2]]);
});
