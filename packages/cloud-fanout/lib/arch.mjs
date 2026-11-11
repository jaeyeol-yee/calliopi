// Source-tree & architecture outline. Pure: takes path lists + a file reader, no I/O policy,
// no multiplexer knowledge. Sources (agent workspace, GitHub base, local git) are adapters.
import path from 'node:path';

const NOISE = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'target', '__pycache__', '.venv', 'vendor', 'coverage']);
const MANIFESTS = {
  'package.json': 'node', 'Cargo.toml': 'rust', 'pyproject.toml': 'python', 'setup.py': 'python',
  'go.mod': 'go', 'pubspec.yaml': 'dart', 'build.gradle': 'jvm', 'build.gradle.kts': 'jvm', 'pom.xml': 'jvm',
  'Gemfile': 'ruby', 'composer.json': 'php', 'mix.exs': 'elixir', 'deno.json': 'deno',
};
const LANG = {
  '.ts': 'TypeScript', '.tsx': 'TypeScript', '.js': 'JavaScript', '.mjs': 'JavaScript', '.cjs': 'JavaScript', '.jsx': 'JavaScript',
  '.py': 'Python', '.rs': 'Rust', '.go': 'Go', '.dart': 'Dart', '.java': 'Java', '.kt': 'Kotlin', '.rb': 'Ruby', '.php': 'PHP',
  '.swift': 'Swift', '.c': 'C', '.h': 'C', '.cc': 'C++', '.cpp': 'C++', '.cs': 'C#', '.lua': 'Lua', '.sh': 'Shell',
  '.ex': 'Elixir', '.exs': 'Elixir', '.md': 'Markdown', '.json': 'JSON', '.yaml': 'YAML', '.yml': 'YAML', '.toml': 'TOML',
};
const DOCS = /(^|\/)(README|CHANGELOG|CONTRIBUTING|LICENSE)[^/]*$|(^|\/)docs?\//i;
const TESTS = /(^|\/)(test|tests|__tests__|spec)\/|\.(test|spec)\.[a-z]+$/i;
const ENTRY = /(^|\/)(bin\/[^/]+|main\.[a-z]+|index\.[a-z]+|cli\.[a-z]+|app\.[a-z]+|server\.[a-z]+)$/i;

const isNoise = (p) => p.split('/').some((seg) => NOISE.has(seg));

/**
 * Compare a base path list (e.g. the starting ref) with the current one, then overlay
 * observed edits (changes log) when available. status: added | deleted | modified | same | unknown
 */
export function diffTrees({ base = null, current, changes = new Map() }) {
  const cur = new Set(current.filter((p) => !isNoise(p)));
  const bas = base ? new Set(base.filter((p) => !isNoise(p))) : null;
  const out = new Map();
  for (const p of cur) {
    const ch = changes.get(p);
    let status = bas ? (bas.has(p) ? 'same' : 'added') : 'unknown';
    if (ch && status !== 'added') status = 'modified';
    out.set(p, { status, ...(ch ? { linesAdded: ch.linesAdded, linesRemoved: ch.linesRemoved, confidence: ch.confidence } : {}) });
  }
  if (bas) for (const p of bas) if (!cur.has(p)) out.set(p, { status: 'deleted' });
  return out;
}

function toNodes(files) {
  const root = { name: '', dirs: new Map(), files: [], count: 0, changed: 0 };
  for (const [p, info] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
    const parts = p.split('/');
    let n = root;
    n.count += 1; if (info.status !== 'same') n.changed += 1;
    for (const seg of parts.slice(0, -1)) {
      if (!n.dirs.has(seg)) n.dirs.set(seg, { name: seg, dirs: new Map(), files: [], count: 0, changed: 0 });
      n = n.dirs.get(seg);
      n.count += 1; if (info.status !== 'same') n.changed += 1;
    }
    n.files.push({ name: parts.at(-1), ...info });
  }
  return root;
}

const MARK = { added: '+', deleted: '−', modified: '~', same: ' ', unknown: ' ' };
const fmtChange = (f) => (f.linesAdded != null ? ` (+${f.linesAdded} −${f.linesRemoved}${f.confidence && f.confidence !== 'exact' ? `, ${f.confidence}` : ''})` : '');

/** Render an indented tree. Large unchanged directories are collapsed; changed paths always shown. */
export function renderTree(files, { maxDepth = 4, maxEntries = 12, color = false } = {}) {
  const c = color
    ? { add: (s) => `\x1b[32m${s}\x1b[0m`, del: (s) => `\x1b[31m${s}\x1b[0m`, mod: (s) => `\x1b[33m${s}\x1b[0m`, dim: (s) => `\x1b[2m${s}\x1b[0m` }
    : { add: (s) => s, del: (s) => s, mod: (s) => s, dim: (s) => s };
  const paint = (st, s) => (st === 'added' ? c.add(s) : st === 'deleted' ? c.del(s) : st === 'modified' ? c.mod(s) : s);
  const lines = [];
  const walk = (node, prefix, depth) => {
    const entries = [
      ...[...node.dirs.values()].map((d) => ({ kind: 'dir', d })),
      ...node.files.map((f) => ({ kind: 'file', f })),
    ];
    // Always keep changed entries; truncate the unchanged tail.
    const keep = entries.filter((e) => (e.kind === 'dir' ? e.d.changed > 0 : e.f.status !== 'same'));
    const rest = entries.filter((e) => !keep.includes(e));
    const shown = [...keep, ...rest.slice(0, Math.max(0, maxEntries - keep.length))];
    shown.sort((a, b) => entries.indexOf(a) - entries.indexOf(b));
    const hidden = entries.length - shown.length;
    shown.forEach((e, i) => {
      const last = i === shown.length - 1 && hidden === 0;
      const branch = `${prefix}${last ? '└─ ' : '├─ '}`;
      const next = `${prefix}${last ? '   ' : '│  '}`;
      if (e.kind === 'dir') {
        const meta = c.dim(` ${e.d.count} file${e.d.count === 1 ? '' : 's'}${e.d.changed ? `, ${e.d.changed} changed` : ''}`);
        if (depth + 1 >= maxDepth && e.d.changed === 0) lines.push(`${branch}${e.d.name}/${meta}`);
        else { lines.push(`${branch}${paint(e.d.changed ? 'modified' : 'same', `${e.d.name}/`)}${meta}`); walk(e.d, next, depth + 1); }
      } else {
        lines.push(`${branch}${paint(e.f.status, `${MARK[e.f.status]} ${e.f.name}`)}${fmtChange(e.f)}`);
      }
    });
    if (hidden > 0) lines.push(`${prefix}└─ ${c.dim(`… ${hidden} more`)}`);
  };
  walk(toNodes(files), '', 0);
  return lines.join('\n');
}

