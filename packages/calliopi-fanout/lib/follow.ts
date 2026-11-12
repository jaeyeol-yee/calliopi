// `follow <agent>`: a per-agent view that reads ONLY the local registry (zero API calls).
// It exits when the current run is terminal *and* finalized (result/git/usage collected),
// with an exit code that encodes the raw status — so any multiplexer's "child exited"
// event carries the outcome. WAITING_FOR_BACKGROUND_WORK keeps it running.
import fs from 'node:fs';
import { load, findAgent } from '#lib/registry.ts';
import { EXIT, caught, fmtDur, isTerminal, processAlive, short, cleanResult, keyVerifiedRuns, understood } from '#lib/util.ts';
import { icon } from '#lib/dashboard.ts';
import type { AgentView, FanoutConfig } from '#lib/types.ts';

export function exitCodeFor(a: AgentView | null | undefined): number {
  if (!a || a.missing) return EXIT.MISSING;
  return EXIT[a.status as string] ?? EXIT.ERROR;
}

export function summaryBlock(a: AgentView): string {
  const run = a.runs?.[a.runId as string] || {};
  const out = [];
  out.push(`${icon(a.status)} ${a.status}  ${a.label || ''}  ${a.agentId}`);
  out.push(`run ${a.runId}  duration ${fmtDur(run.durationMs)}`);
  if (a.url) out.push(`web ${a.url}`);
  for (const b of a.git?.branches || []) out.push(`git ${b.repoUrl} ${b.branch || ''}${b.prUrl ? `  PR ${b.prUrl}` : ''}`);
  if (run.gitDelta?.length === 0 && a.git?.branches?.length) out.push('git (no new branch/PR attributable to this run; snapshot is per-agent)');
  if (run.usage) {
    const u = run.usage;
    out.push(`tokens total ${u.totalTokens} (in ${u.inputTokens}, out ${u.outputTokens}, cache r/w ${u.cacheReadTokens}/${u.cacheWriteTokens})`);
  } else if (run.usageNote) out.push(`tokens n/a (${run.usageNote})`);
  if (a.summary) out.push(`planned     ${a.summary}`);
  if (understood(run.result)) out.push(`understood  ${understood(run.result)}`);
  if (a.fanoutKey) out.push(`fanout key ${keyVerifiedRuns(a) ? 'verified ✓' : 'NOT found in reply ⚠'}`);
  if (a.ack) out.push(`prompt ack ${a.ack.status === 'ok' ? 'verified ✓' : `${a.ack.status} ⚠${a.ack.message ? ` (${a.ack.message})` : ''}`}`);
  out.push('', '── summary ──', cleanResult(run.result) || '(no result text)');
  return out.join('\n');
}

export async function follow(cfg: FanoutConfig, needle: string, { appearTimeoutMs = 120_000, pollMs = 1500 } = {}): Promise<number> {
  const started = Date.now();
  let lastLine = '';
  let warnedDaemon = 0;
  for (;;) {
    let reg;
    try { reg = load(cfg); } catch (e: unknown) { process.stdout.write(`registry unreadable: ${caught(e).message}\n`); reg = null; }
    const a = reg && findAgent(reg, needle);
    if (!a) {
      if (Date.now() - started > appearTimeoutMs) {
        process.stdout.write(`agent ${needle} not in registry\n`);
        return EXIT.MISSING;
      }
    } else {
      if (a.missing) { process.stdout.write(`${short(a.agentId)} MISSING (404)\n`); return EXIT.MISSING; }
      if (a.phase === 'create_failed') { process.stdout.write(`create failed: ${a.createError?.message}\n`); return EXIT.ERROR; }
      const run = a.runs?.[a.runId as string] || {};
      const age = run.createdAt ? fmtDur(Date.now() - Date.parse(run.createdAt)) : '-';
      const line = `${icon(a.status)} ${a.status || a.phase}  ${a.label || ''}  ${short(a.agentId)}/${short(a.runId)}`;
      if (line !== lastLine) {
        process.stdout.write(`${new Date().toISOString().slice(11, 19)} ${line}${a.lastError ? `  ! ${a.lastError.message}` : ''}\n`);
        lastLine = line;
      }
      process.title = `${a.status || a.phase} ${age}`;
      if (isTerminal(a.status) && a.finalized) {
        process.stdout.write(`\n${summaryBlock(a)}\n`);
        return exitCodeFor(a);
      }
    }
    const pid = Number(safeRead(cfg.pidPath));
    if (!processAlive(pid) && Date.now() - warnedDaemon > 60_000) {
      process.stdout.write('  (tracker daemon not running — no live updates; start `tracker watch`)\n');
      warnedDaemon = Date.now();
    }
    await waitForChange(cfg.registryPath, pollMs);
  }
}

function safeRead(f: string): string { try { return fs.readFileSync(f, 'utf8').trim(); } catch { return ''; } }

function waitForChange(file: string, ms: number): Promise<void> {
  // fs.watch on the directory catches atomic renames; fall back to a timer either way.
  return new Promise((resolve) => {
    let w: fs.FSWatcher | undefined;
    const t = setTimeout(done, ms);
    function done() { clearTimeout(t); try { w?.close(); } catch { /* */ } resolve(); }
    try { w = fs.watch(file.replace(/[^/]+$/, ''), (_, name) => { if (name && name.startsWith('registry.json')) done(); }); } catch { /* */ }
  });
}
