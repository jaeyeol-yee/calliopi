#!/usr/bin/env node
// Independent of Cursor run completion. GitHub requests are gated by a shared cache/budget.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadConfig } from '../lib/config.mjs';
import { load } from '../lib/registry.mjs';
import { createReviewService, syncReviews, prTarget } from '../lib/github-review.mjs';
const run = promisify(execFile);
const cfg = loadConfig({ dir: process.argv[2] });
fs.mkdirSync(cfg.dir, { recursive: true, mode: 0o700 });
const pidFile = path.join(cfg.dir, 'review.pid');
let claimed = false;
for (let attempt = 0; attempt < 2 && !claimed; attempt++) {
  try {
    const fd = fs.openSync(pidFile, 'wx', 0o600);
    fs.writeFileSync(fd, String(process.pid)); fs.closeSync(fd); claimed = true;
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    let pid; try { pid = Number(fs.readFileSync(pidFile, 'utf8')); } catch { continue; }
    if (!pid) process.exit(0); // Another process is still writing its claim.
    try { process.kill(pid, 0); process.exit(0); } catch { fs.rmSync(pidFile, { force: true }); }
  }
}
if (!claimed) process.exit(0);
let stopped = false;
process.once('SIGTERM', () => { stopped = true; });
process.once('SIGINT', () => { stopped = true; });
const service = createReviewService({ exec: async (command, args, options) => {
  try { const r = await run(command, args, { timeout: options?.timeout, maxBuffer: 1_000_000, encoding: 'utf8' }); return { code: 0, stdout: r.stdout, stderr: r.stderr }; }
  catch (e) { return { code: e.code || 1, stdout: e.stdout || '', stderr: e.stderr || '' }; }
} });
try {
  while (!stopped) {
    const reg = load(cfg);
    if (reg.meta.reviewPaused) break;
    const pending = Object.values(reg.agents).some(a => a.status === 'FINISHED' && (a.git?.branches || []).some(b => prTarget(b.prUrl) && a.reviews?.[b.prUrl]?.state !== 'merged'));
    if (!pending) break;
    await syncReviews(cfg, service);
    await new Promise(resolve => setTimeout(resolve, 5000));
  }
} finally {
  if (claimed && fs.readFileSync(pidFile, 'utf8') === String(process.pid)) fs.rmSync(pidFile, { force: true });
}