/** Heuristic architecture outline. `readFile(path) → Promise<string|null>` reads only manifests. */
export async function outline(files, { readFile, maxManifestReads = 20 } = {}) {
  const present = [...files].filter(([, i]) => i.status !== 'deleted').map(([p]) => p);
  const langs = {};
  for (const p of present) { const l = LANG[path.extname(p).toLowerCase()]; if (l) langs[l] = (langs[l] || 0) + 1; }
  const manifests = present.filter((p) => MANIFESTS[path.basename(p)]).sort((a, b) => a.split('/').length - b.split('/').length);
  const packages = [];
  for (const m of manifests.slice(0, maxManifestReads)) {
    const dir = path.dirname(m) === '.' ? '.' : path.dirname(m);
    const pkg = { dir, ecosystem: MANIFESTS[path.basename(m)], manifest: m };
    if (readFile && path.basename(m) === 'package.json') {
      try {
        const j = JSON.parse((await readFile(m)) ?? 'null');
        if (j) Object.assign(pkg, {
          name: j.name, description: j.description,
          workspaces: Array.isArray(j.workspaces) ? j.workspaces : j.workspaces?.packages,
          bin: j.bin ? (typeof j.bin === 'string' ? { [j.name]: j.bin } : j.bin) : undefined,
          main: j.main, scripts: j.scripts ? Object.keys(j.scripts) : undefined,
          deps: Object.keys({ ...(j.dependencies || {}), ...(j.peerDependencies || {}) }),
          pi: j.pi ? Object.keys(j.pi) : undefined,
        });
      } catch { pkg.unreadable = true; }
    }
    packages.push(pkg);
  }
  const under = (dir) => (p) => dir === '.' || p === dir || p.startsWith(`${dir}/`);
  const owner = (p) => [...packages].sort((a, b) => b.dir.length - a.dir.length).find((k) => under(k.dir)(p))?.dir ?? '.';
  const changed = [...files].filter(([, i]) => !['same', 'unknown'].includes(i.status));
  const changedBy = {};
  for (const [p, i] of changed) (changedBy[owner(p)] ??= []).push(`${MARK[i.status]}${p}`);
  return {
    files: present.length,
    languages: Object.entries(langs).sort((a, b) => b[1] - a[1]),
    packages,
    entrypoints: present.filter((p) => ENTRY.test(p) && !TESTS.test(p)).slice(0, 20),
    tests: present.filter((p) => TESTS.test(p)).length,
    docs: present.filter((p) => DOCS.test(p)).length,
    changedByPackage: changedBy,
  };
}

export function renderOutline(o) {
  const L = [];
  L.push(`files ${o.files} · tests ${o.tests} · docs ${o.docs}`);
  if (o.languages.length) L.push(`languages  ${o.languages.slice(0, 6).map(([l, n]) => `${l} ${n}`).join(' · ')}`);
  L.push('', 'packages');
  if (!o.packages.length) L.push('  (no manifest found)');
  for (const p of o.packages) {
    L.push(`  ${p.dir === '.' ? '(root)' : p.dir}  [${p.ecosystem}]${p.name ? `  ${p.name}` : ''}${p.description ? ` — ${p.description}` : ''}`);
    if (p.workspaces?.length) L.push(`      workspaces: ${p.workspaces.join(', ')}`);
    if (p.bin) L.push(`      bin: ${Object.entries(p.bin).map(([k, v]) => `${k} → ${v}`).join(', ')}`);
    if (p.scripts?.length) L.push(`      scripts: ${p.scripts.join(', ')}`);
    if (p.deps?.length) L.push(`      deps: ${p.deps.slice(0, 8).join(', ')}${p.deps.length > 8 ? ' …' : ''}`);
    if (p.pi?.length) L.push(`      pi manifest: ${p.pi.join(', ')}`);
  }
  if (o.entrypoints.length) L.push('', `entrypoints  ${o.entrypoints.join(', ')}`);
  const ch = Object.entries(o.changedByPackage);
  L.push('', 'changed areas');
  if (!ch.length) L.push('  (none observed)');
  for (const [dir, list] of ch) L.push(`  ${dir === '.' ? '(root)' : dir}: ${list.length} file(s)  ${list.slice(0, 6).join(' ')}${list.length > 6 ? ' …' : ''}`);
  return L.join('\n');
}
