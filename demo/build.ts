// Build demo GIFs from scenarios: demo/scenarios/<name>.yaml → assets/scenarios/<name>.gif.
//
//   node demo/build.ts                     every scenario
//   node demo/build.ts <name>…             the named scenarios
//   node demo/build.ts --tape [<name>…]    write demo/.out/<name>.tape only (no recording)
//   node demo/build.ts --plan --base <ref> print `matrix=[…]`: scenarios added since <ref> that have
//                                          no GIF yet, or changed after it was recorded (CI)
//   node demo/build.ts --plan --all        print `matrix=[…]`: every scenario (CI, manual run)
//   node demo/build.ts --check             list scenarios without a GIF and GIFs without a scenario
//
// Each recording runs Pi in a throwaway HOME with the faux model, so it needs no API key and never
// reads the user's settings, sessions or skills. Requires vhs (with ttyd and ffmpeg) on PATH.
// A scenario with `multiplexer: tmux` also needs tmux: Pi then runs inside a private tmux server.
// DEMO_FONT_FAMILY sets the terminal font when a scenario does not (e.g. a CJK monospace font).
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ASSETS, ROOT, findScenarioFile, listScenarioFiles, loadScenario, scenarioName, type Scenario } from './lib/scenario.ts';
import { planScenarios } from './lib/plan.ts';
import { buildTape } from './lib/tape.ts';

const OUT = path.join(ROOT, 'demo', '.out');
const PI = path.join(ROOT, 'node_modules', '.bin', 'pi');
const FAUX = path.join(ROOT, 'demo', 'faux-extension.ts');

const shellQuote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;

export function check(): { missing: string[]; orphaned: string[] } {
  const names = new Set(listScenarioFiles().map(scenarioName));
  const gifs = (function walk(dir: string): string[] {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = path.join(dir, e.name);
      return e.isDirectory() ? walk(p) : e.name.endsWith('.gif') ? [path.relative(ASSETS, p).replace(/\\/g, '/').replace(/\.gif$/, '')] : [];
    });
  })(ASSETS);
  return {
    missing: [...names].filter((n) => !fs.existsSync(path.join(ASSETS, `${n}.gif`))).sort(),
    orphaned: gifs.filter((g) => !names.has(g)).sort(),
  };
}

function prepare(s: Scenario) {
  // Resolve symlinks (macOS /var → /private/var) so Pi sees the workdir under HOME and shows ~/<project>.
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'calliopi-demo-')));
  const home = path.join(tmp, 'home');
  const workdir = path.join(home, s.project);
  const agent = path.join(tmp, 'agent');
  fs.mkdirSync(workdir, { recursive: true });
  fs.mkdirSync(agent, { recursive: true });
  fs.mkdirSync(path.join(tmp, 'tmp'));
  fs.writeFileSync(path.join(agent, 'settings.json'), JSON.stringify({ quietStartup: true }, null, 2));
  const env: Record<string, string> = {
    HOME: home,
    PI_CODING_AGENT_DIR: agent,
    PI_OFFLINE: '1',
    PI_SKIP_VERSION_CHECK: '1',
    PI_TELEMETRY: '0',
    TMPDIR: path.join(tmp, 'tmp'), // /cl-run keeps its jobs under the temp directory: not the user's
    DEMO_SCENARIO: s.file,
    GIT_AUTHOR_NAME: 'Calliopi Demo', GIT_AUTHOR_EMAIL: 'demo@calliopi.invalid',
    GIT_COMMITTER_NAME: 'Calliopi Demo', GIT_COMMITTER_EMAIL: 'demo@calliopi.invalid',
  };
  if (s.setup) {
    execFileSync('bash', ['-euo', 'pipefail', '-c', s.setup], { cwd: workdir, env: { ...process.env, ...env }, stdio: 'inherit' });
  }
  const pi = [PI, '--no-session', '--no-skills', '--no-context-files', '-e', FAUX, '-e', ROOT, '--model', 'faux/demo', ...s.piArgs]
    .map(shellQuote).join(' ');
  if (s.multiplexer !== 'tmux') return { tmp, workdir, env, pi };
  // A private server with its own config: the user's tmux and ~/.tmux.conf stay out of the picture.
  const conf = path.join(tmp, 'tmux.conf');
  fs.writeFileSync(conf, ['set -g extended-keys on', 'set -sg escape-time 0', 'set -g default-terminal "tmux-256color"',
    'set -g status-style "bg=#2a2a37,fg=#c8c8d0"', 'set -g status-left ""', 'set -g status-right ""', ''].join('\n'));
  const socket = `calliopi-demo-${process.pid}`;
  return { tmp, workdir, env, socket, pi: ['tmux', '-u', '-L', socket, '-f', conf, 'new-session', '-c', workdir, pi].map(shellQuote).join(' ') };
}

