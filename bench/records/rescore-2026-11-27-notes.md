# What the re-grade of 2026-11-27 changes

Read with `rescore-2026-11-27.md` (the generated tables and run lists). 536 recorded runs were graded
again by the per-dimension oracle; no model was called. Checks that exist in both oracles and the list
of changed files reproduce the recorded result in 536 of 536 runs.

## Numbers

| | old pass | strict pass | outcome | diagnosis | citation | coverage | scope | hidden | extra findings (runs) |
|---|---|---|---|---|---|---|---|---|---|
| all 536 runs | 514 | 517 | 535/536 | 173/174 | 161/174 | 309/314 | 536/536 | 237/237 | 22 (20) |

- 13 verdicts changed: 8 fail → pass on review tasks, 5 pass → fail on coverage (below).
- The 8 that now pass: seven are gpt-6.1-terra on review/duration:
  both bugs diagnosed and cited, plus one or two lines that are no bug (14: number precision; 7 and 17:
  non-string input). One is claude-sonnet-5-5 on review/pagination v1 citing line 9, which v2 already accepted.
- No run changed a file outside its scope, and every recorded fix
  passes its hidden tests (237 of 237). So on these records the hidden tests and the scope dimension
  reject nothing a model did; the only evidence that they can fail is the special-cased fixes in
  `bench/test/bench.test.ts`.
- Of the 14 runs that still fail, 12 fail citation alone with the diagnosis right (the line before
  the bug: spot-bug 5 for 6, duration 11 for 12; once 11 for the regex bug). One misses a bug
  (terra at effort off found one of the two duration bugs). One is a wrong search answer (sol low, 8112).
- The 22 extra findings are of two kinds: 13 are the mis-cited line of a failed citation, 9 (in 7 runs)
  are findings added to a complete review. All 9 are terra on review/duration.

## Coverage and the size of answers

A task now lists what its answer must say (`content.required`; on review tasks the diagnosis is that
list) and what it may say (`content.allowed`: justification and evidence, verification, constraints
kept, and on review tasks what is explicitly no bug). A missing required item fails the coverage
dimension. The answer's blocks (paragraphs, list items) are counted as needed, allowed or surplus;
that split fails nothing.

- **Coverage fails 5 of 314 runs, all OpenAI models.** Four are final answers that speak only of a
  reviewer subagent that never reported, not of the change (terra on multi-file/promisify ×2 in s0-calib,
  sol on multi-file/rename-option ×2 in s1-coarse; all before the delegation fix of #23). One is a bare
  `3` on search/direct-callers (sol medium, s2-effort): a count with no call sites cannot be checked.
  No Anthropic answer misses a required item.
- **Answers differ in length by 3 to 5 times, and most of the difference is allowed content.** Median
  words, with the split of all words into needed / allowed / surplus:

  | class | opus-5-5 | sonnet-5-5 | fable-5-2 | terra | sol | astra |
  |---|---|---|---|---|---|---|
  | search | 80 · 41/55/4 | 76 · 42/56/2 | 70 · 49/50/1 | 18 · 67/33/0 | 16 · 68/32/0 | 15 · 57/43/0 |
  | small-fix | 63 · 85/15/0 | 40 · 92/8/0 | 41 · 90/10/0 | 23 · 68/32/0 | 27 · 82/18/0 | 27 · 82/18/0 |
  | multi-file | 133 · 63/23/14 | 98 · 57/27/17 | 68 · 56/32/12 | 32 · 67/32/1 | 44 · 63/37/0 | 39 · 65/35/0 |
  | review | 141 · 57/36/7 | 109 · 55/35/10 | 117 · 42/55/3 | 39 · 83/2/16 | 37 · 100/0/0 | 27 · 100/0/0 |

- **Surplus is small and of two kinds.** For the Anthropic models it is 12–17% on multi-file tasks
  (notes on behavior nobody asked about: unknown locales, negative amounts, a flag that is now ignored)
  and 3–10% on review. For terra it is 16% on review: the extra findings, which are the same runs the
  precision count already shows. sol and astra have none.
- **What this measure cannot say.** Allowed content is not judged for whether it was worth saying, so
  an answer three times as long with every block "allowed" has no surplus; the word count beside it is
  the only signal for that. A block is all one kind, so padding inside a needed paragraph is not seen.
  The required and allowed regexes were written after reading these answers; the five coverage failures
  and a sample of surplus blocks were read by hand, the rest were not.

## Conclusions that change

S2 interim conclusions (the comment on jaeyeol-yee/calliopi#24, one run per task):

- **5, "More effort makes terra over-report" and "terra passed only at medium".** The observation
  holds; the verdict does not. Terra's review strict passes by effort are off 2/3, low 2/3, medium 3/3,
  high 3/3, xhigh 3/3, max 3/3 (old: 2, 2, 3, 2, 2, 2). Over-reporting now shows as extra findings on
  review/duration: 0 at medium, 1 at high, 2 at xhigh, 2 at max. Below medium terra fails for other
  reasons: a missed bug at off, a mis-cited line at low.
- **Tentative review threshold.** It was "gpt-6.2-sol low ($0.011/run); terra medium passed only at
  that one effort, so it is fragile". Under strict pass terra passes review from medium up, so the
  cheapest arm that passes every review task is gpt-6.1-terra medium ($0.004/run, median), and it is no
  longer an isolated effort. It still rests on one run per task, and terra fails below medium.
- **4, "Effort fixes sonnet's line citations".** Unchanged, and now measured apart from diagnosis:
  sonnet at low and medium has diagnosis 3/3 and citation 1/3; from high up citation is 3/3.
- 1, 2, 3 and 6 (saturation, cost of max, low against medium, delegation) do not depend on review
  verdicts and are unchanged. The search and multi-file thresholds are unchanged. One search verdict
  does change: sol at medium passed search 3/3 and is now 2/3, for the bare `3` above (sol at low
  stays 2/3 for its wrong port).

S1 (`s1-coarse`, 216 runs): 212 → 210 strict passes. The four old failures (sonnet ×3, terra ×1,
review/spot-bug) stay: all a right diagnosis with line 5 cited for 6. Two sol runs on
multi-file/rename-option now fail coverage (the reviewer-only answers above), so sol's multi-file
is 4 of 6 where it was 6 of 6; the code in both passes every test, hidden ones included.

`docs/model-guidance-history.md`, the delegation measurement (`pr-delegation`): "passes terra 10 → 11
of 12" becomes 11 → 12 of 12 under strict pass (both changed runs are terra's review/duration with one
extra finding; terra's remaining failure before the change is a mis-cited line). sol, astra and the
opus control stay at 12 → 12. The entry's direction and its cost and subagent numbers are unchanged.
The entry itself is not edited here: it records what was measured with the oracle of the time.

s0-calib and s0-hard were graded by older task versions (review/duration v1, review/pagination v1);
their changed verdicts follow from the above.

## Limits of this re-grade

- The diagnosis regexes were written after reading these answers, so "173 of 174 diagnosed" is not an
  estimate of how often they would miss a right diagnosis phrased differently. Read by hand: all 22 runs
  that failed under the old oracle and the 5 that fail coverage. The 153 review runs that passed both ways were not read one by one.
- Whether an extra finding is wrong is not judged: a cited line of no listed bug counts as extra.
- Records keep no session files, so nothing here measures process (tool calls, diff size).
