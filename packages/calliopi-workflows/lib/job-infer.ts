// /cl-run ? <words>: a model writes the command line from what the user wants and what the project
// offers. A command the user did not type themselves never runs unconfirmed: it is shown in an
// editor first, and what the user submits there (edited or not) is what runs.
import fs from 'node:fs';
import path from 'node:path';

export interface InferContext {
  cwd: string;
  /** package.json scripts, "name: command". */
  scripts: string[];
  /** npm, pnpm, yarn or bun, from the lockfile; undefined without one. */
  packageManager?: string;
  makeTargets: string[];
  /** Entries of the working directory (directories end with /). */
  files: string[];
  /** Commands run earlier with /cl-run in this directory, newest first. */
  recent: string[];
}

const LOCKFILES: [string, string][] = [['pnpm-lock.yaml', 'pnpm'], ['yarn.lock', 'yarn'], ['bun.lock', 'bun'], ['bun.lockb', 'bun'], ['package-lock.json', 'npm']];
const MAX_FILES = 80, MAX_SCRIPTS = 60, MAX_TARGETS = 40, MAX_RECENT = 10, MAX_LINE = 200;
const clip = (s: string) => s.length > MAX_LINE ? `${s.slice(0, MAX_LINE)}…` : s;

/** What a person would glance at before typing the command. Unreadable parts are left out. */
export function inferContext(cwd: string, recent: readonly string[] = []): InferContext {
  let entries: fs.Dirent[] = [];
  try { entries = fs.readdirSync(cwd, { withFileTypes: true }); } catch { /* no listing */ }
  const names = new Set(entries.map(e => e.name));
  let scripts: string[] = [];
  try {
    const all = (JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8')) as { scripts?: Record<string, unknown> }).scripts ?? {};
    scripts = Object.entries(all).filter(([, v]) => typeof v === 'string').slice(0, MAX_SCRIPTS).map(([k, v]) => clip(`${k}: ${v as string}`));
  } catch { /* no package.json */ }
  let makeTargets: string[] = [];
  try {
    const targets = fs.readFileSync(path.join(cwd, 'Makefile'), 'utf8').split('\n').flatMap(line => /^([A-Za-z0-9][\w.-]*)\s*:(?!=)/.exec(line)?.[1] ?? []);
    makeTargets = [...new Set(targets)].slice(0, MAX_TARGETS);
  } catch { /* no Makefile */ }
  return {
    cwd, scripts, makeTargets,
    packageManager: LOCKFILES.find(([file]) => names.has(file))?.[1],
    files: entries.filter(e => e.name !== '.git' && e.name !== 'node_modules').map(e => e.isDirectory() ? `${e.name}/` : e.name).sort().slice(0, MAX_FILES),
    recent: [...new Set(recent)].slice(0, MAX_RECENT).map(clip),
  };
}

export const CANNOT = '# cannot:';

export const INFER_SYSTEM = [
  'You turn what a developer wants into one shell command line for their project. It will be shown to them for confirmation and then run with `$SHELL -c` in the working directory, in a terminal pane they can watch and type into.',
  'Reply with the command line only: no explanation, no code fence, no prompt character. Chain with && or ; when several steps are needed.',
  'Prefer what the project itself defines (package scripts with the project\'s package manager, Makefile targets) and the form of earlier commands over a guess. Use only files and names you were shown or the developer mentioned.',
  `If you cannot tell which command is meant, reply with one line starting with "${CANNOT}" and what is missing.`,
].join('\n');

export function inferPrompt(intent: string, c: InferContext): string {
  const section = (tag: string, lines: readonly string[]) => lines.length ? `<${tag}>\n${lines.join('\n')}\n</${tag}>` : '';
  return [
    `Working directory: ${c.cwd}`,
    c.packageManager ? `Package manager (from the lockfile): ${c.packageManager}` : '',
    section('package-scripts', c.scripts), section('make-targets', c.makeTargets), section('files', c.files), section('earlier-commands', c.recent),
    `<wanted>\n${intent}\n</wanted>`,
  ].filter(Boolean).join('\n\n');
}

/** The command in a model reply; a fence or `$ ` around it is tolerated. */
export function parseInferred(reply: string): { command: string } | { error: string } {
  let text = reply.trim();
  const fenced = /^```[\w-]*\n([\s\S]*?)\n?```$/.exec(text);
  if (fenced) text = fenced[1]!.trim();
  text = text.replace(/^`([^`\n]+)`$/, '$1').replace(/^\$ /, '').trim();
  if (text.startsWith(CANNOT)) return { error: text.slice(CANNOT.length).trim() || '어떤 명령인지 알 수 없습니다.' };
  if (!text) return { error: '모델이 명령을 내놓지 않았습니다.' };
  return { command: text };
}

export interface InferDeps {
  /** One model call: system prompt and user text in, reply text out. */
  complete(system: string, user: string): Promise<string>;
  /** Shows the command for confirmation; resolves with the text to run, or undefined when cancelled. */
  confirm(title: string, command: string): Promise<string | undefined>;
}

export type Inferred = { command: string; edited: boolean } | { cancelled: true } | { error: string };

export async function inferCommand(intent: string, context: InferContext, { complete, confirm }: InferDeps): Promise<Inferred> {
  const parsed = parseInferred(await complete(INFER_SYSTEM, inferPrompt(intent, context)));
  if ('error' in parsed) return parsed;
  const answer = (await confirm(`추론한 명령 · 고쳐도 됩니다 · ${intent}`, parsed.command))?.trim();
  if (!answer) return { cancelled: true };
  return { command: answer, edited: answer !== parsed.command };
}
