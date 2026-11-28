# Benchmark run records

Run records of `bench/` (Calliopi), not part of any release. Each archive holds one directory per spec:
`runs.jsonl` and `runs/<arm>/<class>__<name>/rep<N>/{answer.txt,stderr.txt,work/}`; session files and
subagent records are left out, and the home directory in stack traces reads `~`.

| archive | specs | runs |
|---|---|---|
| `2026-11-27.tgz` | s0-calib, s0-hard, s1-coarse, s2-effort (partial), pr-delegation | 536 |
| `2026-11-28.tgz` | everything so far: the above, plus s0-access, s0-cache, pr-delegation-partial-1 (stopped by a usage limit), s3-hard, s3-bounds-v3, s2-drop, s2-drop-openai; and the derived s3-final (s3-hard re-graded with review/bounds v3) and s2-drop-all (s2-drop's Anthropic arms with s2-drop-openai) | 2,524 records, of which 869 are derived (1,655 runs) |

Re-grade with the current oracle, no model called:

    git show origin/pr-assets:bench-records/2026-11-28.tgz > /tmp/records.tgz
    node bench/rescore.ts /tmp/records.tgz --out /tmp/rescore.md

A report of one spec: extract the archive and run `npm run bench -- --report <dir>/<spec>`.
