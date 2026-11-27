// Starting a child: everything the child Pi needs is put in its directory first (the system prompt,
// a session file whose header names the parent session), then the command that runs it. The parent
// runs it in a pseudo-terminal of its own (lib/fleet.ts) with its environment plus the agent
// directory; nothing of the environment goes on the command line.
import fs from 'node:fs';
import path from 'node:path';
import type { AgentMeta } from '@calliopi/core/agents';
import { FINISH_TOOL } from '#lib/contract.ts';

/** Set in a child Pi: its agent directory. Its presence is what makes a Pi a child. */
export const AGENT_DIR_ENV = 'CALLIOPI_AGENT_DIR';
/** Demo and tests: the child's scripted replies (the faux model reads DEMO_SCENARIO). */
export const CHILD_SCENARIO_ENV = 'DEMO_CHILD_SCENARIO';

export const PROMPT_FILE = 'system-prompt.md';

export interface ChildLaunch {
  /** How to run Pi itself, e.g. [node, /…/cli.js]. */
  pi: string[];
  /** Extensions to load with -e (Pi loads one path once, also when settings name it too). */
  extensions: string[];
  /** Extra variables, e.g. for a test's model. */
  env?: Record<string, string>;
  /** The parent's session file, recorded in the child's session header. */
  parentSession?: string;
}

/** The session file the child opens: created now, so its header can name the parent session. */
export function prepareSession(dir: string, meta: AgentMeta, parentSession: string | undefined, now = new Date()): string {
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const file = path.join(dir, `${stamp}_${meta.id}.jsonl`);
  // Pi matches the header's cwd with its own, which is the real path (/tmp is /private/tmp on macOS).
  const header = { type: 'session', version: 3, id: meta.id, timestamp: now.toISOString(), cwd: fs.realpathSync(meta.cwd), ...(parentSession ? { parentSession } : {}) };
  fs.writeFileSync(file, `${JSON.stringify(header)}\n`, { mode: 0o600, flag: 'wx' });
  return file;
}

export interface ChildSpawn { command: string; args: string[]; env: NodeJS.ProcessEnv }

/** How to run the child: `pi --session-dir <dir> --session-id <id> …`. The task is not on it: the child submits it itself. */
export function childSpawn(dir: string, meta: AgentMeta, launch: ChildLaunch, env: NodeJS.ProcessEnv = process.env): ChildSpawn {
  const vars: NodeJS.ProcessEnv = { ...env, [AGENT_DIR_ENV]: dir };
  if (env[CHILD_SCENARIO_ENV]) vars.DEMO_SCENARIO = env[CHILD_SCENARIO_ENV];
  Object.assign(vars, launch.env);
  const [command, ...pre] = launch.pi;
  return {
    command: command!,
    args: [
      ...pre,
      '--session-dir', dir, '--session-id', meta.id,
      ...launch.extensions.flatMap(e => ['-e', e]),
      '--model', meta.model,
      ...(meta.thinking ? ['--thinking', meta.thinking] : []),
      '--tools', [...meta.tools, FINISH_TOOL].join(','),
      // --tools keeps MCP tools unless an entry names them (Pi docs/cli.md): a role that does not list
      // mcp__ tools gets none, rather than every MCP tool of the user's setup.
      ...(meta.tools.some(t => t.startsWith('mcp__')) ? [] : ['--no-mcp']),
      '--append-system-prompt', path.join(dir, PROMPT_FILE),
    ],
    env: vars,
  };
}

/** The extensions this Pi was started with (-e, --extension), so a child loads them too. */
export function extensionArgs(argv = process.argv): string[] {
  const out: string[] = [];
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]!;
    if ((a === '-e' || a === '--extension') && argv[i + 1]) out.push(argv[++i]!);
    else if (a.startsWith('--extension=')) out.push(a.slice('--extension='.length));
  }
  return out.map(e => (fs.existsSync(e) ? path.resolve(e) : e)); // a package source (npm:, git:) stays as given
}

/** How this Pi was started, to start a child the same way (Pi's own subagent example does the same). */
export function piInvocation(argv = process.argv, execPath = process.execPath): string[] {
  const script = argv[1];
  if (script && fs.existsSync(script)) return [execPath, script];
  return /^(node|bun)(\.exe)?$/i.test(path.basename(execPath)) ? ['pi'] : [execPath];
}
