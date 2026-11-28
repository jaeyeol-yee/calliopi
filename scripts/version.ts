// Calliopi's version (see CONTRIBUTING.md, "버전").
//
//   <Pi major>.<Pi minor>.<harness>   e.g. 1.7.3 is the fourth harness release for Pi 1.7
//
// The root package and every workspace package carry the same version. Pi itself is updated with
// `pi update`; the repository follows it: every @earendil-works/pi-* devDependency is pinned to the
// installed Pi's exact version, and the harness version's major.minor follow that pin.
//
//   node scripts/version.ts check          versions agree with each other and with the Pi pin (npm run check)
//   node scripts/version.ts bump           next harness release: x.y.z → x.y.(z+1)
//   node scripts/version.ts sync [x.y.z]   after `pi update`: pin Pi to the installed version (or x.y.z),
//                                          npm install, and on a new Pi minor reset to <major>.<minor>.0
//                                          (--no-install skips npm install)
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const PI = '@earendil-works/pi-coding-agent';
const PI_SCOPE = /^@earendil-works\/pi-/;
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;
const DEP_FIELDS = ['dependencies', 'devDependencies'] as const;

type Json = Record<string, any>;
const read = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8')) as Json;
const write = (file: string, json: unknown) => fs.writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`);
const manifest = (dir: string) => path.join(ROOT, dir, 'package.json');

/** Package directories relative to the root: the root first, then each workspace package. */
const manifests = ['.', ...fs.readdirSync(path.join(ROOT, 'packages')).sort().map((d) => `packages/${d}`)]
  .filter((dir) => fs.existsSync(manifest(dir)));

/** The exact Pi version pinned in the root devDependencies. */
function piPin(): string {
  const pin = String(read(manifest('.')).devDependencies?.[PI]);
  if (!SEMVER.test(pin)) throw new Error(`root devDependencies must pin ${PI} to an exact x.y.z, found ${pin}`);
  return pin;
}

/** The version of the `pi` on PATH, or undefined when there is none or it does not answer. */
function installedPi(): string | undefined {
  try {
    const out = execFileSync('pi', ['--version'], { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] });
    return /\d+\.\d+\.\d+/.exec(out)?.[0];
  } catch { return undefined; }
}

const line = (v: string) => v.split('.').slice(0, 2).join('.');

/** Every problem with the current versions and Pi pins; empty when they are consistent. */
export function problems(): string[] {
  const out: string[] = [];
  const pin = piPin();
  const root = String(read(manifest('.')).version);
  for (const dir of manifests) {
    const json = read(manifest(dir));
    const v = String(json.version);
    if (!SEMVER.test(v)) out.push(`${dir}/package.json: version ${v} is not x.y.z (no pre-release or +build part)`);
    else if (v !== root) out.push(`${dir}/package.json: version ${v} differs from the root's ${root}`);
    for (const field of DEP_FIELDS) {
      for (const [name, range] of Object.entries<string>(json[field] ?? {})) {
        if (PI_SCOPE.test(name) && range !== pin) out.push(`${dir}/package.json: ${field} ${name} is ${range}, expected ${pin} like ${PI}`);
      }
    }
  }
  const lock = path.join(ROOT, 'package-lock.json');
  if (fs.existsSync(lock)) {
    const pkgs = read(lock).packages ?? {};
    for (const dir of manifests) {
      const v = pkgs[dir === '.' ? '' : dir]?.version;
      if (v !== undefined && v !== root) out.push(`package-lock.json: ${dir} is ${v}, expected ${root}`);
    }
  }
  if (SEMVER.test(root) && line(root) !== line(pin)) out.push(`version ${root} does not follow the pinned Pi ${pin}; run \`npm run version:sync\``);
  return out;
}

/** Writes `version` into every package.json and the matching package-lock.json entries. */
function setVersion(version: string) {
  for (const dir of manifests) {
    const file = manifest(dir);
    write(file, { ...read(file), version });
  }
  const lock = path.join(ROOT, 'package-lock.json');
  if (fs.existsSync(lock)) {
    const json = read(lock);
    if (json.version !== undefined) json.version = version;
    for (const dir of manifests) {
      const entry = json.packages?.[dir === '.' ? '' : dir];
      if (entry) entry.version = version;
    }
    write(lock, json);
  }
}

/** Pins every exact @earendil-works/pi-* dependency (not the "*" peer ranges) to `version`; returns how many changed. */
function pinPi(version: string): number {
  let changed = 0;
  for (const dir of manifests) {
    const file = manifest(dir);
    const json = read(file);
    for (const field of DEP_FIELDS) {
      for (const [name, range] of Object.entries<string>(json[field] ?? {})) {
        if (PI_SCOPE.test(name) && range !== version) { json[field][name] = version; changed++; }
      }
    }
    write(file, json);
  }
  return changed;
}

function main(args: string[]) {
  const [command, ...rest] = args;
  const current = String(read(manifest('.')).version);
  if (command === 'check') {
    const found = problems();
    for (const p of found) console.error(p);
    if (found.length) { process.exitCode = 1; return; }
    const pin = piPin(), pi = installedPi();
    console.log(`version ${current} (Pi ${pin}, ${manifests.length} packages)`);
    // A note, not a failure: CI and cloud machines may run another Pi, or none.
    if (pi && pi !== pin) console.log(`note: the installed pi is ${pi}, the repository pins ${pin}; run \`npm run version:sync\` to follow it`);
    return;
  }
  if (command === 'bump') {
    const pin = piPin();
    const m = SEMVER.exec(current);
    if (!m || line(current) !== line(pin)) throw new Error(`version ${current} is not on the pinned Pi ${line(pin)} line; run \`npm run version:sync\` first`);
    const next = `${m[1]}.${m[2]}.${Number(m[3]) + 1}`;
    setVersion(next);
    console.log(`${current} → ${next}`);
    return;
  }
  if (command === 'sync') {
    const install = !rest.includes('--no-install');
    const target = rest.find((a) => !a.startsWith('--')) ?? installedPi();
    if (!target) throw new Error('no pi on PATH; pass the Pi version: npm run version:sync -- x.y.z');
    if (!SEMVER.test(target)) throw new Error(`Pi version ${target} is not x.y.z`);
    const before = piPin();
    const changed = pinPi(target);
    if (changed) console.log(`Pi ${before} → ${target} (${changed} pins)`);
    else console.log(`Pi pins already at ${target}`);
    if (changed && install) execFileSync('npm', ['install'], { cwd: ROOT, stdio: 'inherit' });
    const next = SEMVER.test(current) && line(current) === line(target) ? current : `${line(target)}.0`;
    setVersion(next);
    console.log(next === current ? `version stays ${current}` : `${current} → ${next}`);
    if (changed) console.log('next: npm run check, then update "Pi … 에서 검증" in README.md');
    return;
  }
  throw new Error('usage: node scripts/version.ts check | bump | sync [x.y.z] [--no-install]');
}

try { main(process.argv.slice(2)); } catch (error) { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; }
