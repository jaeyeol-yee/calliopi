// The harness version a session runs under, written into the session as a custom entry so that
// `npm run signals` can compare sessions before and after a change to Calliopi. The entry is not part
// of what a model reads (Pi keeps custom entries out of the context), and nothing is sent anywhere.
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { HARNESS_ENTRY, harnessLabel, type HarnessVersion } from '@calliopi/core/smells';

const HERE = fileURLToPath(new URL('.', import.meta.url));

const git = (cwd: string, args: string[]) => new Promise<string | undefined>(resolve => {
  // No prompt, no lock taken, and a bound on the wait: a session never hangs on this.
  execFile('git', args, { cwd, timeout: 3000, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' } }, (error, stdout) => resolve(error ? undefined : stdout));
});

/** The commit of the Calliopi checkout this code runs from, and whether it has uncommitted changes; undefined when it is not a git checkout. */
export async function readHarnessVersion(dir = HERE): Promise<HarnessVersion | undefined> {
  const sha = (await git(dir, ['rev-parse', '--short=12', 'HEAD']))?.trim();
  if (!sha) return undefined;
  const top = (await git(dir, ['rev-parse', '--show-toplevel']))?.trim();
  const status = await git(top || dir, ['status', '--porcelain', '--untracked-files=no']);
  return { sha, dirty: !!status?.trim() };
}

interface Entry { type?: string; customType?: string; data?: unknown }

/**
 * Before each run, records the version in the session when the last one recorded there differs (or none
 * is): once for a new session, and again when the checkout changed and Pi reloaded it. The version is
 * read once per load of this extension, which is when the code that runs was read.
 */
export function installHarnessStamp(pi: ExtensionAPI, read: () => Promise<HarnessVersion | undefined> = readHarnessVersion): void {
  let version: Promise<HarnessVersion | undefined> | undefined;
  pi.on('agent_start', async (_event, ctx) => {
    try {
      const v = await (version ??= read());
      if (!v) return;
      const last = (ctx.sessionManager.getEntries() as Entry[]).findLast(e => e?.type === 'custom' && e.customType === HARNESS_ENTRY)?.data as Partial<HarnessVersion> | undefined;
      if (last && typeof last.sha === 'string' && harnessLabel({ sha: last.sha, dirty: last.dirty === true }) === harnessLabel(v)) return;
      pi.appendEntry(HARNESS_ENTRY, v);
    } catch { /* a version that cannot be read or written is not worth a failed run */ }
  });
}
