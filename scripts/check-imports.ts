// Import rules for the workspace packages (run: npm run check:imports).
//
//   inside a package   #lib/x.ts, #extensions/x.ts … (package.json "imports"); no ./ or ../
//   across packages    @calliopi/<name>/<subpath> only, where the subpath is in that package's
//                      "exports" and the importer declares @calliopi/<name> as a dependency
//   never              a path into another package's directory (relative, absolute or packages/…)
//   layers             package.json "calliopi.layer"; a package imports only strictly lower layers:
//                        core < ui, context < app   (so app ↛ app, ui ↛ context, core ↛ anything)
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const PACKAGES = path.join(ROOT, 'packages');
const SOURCE = /\.(ts|mts|cts|mjs|js|cjs)$/;
const SPEC = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)(['"])([^'"]+)\1/g;

const LAYERS: Record<string, number> = { core: 0, ui: 1, context: 1, app: 2 };

type Pkg = {
  dir: string; name: string; layer: string;
  imports: Record<string, string>; exports: Record<string, string>;
  deps: Set<string>;
};

const readJson = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, any>;
const pkgs: Pkg[] = fs.readdirSync(PACKAGES)
  .filter((d) => fs.existsSync(path.join(PACKAGES, d, 'package.json')))
  .map((d) => {
    const j = readJson(path.join(PACKAGES, d, 'package.json'));
    const exp = typeof j.exports === 'string' ? { '.': j.exports } : (j.exports ?? {});
    return {
      dir: path.join(PACKAGES, d), name: j.name, layer: j.calliopi?.layer, imports: j.imports ?? {}, exports: exp,
      deps: new Set(Object.keys({ ...j.dependencies, ...j.peerDependencies, ...j.optionalDependencies })),
    };
  });
const byName = new Map(pkgs.map((p) => [p.name, p]));

/** Resolve a specifier against an "imports"/"exports" map with Node's single-`*` patterns. */
function match(map: Record<string, string>, key: string): string | undefined {
  if (typeof map[key] === 'string') return map[key];
  for (const [pattern, target] of Object.entries(map)) {
    const star = pattern.indexOf('*');
    if (star < 0 || typeof target !== 'string') continue;
    const [pre, post] = [pattern.slice(0, star), pattern.slice(star + 1)];
    if (key.startsWith(pre) && key.endsWith(post) && key.length >= pre.length + post.length) {
      return target.replace('*', key.slice(pre.length, key.length - post.length));
    }
  }
  return undefined;
}

const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
  if (e.name === 'node_modules' || e.name.startsWith('.')) return [];
  const p = path.join(d, e.name);
  return e.isDirectory() ? walk(p) : SOURCE.test(e.name) ? [p] : [];
});

const problems: string[] = [];
for (const pkg of pkgs) {
  if (!(pkg.layer in LAYERS)) problems.push(`${pkg.name}: package.json "calliopi.layer" must be one of ${Object.keys(LAYERS).join(', ')}`);
}
const edges = new Map<string, Set<string>>();
for (const pkg of pkgs) {
  for (const file of walk(pkg.dir)) {
    const src = fs.readFileSync(file, 'utf8');
    const where = path.relative(ROOT, file);
    for (const m of src.matchAll(SPEC)) {
      const spec = m[2];
      const line = src.slice(0, m.index).split('\n').length;
      const at = `${where}:${line} '${spec}'`;
      if (spec.startsWith('.') || path.isAbsolute(spec) || spec.includes('packages/')) {
        problems.push(`${at}: use a # alias (same package) or @calliopi/<name>/<export> (other package)`);
      } else if (spec.startsWith('#')) {
        const target = match(pkg.imports, spec);
        if (!target) problems.push(`${at}: no matching "imports" entry in ${pkg.name}`);
        else if (!fs.existsSync(path.join(pkg.dir, target))) problems.push(`${at}: ${target} does not exist`);
      } else if (spec.startsWith('@calliopi/')) {
        const [scope, name, ...rest] = spec.split('/');
        const dep = byName.get(`${scope}/${name}`);
        if (!dep) { problems.push(`${at}: no workspace package ${scope}/${name}`); continue; }
        if (dep === pkg) { problems.push(`${at}: self import; use a # alias`); continue; }
        if (LAYERS[dep.layer]! >= LAYERS[pkg.layer]!) problems.push(`${at}: ${pkg.name} (${pkg.layer}) may only import lower layers, not ${dep.name} (${dep.layer})`);
        if (!pkg.deps.has(dep.name)) problems.push(`${at}: ${dep.name} is not declared in ${pkg.name} dependencies`);
        const target = match(dep.exports, rest.length ? `./${rest.join('/')}` : '.');
        if (!target) problems.push(`${at}: not in ${dep.name} "exports"`);
        else if (!fs.existsSync(path.join(dep.dir, target))) problems.push(`${at}: export target ${target} does not exist`);
        if (!edges.has(pkg.name)) edges.set(pkg.name, new Set());
        edges.get(pkg.name)!.add(dep.name);
      }
    }
  }
}

// Package import graph must stay acyclic.
const visit = (name: string, trail: string[]): void => {
  if (trail.includes(name)) { problems.push(`dependency cycle: ${[...trail, name].join(' → ')}`); return; }
  for (const next of edges.get(name) ?? []) visit(next, [...trail, name]);
};
for (const name of edges.keys()) visit(name, []);

if (problems.length) {
  const unique = [...new Set(problems)];
  console.error(unique.join('\n'));
  console.error(`\n${unique.length} import problem(s).`);
  process.exit(1);
}
const cross = [...edges].map(([from, to]) => `${from} → ${[...to].join(', ')}`).join('; ') || 'none';
const byLayer = Object.keys(LAYERS).map((l) => `${l}: ${pkgs.filter((p) => p.layer === l).map((p) => p.name.replace('@calliopi/', '')).join(', ') || '—'}`).join(' · ');
console.log(`imports ok: ${pkgs.length} packages (${byLayer}); cross-package: ${cross}`);
