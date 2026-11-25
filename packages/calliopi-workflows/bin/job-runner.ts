// Entry point of a /cl-run pane: node job-runner.ts <job dir>.
// Runs the job's command in a pseudo-terminal of its own, so the program sees a terminal (colors,
// prompts, Ctrl+C) while every byte it prints is also appended to the job's log. When the command
// ends, its exit code is written to the job directory; that file is how Pi learns it has finished.
import fs from 'node:fs';
import path from 'node:path';
import pty from 'node-pty';
import { EXIT_FILE, LOG_FILE, META_FILE, PID_FILE, writeExit, type JobMeta } from '#lib/jobs.ts';

const dir = process.argv[2];
if (!dir) { process.stderr.write('usage: job-runner.ts <job dir>\n'); process.exit(2); }
const meta = JSON.parse(fs.readFileSync(path.join(dir, META_FILE), 'utf8')) as JobMeta;
process.title = `cl-run ${meta.name}`;
fs.writeFileSync(path.join(dir, PID_FILE), String(process.pid), { mode: 0o600 });
const log = fs.openSync(path.join(dir, LOG_FILE), 'a', 0o600);

const out = process.stdout, input = process.stdin;
out.write(`\x1b[2m$ ${meta.command}\x1b[0m\r\n`);
const child = pty.spawn(process.env.SHELL || '/bin/sh', ['-c', meta.command], {
  name: process.env.TERM || 'xterm-256color', cwd: meta.cwd, env: process.env as Record<string, string>,
  cols: out.columns || 80, rows: out.rows || 24,
});
if (input.isTTY) input.setRawMode(true);
input.resume();
const forward = (data: Buffer) => child.write(data.toString('utf8'));
input.on('data', forward);
out.on('resize', () => { try { child.resize(out.columns || 80, out.rows || 24); } catch { /* already gone */ } });
child.onData(data => { fs.writeSync(log, data); out.write(data); });

// /cl-jobs "중지" sends SIGTERM here; a closed pane sends SIGHUP. Either way the command goes too.
let asked = false;
for (const signal of ['SIGTERM', 'SIGHUP', 'SIGINT'] as const) {
  process.on(signal, () => {
    if (asked) { try { child.kill('SIGKILL'); } catch { /* gone */ } return; }
    asked = true;
    try { child.kill(signal === 'SIGINT' ? 'SIGINT' : 'SIGHUP'); } catch { /* gone */ }
  });
}

child.onExit(({ exitCode, signal }) => {
  const code = signal ? 128 + signal : exitCode;
  fs.closeSync(log);
  if (!fs.existsSync(path.join(dir, EXIT_FILE))) writeExit(dir, code);
  input.off('data', forward);
  if (input.isTTY) input.setRawMode(false);
  if (meta.silent || asked || !input.isTTY) process.exit(0); // a background window closes by itself
  out.write(`\r\n\x1b[2m[${meta.name} 종료 ${code}] Enter로 닫기\x1b[0m`);
  input.on('data', (data: Buffer) => { if (/[\r\n\x03\x04q]/.test(data.toString('latin1'))) process.exit(0); });
});
