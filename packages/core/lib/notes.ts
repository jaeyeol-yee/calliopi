// Session notes: one line a person writes when a session went wrong (the agent went in circles, had
// to be corrected). They are the cheapest signal of what to improve, kept apart from anything a model
// reads: one JSON object per line in <Pi agent dir>/calliopi-notes.jsonl, private to this user (0600).
// Read back by /cl-note and `npm run signals`.
import fs from 'node:fs';
import path from 'node:path';

export interface Note {
  /** When it was written (ms). */
  at: number;
  text: string;
  /** The Pi session it was written in, and that session's file when it has one. */
  session: string;
  sessionFile?: string;
  cwd: string;
  /** provider/model active when it was written. */
  model?: string;
}

export const NOTES_FILE = 'calliopi-notes.jsonl';
export const notesFile = (agentDir: string) => path.join(agentDir, NOTES_FILE);

/** A note is one line: runs of whitespace (newlines included) become a single space. */
export const noteText = (raw: string) => raw.replace(/\s+/g, ' ').trim();

/** Append one note; returns it, or undefined when the text is empty. Appends are whole lines, so two Pis may write at once. */
export function appendNote(file: string, note: Note): Note | undefined {
  const text = noteText(note.text);
  if (!text) return undefined;
  const full: Note = { ...note, text };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(full)}\n`, { mode: 0o600 });
  return full;
}

/** Every note in the file, oldest first; a missing file is no notes and a broken line is skipped. */
export function readNotes(file: string): Note[] {
  let raw: string;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return []; }
  return raw.split('\n').filter(Boolean).flatMap(line => {
    try {
      const n = JSON.parse(line) as Partial<Note>;
      return typeof n.at === 'number' && typeof n.text === 'string' && typeof n.session === 'string' && typeof n.cwd === 'string' ? [n as Note] : [];
    } catch { return []; }
  }).sort((a, b) => a.at - b.at);
}

const stamp = (at: number) => `${new Date(at).toISOString().slice(0, 16).replace('T', ' ')}Z`;

/** One note as a line: when (UTC), the project directory's name, the model, the text. */
export const noteLine = (n: Note) => `${stamp(n.at)} · ${path.basename(n.cwd) || n.cwd} · ${n.model ?? 'unknown model'} · ${n.text}`;

/** The notes section of the signals report: newest first, at most `limit` lines. */
export function formatNotes(notes: Note[], limit = 50): string {
  const lines = ['## Notes', ''];
  if (!notes.length) return [...lines, 'No notes. Write one with /cl-note <text> when a session goes wrong.'].join('\n');
  const sessions = new Set(notes.map(n => n.session)).size;
  lines.push(`${notes.length} notes from ${sessions} sessions, newest first.`, '');
  const newest = [...notes].reverse();
  for (const n of newest.slice(0, limit)) lines.push(`- ${noteLine(n)} (session ${n.session})`);
  if (newest.length > limit) lines.push(`- … and ${newest.length - limit} older`);
  return lines.join('\n');
}
