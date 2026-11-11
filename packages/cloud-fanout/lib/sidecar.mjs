// Local session mailbox. No terminal keystrokes, network calls, or automatic approvals.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export function owner(dir) {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(dir, 'owner.json'), 'utf8'));
    process.kill(value.pid, 0);
    return value;
  } catch { return null; }
}
export function attach(dir, session) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const lock = path.join(dir, 'owner.lock');
  fs.mkdirSync(lock); // Short synchronous critical section; never steal a live registration.
  try {
    if (owner(dir)) throw new Error('A fan-out session is already attached. Detach it first.');
    try { fs.unlinkSync(path.join(dir, 'owner.json')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    const value = { ...session, pid: process.pid, token: session.token || randomUUID() };
    fs.writeFileSync(path.join(dir, 'owner.json'), JSON.stringify(value), { flag: 'wx', mode: 0o600 });
    return value;
  } finally { fs.rmdirSync(lock); }
}
export function detach(dir, token) {
  if (owner(dir)?.token === token) fs.unlinkSync(path.join(dir, 'owner.json'));
}
export function enqueue(dir, payload) {
  const target = owner(dir);
  if (!target) throw new Error('No live fan-out session. Run /fanout attach in the side session.');
  const id = randomUUID();
  const queue = path.join(dir, 'mailbox');
  fs.mkdirSync(queue, { recursive: true, mode: 0o700 });
  const tmp = path.join(queue, `${id}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify({ id, target: target.token, payload }), { mode: 0o600 });
  fs.renameSync(tmp, path.join(queue, `${id}.json`));
  return id;
}
export function drain(dir, token, receive) {
  const queue = path.join(dir, 'mailbox');
  if (!fs.existsSync(queue)) return;
  for (const file of fs.readdirSync(queue).filter(f => f.endsWith('.json')).sort()) {
    const full = path.join(queue, file);
    const request = JSON.parse(fs.readFileSync(full, 'utf8'));
    if (request.target !== token) continue;
    receive(request.payload);
    fs.renameSync(full, full + '.delivered');
  }
}
