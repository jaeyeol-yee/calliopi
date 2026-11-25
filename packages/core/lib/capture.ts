// Run a program to completion and capture its output. The non-interactive counterpart of RunProgram:
// callers take a Capture so tests can swap in a fake, the same way workflows take a RunProgram.
import { execFile } from 'node:child_process';

export interface CaptureResult {
  /** Exit code; -1 when the program could not start or was killed (e.g. timeout). */
  code: number;
  stdout: string;
  stderr: string;
}

export type Capture = (command: string, args: string[], options?: { cwd?: string }) => Promise<CaptureResult>;

/** Capture with a timeout, so a hung `gh` or a credential prompt never blocks the caller. */
export function capture(timeoutMs = 15_000): Capture {
  return (command, args, options) => new Promise((resolve) => {
    execFile(command, args, { cwd: options?.cwd, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8',
      // Never prompt: no terminal to answer on.
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1' } }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === 'number' ? error.code : -1) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}
