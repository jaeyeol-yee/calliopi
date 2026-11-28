// Calliopi's version (see CONTRIBUTING.md, "Versioning").
//
//   <Pi major>.<Pi minor>.<harness>   e.g. 1.7.3 is the fourth harness release for Pi 1.7
//
// The root package and every workspace package carry the same version. Its major.minor follow the Pi
// version pinned in the root devDependencies; the patch counts harness releases on that Pi line.
//
//   node scripts/version.ts check   every version is the same and matches the pinned Pi (npm run check)
//   node scripts/version.ts bump    next harness release: x.y.z → x.y.(z+1)
//   node scripts/version.ts sync    after moving to a new Pi minor: → <Pi major>.<Pi minor>.0
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const PI = '@earendil-works/pi-coding-agent';
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

const read = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, any>;
const write = (file: string, json: unknown) => fs.writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`);

/** package.json files: the root first, then each workspace package, as paths relative to the root. */
const manifests = ['.', ...fs.readdirSync(path.join(ROOT, 'packages')).sort().map((d) => `packages/${d}`)]
  .filter((dir) => fs.existsSync(path.join(ROOT, dir, 'package.json')));

/** The Pi line the harness is built against: major.minor of the exact Pi pin in the root devDependencies. */
function piLine(): [number, number] {
  const pin = read(path.join(ROOT, 'package.json')).devDependencies?.[PI];
  const m = SEMVER.exec(String(pin));
  if (!m) throw new Error(`root devDependencies must pin ${PI} to an exact x.y.z, found ${JSON.stringify(pin)}`);
  return [Number(m[1]), Number(m[2])];
}

/** Every problem with the current versions; empty when they are consistent. */
export function problems(): string[] {
  const out: string[] = [];
  const versions = manifests.map((dir) => [dir, String(read(path.join(ROOT, dir, 'package.json')).version)] as const);
  const [, first] = versions[0]!;
  for (const [dir, v] of versions) {
    if (!SEMVER.test(v)) out.push(`${dir}/package.json: version ${v} is not x.y.z (no pre-release or +build part)`);
    else if (v !== first) out.push(`${dir}/package.json: version ${v} differs from the root's ${first}`);
  }
  const lock = path.join(ROOT, 'package-lock.json');
  if (fs.existsSync(lock)) {
    const pkgs = read(lock).packages ?? {};
    for (const dir of manifests) {
      const v = pkgs[dir === '.' ? '' : dir]?.version;
      if (v !== undefined && v !== first) out.push(`package-lock.json: ${dir} is ${v}, expected ${first}`);
    }
  }
  const m = SEMVER.exec(first);
  if (m) {
    const [major, minor] = piLine();
    if (Number(m[1]) !== major || Number(m[2]) !== minor) {
      out.push(`version ${first} does not follow the pinned Pi ${major}.${minor}; run \`node scripts/version.ts sync\``);
    }
  }
  return out;
}

/** Writes `version` into every package.json and the matching package-lock.json entries. */
function setVersion(version: string) {
  for (const dir of manifests) {
    const file = path.join(ROOT, dir, 'package.json');
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

function main(command: string | undefined) {
  const current = String(read(path.join(ROOT, 'package.json')).version);
  const [major, minor] = piLine();
  if (command === 'check') {
    const found = problems();
    for (const p of found) console.error(p);
    if (found.length) process.exitCode = 1;
    else console.log(`version ${current} (Pi ${major}.${minor}, ${manifests.length} packages)`);
    return;
  }
  if (command === 'bump' || command === 'sync') {
    const m = SEMVER.exec(current);
    const sameLine = !!m && Number(m[1]) === major && Number(m[2]) === minor;
    if (command === 'bump' && !sameLine) throw new Error(`version ${current} is not on the pinned Pi ${major}.${minor} line; run sync first`);
    if (command === 'sync' && sameLine) { console.log(`version ${current} already follows Pi ${major}.${minor}`); setVersion(current); return; }
    const next = command === 'bump' ? `${major}.${minor}.${Number(m![3]) + 1}` : `${major}.${minor}.0`;
    setVersion(next);
    console.log(`${current} → ${next}`);
    return;
  }
  throw new Error('usage: node scripts/version.ts check | bump | sync');
}

try { main(process.argv[2]); } catch (error) { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; }
