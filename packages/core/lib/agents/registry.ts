// The registry: <root>/<top session id>/<agent id>/ per agent, private to this user (0700).
//   meta.json      the call, written by the parent before the child starts
//   status.json    the child's progress, rewritten as it works
//   result.json    how it ended, written once
//   inbox/NNNNNN.json  messages from the parent (briefing, steer, stop), delivered in seq order
//   delivered.json the last inbox seq the child has taken in
//   requests.jsonl every model request the child sent (lib/agents/requests.ts)
//   session.jsonl  the child's Pi session
// Files are replaced atomically, so a reader never sees half a file.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROLE_NAME } from '#lib/agents/catalog.ts';
import type { AgentMeta, AgentRecord, AgentResult, AgentStatus, InboxMessage } from '#lib/agents/types.ts';

export const FILES = { meta: 'meta.json', status: 'status.json', result: 'result.json', inbox: 'inbox', delivered: 'delivered.json', requests: 'requests.jsonl', session: 'session.jsonl' } as const;

/** A directory only this user may use; refuses one that someone else could have prepared. */
export function privateDir(dir: string): string {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(dir);
  const uid = os.userInfo().uid;
  if (!stat.isDirectory() || stat.uid !== uid || (stat.mode & 0o077) !== 0) {
    throw new Error(`${dir}이(가) 내 전용 디렉터리가 아닙니다(다른 사용자 소유, 링크, 또는 열린 권한).`);
  }
  return dir;
}

export function writeJson(file: string, value: unknown): void {
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function readJson<T>(file: string): T | undefined {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) as T; } catch { return undefined; }
}

/**
 * The directory of one tree: every agent below one top Pi session. A plain id (letters, digits, -, _)
 * is used as is; anything else (dots, slashes, empty) becomes a hash, so no id can leave the root
 * or share a directory with another.
 */
export const treeDir = (root: string, topSession: string) =>
  path.join(root, /^[\w-]+$/.test(topSession) ? topSession : `h-${createHash('sha256').update(topSession).digest('hex').slice(0, 24)}`);

/** A new agent directory named after its role ("reviewer-1", "reviewer-2", …), with its meta written. */
export function createAgent(root: string, meta: Omit<AgentMeta, 'id' | 'session'>): AgentRecord {
  if (!ROLE_NAME.test(meta.role)) throw new Error(`역할 이름이 올바르지 않습니다: ${meta.role}`); // it names a directory
  const base = privateDir(treeDir(privateDir(root), meta.root));
  for (let n = 1; ; n++) {
    const id = `${meta.role}-${n}`;
    const dir = path.join(base, id);
    try { fs.mkdirSync(dir, { mode: 0o700 }); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw error;
    }
    fs.mkdirSync(path.join(dir, FILES.inbox), { mode: 0o700 });
    const full: AgentMeta = { ...meta, id, session: path.join(dir, FILES.session) };
    writeJson(path.join(dir, FILES.meta), full);
    return { dir, meta: full };
  }
}

export const setPane = (dir: string, pane: AgentMeta['pane']) => {
  const meta = readJson<AgentMeta>(path.join(dir, FILES.meta));
  if (meta) writeJson(path.join(dir, FILES.meta), { ...meta, pane });
};
export const writeStatus = (dir: string, status: AgentStatus) => writeJson(path.join(dir, FILES.status), status);
/** The first result stands: a later writer (a stop racing a finish) does not replace it. */
export function writeResult(dir: string, result: AgentResult): boolean {
  const file = path.join(dir, FILES.result);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(result), { mode: 0o600 });
  try { fs.linkSync(tmp, file); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false; throw error; }
  finally { fs.rmSync(tmp, { force: true }); }
}

export function readAgent(dir: string): AgentRecord | undefined {
  const meta = readJson<AgentMeta>(path.join(dir, FILES.meta));
  if (!meta) return undefined;
  return { dir, meta, status: readJson<AgentStatus>(path.join(dir, FILES.status)), result: readJson<AgentResult>(path.join(dir, FILES.result)) };
}

/** Every agent of one tree, oldest first. */
export function listAgents(root: string, topSession: string): AgentRecord[] {
  const base = treeDir(root, topSession);
  let names: string[];
  try { names = fs.readdirSync(base); } catch { return []; }
  return names.flatMap(n => readAgent(path.join(base, n)) ?? []).sort((a, b) => a.meta.createdAt - b.meta.createdAt);
}

/** Append a message to a child's inbox; its seq is the next free one, so concurrent writers never collide. */
export function postInbox(dir: string, message: Omit<InboxMessage, 'seq'>): InboxMessage {
  const inbox = path.join(dir, FILES.inbox);
  for (let seq = fs.readdirSync(inbox).filter(n => n.endsWith('.json')).length + 1; ; seq++) {
    const full: InboxMessage = { ...message, seq };
    const file = path.join(inbox, `${String(seq).padStart(6, '0')}.json`);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(full), { mode: 0o600 });
    try { fs.linkSync(tmp, file); return full; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    finally { fs.rmSync(tmp, { force: true }); }
  }
}

/** Inbox messages after `afterSeq`, in seq order. */
export function readInbox(dir: string, afterSeq = 0): InboxMessage[] {
  let names: string[];
  try { names = fs.readdirSync(path.join(dir, FILES.inbox)); } catch { return []; }
  return names.filter(n => /^\d{6,}\.json$/.test(n)).map(n => readJson<InboxMessage>(path.join(dir, FILES.inbox, n)))
    .filter((m): m is InboxMessage => !!m && m.seq > afterSeq).sort((a, b) => a.seq - b.seq);
}

/**
 * What the child has taken in: the last seq, and the ids, so a message is delivered once even after a
 * restart. The child is the only writer, so a plain read-modify-write is enough.
 */
export interface Delivered { seq: number; ids: string[] }
export const readDelivered = (dir: string): Delivered => readJson<Delivered>(path.join(dir, FILES.delivered)) ?? { seq: 0, ids: [] };
export const markDelivered = (dir: string, message: InboxMessage) => {
  const d = readDelivered(dir);
  writeJson(path.join(dir, FILES.delivered), { seq: Math.max(d.seq, message.seq), ids: [...d.ids, message.id] });
};
