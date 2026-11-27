import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appendNote, formatNotes, noteLine, noteText, notesFile, readNotes, type Note } from '#lib/notes.ts';

const tmp = (t: { after: (fn: () => void) => void }) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'calliopi-notes-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const note = (over: Partial<Note> = {}): Note => ({ at: Date.UTC(2026, 10, 27, 9, 30), text: 'looped on the same grep', session: 's-1', cwd: '/work/app', model: 'p/m', ...over });

test('noteText: a note is one line', () => {
  assert.equal(noteText('  ran the\n full suite\ttwice  '), 'ran the full suite twice');
  assert.equal(noteText(' \n '), '');
});

test('appendNote and readNotes: appended as private lines, read back oldest first', t => {
  const file = notesFile(path.join(tmp(t), 'agent')); // the directory does not exist yet
  assert.equal(path.basename(file), 'calliopi-notes.jsonl');
  assert.deepEqual(readNotes(file), []); // no file: no notes
  assert.equal(appendNote(file, note({ text: '   ' })), undefined);
  assert.equal(fs.existsSync(file), false); // an empty note writes nothing

  const second = appendNote(file, note({ at: 2000, text: 'second\nline' }));
  appendNote(file, note({ at: 1000, text: 'first', session: 's-0', sessionFile: '/s/0.jsonl', model: undefined }));
  assert.equal(second!.text, 'second line');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(file, 'utf8').trimEnd().split('\n').length, 2);
  fs.chmodSync(file, 0o644); // a file left readable by others is made private again on the next note
  appendNote(file, note({ at: 3000, text: 'third' }));
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(readNotes(file).length, 3);
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').split('\n').slice(0, 2).join('\n') + '\n');
  assert.deepEqual(readNotes(file).map(n => [n.at, n.text, n.session, n.sessionFile, n.model]), [
    [1000, 'first', 's-0', '/s/0.jsonl', undefined], [2000, 'second line', 's-1', undefined, 'p/m'],
  ]);
});

test('readNotes: a torn or foreign line, or a time that is not a date, is skipped; the rest is kept', t => {
  const file = path.join(tmp(t), 'notes.jsonl');
  fs.writeFileSync(file, [JSON.stringify(note({ at: 1 })), '{"at":2,"text":"no session"}', 'not json', JSON.stringify(note({ at: 3 })), JSON.stringify(note({ at: 1e20 })), '{"at":4,"te'].join('\n'));
  assert.deepEqual(readNotes(file).map(n => n.at), [1, 3]);
  assert.match(formatNotes(readNotes(file)), /^## Notes\n\n2 notes from 1 session, newest first\./); // a time that is not a date would throw here
});

test('noteLine and formatNotes: newest first, counted by session, capped', () => {
  assert.equal(noteLine(note()), '2026-11-27 09:30Z · app · p/m · looped on the same grep');
  assert.equal(noteLine(note({ model: undefined, cwd: '/' })), '2026-11-27 09:30Z · / · unknown model · looped on the same grep');
  assert.match(formatNotes([]), /^## Notes\n\nNo notes\./);

  const notes = [note({ at: 1000, text: 'a' }), note({ at: 2000, text: 'b', session: 's-2' }), note({ at: 3000, text: 'c' })];
  const lines = formatNotes(notes).split('\n');
  assert.equal(lines[2], '3 notes from 2 sessions, newest first.');
  assert.deepEqual(lines.slice(4).map(l => l.split(' · ').at(-1)), ['c (session s-1)', 'b (session s-2)', 'a (session s-1)']);
  const capped = formatNotes(notes, 2).split('\n');
  assert.deepEqual(capped.slice(4).map(l => l.split(' · ').at(-1)), ['c (session s-1)', 'b (session s-2)', '- … and 1 older']);
});
