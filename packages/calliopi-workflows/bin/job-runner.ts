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

// Create stderr now, while the terminal is up. Node opens it on first use, and after the pane closes
// (hangup) opening that terminal blocks for ever: the event loop stops before the exit code is written.
void process.stderr;
const out = process.stdout, input = process.stdin;
out.write(`\x1b[2m$ ${meta.command}\x1b[0m\r\n`);
const child = pty.spawn(process.env.SHELL || '/bin/sh', ['-c', meta.command], {
  name: process.env.TERM || 'xterm-256color', cwd: meta.cwd, env: process.env as Record<string, string>,
  cols: out.columns || 80, rows: out.rows || 24,
});
if (input.isTTY) input.setRawMode(true);
input.resume();
input.setEncoding('utf8'); // decoded by the stream: a character split across two reads stays whole
const forward = (data: string) => child.write(data);
input.on('data', forward);
out.on('resize', () => { try { child.resize(out.columns || 80, out.rows || 24); } catch { /* already gone */ } });
child.onData(data => { fs.writeSync(log, data); out.write(data); });

// SIGINT (alt+k in Pi) is Ctrl+C: written to the command's terminal, whose line discipline signals the
// foreground process group. Signalling only the shell would miss the program it is waiting for, and
// a program that turned Ctrl+C off (an editor) keeps running, as it would for a typed Ctrl+C.
let ended = false; // once the command is over, a signal only closes the pane (Pi's stop key pressed again)
process.on('SIGINT', () => { if (ended) process.exit(0); try { child.write('\x03'); } catch { /* gone */ } });
// /cl-jobs "중지" and a second alt+k send SIGTERM here; a closed pane sends SIGHUP. Either way the command goes too.
let asked = false;
for (const signal of ['SIGTERM', 'SIGHUP'] as const) {
  process.on(signal, () => {
    if (ended) process.exit(0);
    // Asked twice: the whole process group, so a descendant that ignores SIGHUP goes as well.
    if (asked) { try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* gone */ } } return; }
    asked = true;
    try { child.kill('SIGHUP'); } catch { /* gone */ }
  });
}

child.onExit(({ exitCode, signal }) => {
  const code = signal ? 128 + signal : exitCode;
  ended = true;
  fs.closeSync(log);
  if (!fs.existsSync(path.join(dir, EXIT_FILE))) writeExit(dir, code);
  input.off('data', forward);
  if (input.isTTY) input.setRawMode(false);
  if (meta.silent || asked || !input.isTTY) process.exit(0); // a background window closes by itself
  out.write(`\r\n\x1b[2m[${meta.name} 종료 ${code}] Enter로 닫기\x1b[0m`);
  input.on('data', (data: string) => { if (/[\r\n\x03\x04q]/.test(data)) process.exit(0); });
});
