// RunProgram for a process that owns a real terminal (e.g. a multiplexer pane): the child inherits
// stdin/stdout/stderr. Pi's floating overlay supplies a PTY-backed runner instead; workflows don't care.
import { spawn } from 'node:child_process';
import type { RunProgram } from '#lib/types.ts';

export const ttyRun: RunProgram = (command, args, env) => new Promise(resolve => {
  const child = spawn(command, args, { stdio: 'inherit', env: env ?? process.env });
  child.on('error', () => resolve({ exitCode: -1 }));
  child.on('exit', code => resolve({ exitCode: code ?? -1 }));
});
