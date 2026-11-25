// Demo scenario: a YAML file under demo/scenarios/. Its path is its name, and the name fixes the
// output: demo/scenarios/<name>.yaml → assets/scenarios/<name>.gif.
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

export const ROOT = path.resolve(import.meta.dirname, '..', '..');
export const SCENARIOS = path.join(ROOT, 'demo', 'scenarios');
export const ASSETS = path.join(ROOT, 'assets', 'scenarios');

/** One block of a scripted model reply. A `tool` block ends the model call it belongs to. */
export type ReplyBlock =
  | { text: string }
  | { thinking: string }
  | { tool: string; args?: Record<string, unknown> };

export type Turn =
  /** Type a prompt, send it, and let the faux model answer with `reply`. */
  | { prompt: string; reply: ReplyBlock[]; wait?: string; pause?: string }
  /** Raw VHS commands, e.g. to drive a /command. `reply` answers a message those keys send. */
  | { tape: string; reply?: ReplyBlock[]; wait?: string; pause?: string };

export interface Scenario {
  name: string;
  file: string;
  output: string;
  title?: string;
  /** Shell script run in a fresh project directory before Pi starts (not recorded). */
  setup?: string;
  /** Project directory name shown by Pi as ~/<project>. */
  project: string;
  terminal: { width: number; height: number; fontSize: number; fontFamily?: string; theme?: string };
  /** Reply streaming speed of the faux model. */
  tokensPerSecond: number;
  /** Extra arguments for `pi`. */
  piArgs: string[];
  /**
   * Answers to one-off model requests an extension makes outside the conversation (e.g. /cl-run ?):
   * the first whose `match` (a regex) fits the request's text wins. Checked before `turns`.
   */
  completions: { match: string; text: string }[];
  /** Run Pi inside this terminal multiplexer, for commands that open panes (/cl-run, /cl-preview). */
  multiplexer?: 'tmux';
  turns: Turn[];
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function scenarioName(file: string): string {
  return path.relative(SCENARIOS, file).replace(/\\/g, '/').replace(/\.ya?ml$/, '');
}

export function listScenarioFiles(dir = SCENARIOS): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return listScenarioFiles(p);
    return /\.ya?ml$/.test(e.name) ? [p] : [];
  }).sort();
}

export function findScenarioFile(name: string): string {
  for (const ext of ['.yaml', '.yml']) {
    const file = path.join(SCENARIOS, name + ext);
    if (fs.existsSync(file)) return file;
  }
  throw new Error(`시나리오가 없습니다: ${name} (demo/scenarios/${name}.yaml)`);
}

function parseReply(value: unknown, where: string): ReplyBlock[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${where}: reply는 비어 있지 않은 배열이어야 합니다`);
  return value.map((b, i) => {
    const at = `${where}.reply[${i}]`;
    if (!isRecord(b)) throw new Error(`${at}: 객체여야 합니다`);
    if (typeof b.text === 'string') return { text: b.text };
    if (typeof b.thinking === 'string') return { thinking: b.thinking };
    if (typeof b.tool === 'string') {
      if (b.args !== undefined && !isRecord(b.args)) throw new Error(`${at}: args는 객체여야 합니다`);
      return { tool: b.tool, args: b.args as Record<string, unknown> | undefined };
    }
    throw new Error(`${at}: text, thinking, tool 중 하나가 필요합니다`);
  });
}

export function loadScenario(file: string): Scenario {
  const name = scenarioName(file);
  const raw: unknown = YAML.parse(fs.readFileSync(file, 'utf8'));
  if (!isRecord(raw)) throw new Error(`${name}: 최상위는 객체여야 합니다`);
  if (!Array.isArray(raw.turns) || raw.turns.length === 0) throw new Error(`${name}: turns가 필요합니다`);
  const turns: Turn[] = raw.turns.map((t, i) => {
    const where = `${name}.turns[${i}]`;
    if (!isRecord(t)) throw new Error(`${where}: 객체여야 합니다`);
    const wait = typeof t.wait === 'string' ? t.wait : undefined;
    const pause = typeof t.pause === 'string' ? t.pause : undefined;
    if (typeof t.prompt === 'string') return { prompt: t.prompt, reply: parseReply(t.reply, where), wait, pause };
    if (typeof t.tape === 'string') return { tape: t.tape, reply: t.reply === undefined ? undefined : parseReply(t.reply, where), wait, pause };
    throw new Error(`${where}: prompt 또는 tape가 필요합니다`);
  });
  if (raw.multiplexer !== undefined && raw.multiplexer !== 'tmux') throw new Error(`${name}: multiplexer는 tmux만 지원합니다`);
  const multiplexer = raw.multiplexer === 'tmux' ? 'tmux' as const : undefined;
  const completions = (Array.isArray(raw.completions) ? raw.completions : []).map((c, i) => {
    if (!isRecord(c) || typeof c.match !== 'string' || typeof c.text !== 'string') throw new Error(`${name}.completions[${i}]: match와 text가 필요합니다`);
    new RegExp(c.match); // a bad pattern fails here, not mid-recording
    return { match: c.match, text: c.text };
  });
  const term = isRecord(raw.terminal) ? raw.terminal : {};
  const num = (v: unknown, d: number) => (typeof v === 'number' && v > 0 ? v : d);
  const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
  return {
    name, file,
    output: path.join(ASSETS, `${name}.gif`),
    title: str(raw.title),
    setup: str(raw.setup),
    project: str(raw.project) ?? 'project',
    terminal: {
      width: num(term.width, 1200), height: num(term.height, 700), fontSize: num(term.fontSize, 16),
      fontFamily: str(term.fontFamily), theme: str(term.theme),
    },
    tokensPerSecond: num(raw.tokensPerSecond, 60),
    piArgs: Array.isArray(raw.piArgs) ? raw.piArgs.map(String) : [],
    multiplexer,
    completions,
    turns,
  };
}

/** Replies in the order the faux model is asked for them: one list per user message. */
export function replies(scenario: Pick<Scenario, 'turns'>): ReplyBlock[][] {
  return scenario.turns.flatMap((t) => (t.reply ? [t.reply] : []));
}
