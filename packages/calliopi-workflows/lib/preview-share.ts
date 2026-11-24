// Pane → Pi: the pane drops JSON files into a private outbox; the extension drains it and queues a
// message for the next turn. Writes are tmp+rename so the reader never sees a partial file.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { MAX_DIFF_BYTES, MAX_DIFF_LINES } from '#lib/file-edit.ts';

export interface PreviewShare {
  file: string;
  mode: 'view' | 'base' | 'tip';
  ref?: string;
  base?: string;
  /** Diff for base/tip; for view, the lines visible in the pane (with line numbers). */
  text: string;
}

export const CLOSED_MARKER = 'closed';

let sequence = 0;

export function writeShare(outbox: string, share: PreviewShare): void {
  // Sortable: time, then a per-process counter for writes in the same millisecond.
  const name = `${Date.now()}-${String(sequence++).padStart(6, '0')}-${randomUUID()}`;
  const tmp = path.join(outbox, `.${name}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(share), { mode: 0o600 });
  fs.renameSync(tmp, path.join(outbox, `${name}.json`));
}

/** Oldest first; each file is removed once read. Unreadable files are dropped. */
export function drainShares(outbox: string): PreviewShare[] {
  let names: string[];
  try { names = fs.readdirSync(outbox).filter(n => n.endsWith('.json')).sort(); } catch { return []; }
  return names.flatMap(name => {
    const file = path.join(outbox, name);
    try { return [JSON.parse(fs.readFileSync(file, 'utf8')) as PreviewShare]; }
    catch { return []; }
    finally { fs.rmSync(file, { force: true }); }
  });
}

export function shareMessage(s: PreviewShare): string {
  const what = s.mode === 'view' ? 'the visible part of the file'
    : s.mode === 'base' ? `its changes since diverging from ${s.ref} (merge-base ${s.base?.slice(0, 12)}), working tree included`
    : `its diff against ${s.ref} as that branch is now, working tree included`;
  const intro = `The user shared ${what} from the /cl-preview side pane: ${s.file}. This is context, not a request by itself.`;
  const tag = s.mode === 'view' ? 'preview-lines' : 'preview-diff';
  const tooBig = Buffer.byteLength(s.text) > MAX_DIFF_BYTES || s.text.split('\n').length > MAX_DIFF_LINES;
  if (tooBig) return `${intro}\nContent omitted (over 24 KiB or 400 lines). Read the file or run git diff if needed.`;
  return `${intro}\n\n<${tag}>\n${s.text.replace(/\n?$/, '\n')}</${tag}>`;
}

// Pi → pane: "show this file". One request file, replaced atomically; the pane watches its directory.
export const REQUEST_FILE = 'request.json';
export const PANE_PID_FILE = 'pane.pid';

export function writeRequest(dir: string, file: string): void {
  const tmp = path.join(dir, `.request-${randomUUID()}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify({ file, at: Date.now() }), { mode: 0o600 });
  fs.renameSync(tmp, path.join(dir, REQUEST_FILE));
}

/** Takes the pending request (removing it), or null. */
export function takeRequest(dir: string): string | null {
  const file = path.join(dir, REQUEST_FILE);
  try { return (JSON.parse(fs.readFileSync(file, 'utf8')) as { file: string }).file; }
  catch { return null; }
  finally { fs.rmSync(file, { force: true }); }
}

/** A pane is open while its process is alive and it has not marked itself closed. */
export function paneAlive(dir: string): boolean {
  if (fs.existsSync(path.join(dir, CLOSED_MARKER))) return false;
  try { process.kill(Number(fs.readFileSync(path.join(dir, PANE_PID_FILE), 'utf8')), 0); return true; }
  catch { return false; }
}
