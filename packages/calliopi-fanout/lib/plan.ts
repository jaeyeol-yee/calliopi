// Fan-out plan helpers: batch naming, validation, the approval table and the hidden planning brief.
// Pure (no Pi imports) so they can be unit-tested; the extension wires them to the UI.

export type Task = { label: string; summary: string; instruction: string; output: string; prompt?: string };
export type Spec = { batch: string; title?: string; agents: Task[] };

const stamp = (now = new Date()) => now.toISOString().slice(0, 16).replace(/[:T-]/g, '');
export const slug = (t: string) => t.toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 40);
export const newBatch = (title?: string, now = new Date()) => (title && slug(title) ? `${slug(title)}-${stamp(now).slice(4)}` : `pi-${stamp(now)}`);

export function validate(spec: Spec) {
  if (!Array.isArray(spec.agents) || !spec.agents.length) throw new Error('plan has no tasks');
  const seen = new Set<string>();
  for (const t of spec.agents) {
    if (!t?.instruction && t?.prompt) t.instruction = t.prompt; // legacy shape
    if (!t?.label || !t?.summary || !t?.instruction || !t?.output) throw new Error('every task needs label, summary, instruction and output');
    if (seen.has(t.label)) throw new Error(`duplicate label: ${t.label}`);
    seen.add(t.label);
  }
}

// Display width: East Asian wide/fullwidth characters take two terminal cells.
const cellW = (ch: string) => /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(ch) ? 2 : 1;
export const width = (s: string) => [...s].reduce((n, ch) => n + cellW(ch), 0);
export function fit(text: string, w: number) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (width(t) <= w) return t + ' '.repeat(w - width(t));
  let out = ''; let n = 0;
  for (const ch of t) { if (n + cellW(ch) > w - 1) break; out += ch; n += cellW(ch); }
  return out + '…' + ' '.repeat(Math.max(0, w - n - 1));
}

export function planTable(plan: any, spec: Spec, cols = process.stdout.columns || 100) {
  const rows = (plan.plan || []) as any[];
  const repo = rows[0]?.repo ? String(rows[0].repo).replace(/^https?:\/\/github\.com\//, '') : '(no repo)';
  const lw = Math.min(16, Math.max(5, ...rows.map((r) => width(String(r.label)))));
  const sw = Math.max(18, Math.min(48, Math.floor((cols - lw - 12) * 0.55)));
  const ow = Math.max(14, Math.min(40, cols - lw - sw - 12));
  const head = `${spec.title ? `${spec.title}  ` : ''}☁ ${rows.length} agent(s) · via ${plan.via} · ${repo} · batch ${spec.batch}`;
  const lines = [
    head,
    `billing: ${rows[0]?.billing ?? 'plan usage'}${plan.skipped?.length ? ` · ${plan.skipped.length} already tracked (skipped)` : ''}`,
    '',
    ` #  ${fit('label', lw)}  ${fit('summary', sw)}  output`,
    ` ── ${'─'.repeat(lw)}  ${'─'.repeat(sw)}  ${'─'.repeat(ow)}`,
    ...rows.map((r, i) => ` ${String(i + 1).padStart(2)}  ${fit(r.label, lw)}  ${fit(r.summary || r.prompt, sw)}  ${fit(r.output || '', ow).trimEnd()}`),
    '',
    '(Edit plan shows the full instruction of every task)',
  ];
  return lines.join('\n');
}

export const PLAN_INSTRUCTIONS = (goal: string) => [
  'Plan a Cursor Cloud fan-out for the goal below, then call calliopi_fanout_launch.',
  '- Split it into independent tasks that can run in parallel without depending on each other (usually 2-6).',
  "- Give the whole fan-out a short human title (a few words, in the user's language) as `title`.",
  "- Each task has: label (short unique kebab-case), summary (one line: the goal, in the user's language),",
  '  instruction (self-contained: what to do, where, constraints, how to verify), output (the concrete deliverable:',
  "  e.g. 'a pushed commit that adds X', or 'a one-line report in Korean'). The cloud agent sees only these fields.",
  '- When a task changes code, its output is a pull request: the cloud agent commits, pushes its own branch and opens a PR',
  "  against the base branch (title/body in the user's language: what changed, how it was verified, loose ends).",
  "  Only say 'do not open a PR' when the goal asks for that or the task produces no code (e.g. a report).",
  '- Do not do the work locally and do not inspect files beyond what you need to write good prompts.',
  '- The user approves or edits the plan in a table before anything starts.',
  '',
  `Goal: ${goal}`,
].join('\n');