function writeTape(s: Scenario, t: { workdir: string; env: Record<string, string>; pi: string }): string {
  const file = path.join(OUT, `${s.name}.tape`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buildTape(s, { output: s.output, ...t }));
  return file;
}

function build(name: string, { tapeOnly }: { tapeOnly: boolean }) {
  const s = loadScenario(findScenarioFile(name));
  // CJK text needs a font whose glyphs are two cells wide; CI installs one and names it here.
  s.terminal.fontFamily ??= process.env.DEMO_FONT_FAMILY || undefined;
  const prepared = prepare(s);
  try {
    const tape = writeTape(s, prepared);
    console.log(`${s.name}: ${path.relative(ROOT, tape)}`);
    if (tapeOnly) return;
    fs.mkdirSync(path.dirname(s.output), { recursive: true });
    execFileSync('vhs', [tape], { cwd: prepared.workdir, stdio: 'inherit' });
    console.log(`${s.name}: ${path.relative(ROOT, s.output)}`);
  } finally {
    if (prepared.socket && !tapeOnly) spawnSync('tmux', ['-L', prepared.socket, 'kill-server'], { stdio: 'ignore' });
    if (!tapeOnly) fs.rmSync(prepared.tmp, { recursive: true, force: true });
  }
}

function main(argv: string[]) {
  const flag = (f: string) => { const i = argv.indexOf(f); if (i >= 0) argv.splice(i, 1); return i >= 0; };
  const option = (f: string) => { const i = argv.indexOf(f); if (i < 0) return undefined; const [, v] = argv.splice(i, 2); return v; };

  if (flag('--plan')) {
    const base = option('--base');
    const all = flag('--all');
    if (!base === !all) throw new Error('--plan에는 --base <ref> 또는 --all 중 하나가 필요합니다');
    console.log(`matrix=${JSON.stringify(all ? listScenarioFiles().map(scenarioName) : planScenarios(ROOT, base!))}`);
    return;
  }
  if (flag('--check')) {
    const { missing, orphaned } = check();
    for (const n of missing) console.log(`GIF 없음:      demo/scenarios/${n}.yaml`);
    for (const n of orphaned) console.log(`시나리오 없음: assets/scenarios/${n}.gif`);
    if (!missing.length && !orphaned.length) console.log('demo ok');
    process.exitCode = missing.length || orphaned.length ? 1 : 0;
    return;
  }
  const tapeOnly = flag('--tape');
  const unknown = argv.find((a) => a.startsWith('-'));
  if (unknown) throw new Error(`알 수 없는 옵션: ${unknown}`);
  const names = argv.length ? argv : listScenarioFiles().map(scenarioName);
  if (!names.length) { console.log('시나리오가 없습니다 (demo/scenarios/*.yaml)'); return; }
  for (const name of names) build(name, { tapeOnly });
}

if (import.meta.main ?? process.argv[1] === import.meta.filename) {
  try { main(process.argv.slice(2)); }
  catch (error: unknown) { console.error(error instanceof Error ? error.message : error); process.exit(1); }
}
