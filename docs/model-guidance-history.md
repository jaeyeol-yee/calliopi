# Model-guidance history

History only. This file records the sources, measurements and decisions behind text the model sees and per-model settings: role files, subagent contracts and reminders, tool descriptions, default models and effort. It is not routing input; do not read it to choose a model. Read it when changing that text or those settings and you need the evidence behind what is there.

Append a new entry at the end for every `prompt` or `model` PR (see `.github/PULL_REQUEST_TEMPLATE/`). Keep the kinds of basis apart: provider advice applies only to the model it was written for; a user decision is not a measurement; if nothing was measured, say so. Read provider guides in full before citing them; summaries and recollection do not count. Record what was tried and dropped.

```markdown
## YYYY-MM-DD: <models> — <one-line change>
- Scope: prompt | model | tool | routing-only
- Applies to: <provider/model ids, or "all models">
- Changed: <files> (commit <sha>, PR #NN)
- Basis: provider-advice | measured | user-decision | observed (session logs)
- Sources read in full: <links, date read>
- Measured: base <sha> vs <sha>; n tasks × k runs × models; before → after; tokens, turns, prefix rewrites
- Not adopted: <what was tried and showed no gain>
- Open risk / revisit when: <condition>
```

## 2026-11-27: all models — baseline

- Scope: prompt
- Applies to: all models
- Changed: none. Records the state at `50234d1`: the `scout` and `reviewer` roles (`packages/calliopi-agents/agents/*.md`), the subagent contract and its per-request reminder, the active-goal continuation, and the `web_fetch` and `subagent` tool descriptions.
- Basis: user-decision. All of this text is model-neutral; none of it has per-model branches.
- Sources read in full: none.
- Measured: nothing. No eval exists yet; P0 in `docs/research/agent-self-improvement-evidence.md` adds a prefix-rewrite report from `requests.jsonl`.
- Not adopted: nothing.
- Open risk / revisit when: a model ignores the contract or the goal reminder, over-delegates, or fails to call `finish`; or the first per-model rule is needed. At that point, move the rules the model reads into a separate guidance file and keep this file as history.

## 2026-11-27: all models — first run signals, and an `improver` role

- Scope: prompt
- Applies to: all models
- Changed: `.pi/agents/improver.md` (project role, proposes only); `npm run signals` (role lint and per-run counts)
- Basis: observed (61 recorded subagent runs, all `anthropic/claude-opus-5-5`, scout 29 and reviewer 32)
- Sources read in full: none
- Measured: role lint has no findings. Every request after the first is a prefix rewrite (428 of 428), and the cache hit rate is 14% (reviewer) and 19% (scout). In one scout run, cache reads stay at 5,392 tokens (system and tools) on every turn while cache writes grow from 2,589 to 33,862. The cause is the contract reminder that `context` appends to every request: Pi marks the last user message for caching, which is the reminder, and the next request moves it, so the conversation is written to the cache again each turn and never read. The comment in `child.ts` ("only the tail changes, so the cache holds") does not hold. Reviewer runs ended 5 of 32 times without `finish` (stopped 3, error 3, idle 1 among the ends).
- Not adopted: nothing yet. Candidate fix: keep the reminder but move the cache mark to the message before it, so the model sees the same text; that is a `perf` change measured by cache hit and prefix rewrites, not a prompt change.
- Open risk / revisit when: after that fix, rerun `npm run signals` on new runs; all runs here are one model, so per-model differences are unknown.

## 2026-11-27: all models — instructions for the session debrief

- Scope: prompt
- Applies to: all models (the reviewing model is the session's own unless `debrief.model` names another)
- Changed: `packages/core/lib/debrief.ts` (`DEBRIEF_INSTRUCTIONS`), `packages/calliopi-agents/lib/debrief.ts` (`SYSTEM_PROMPT`). New text, read only by the Pi that reviews a finished session; no existing model-facing text changes, and the reviewed session's own prompt and cache are untouched.
- Basis: user-decision (the owner asked for a background review at session end, in the same PR as the detectors). The wording is a guess: a fixed verdict and cause list so results can be counted, "a flag is not proof" and "cannot tell" against a reviewer agreeing with the detector, and no rewrites of prompts because proposals belong to the `improver` role and a person.
- Sources read in full: none for the wording. Related reading is in `docs/research/session-smell-triggers.md` (Devin Session Insights and Factory Signals run a model over finished sessions; neither publishes its prompt).
- Measured: nothing about the text. No real model has run it: the tests use the demo's faux model, which returns a fixed answer. Not known: whether verdicts are right, whether the model follows the format, how often it answers "cannot tell" on excerpts this short, and what a run costs.
- Not adopted: giving the reviewer read tools and the whole session file (more context, but a larger and unbounded send, and a tool-using process left running unattended); starting it for every session (a model call for sessions with nothing flagged); on by default.
- Open risk / revisit when: the first real debriefs exist. Read 20 of them against their sessions and record how many verdicts hold; if the session's own model reviews itself, compare with a model of another family on the same sessions. Until then a debrief is an opinion, and nothing should be changed on its word alone.


## 2026-11-27: OpenAI models — reviewer delegation, and subagents in pi -p

- Scope: prompt
- Applies to: all models; the observed difference is between families
- Changed: `packages/calliopi-agents/agents/reviewer.md` (when, not_when); `packages/calliopi-agents/lib/parent.ts` (runs that end with their answer wait for subagents)
- Basis: measured
- Sources read in full: none
- Measured: in the S1 benchmark (Pi 1.6.0, medium effort), gpt-6.1-terra, gpt-6.2-sol and gpt-6.2-astra started a reviewer on every multi-file and review task (36 of 36), opus-5-5, sonnet-5-5 and fable-5-2 on none. In `pi -p` 27 of those 36 children were cut off unfinished, and Pi printed a stale-context error after the answer. Before (c710e0d) against after (this change) in one window, 6 tasks × 2 runs per arm (`bench/specs/pr-delegation.yaml`, 96 runs, no provider errors): OpenAI subagent calls 35 → 0 (all 35 cut off before); passes terra 10 → 11 of 12, sol and astra 12 → 12; median cost per run terra −27%, sol −11%, astra −21%, against the opus control's +0.6% (12 → 12 passes, no subagents either way); median turns −1 for each OpenAI model; stale-context errors 18 → 0. A first attempt stopped at a ChatGPT usage limit after 36 runs and showed the same direction.
- Not adopted: nothing.
- Open risk / revisit when: the reviewer is now offered less; a task where a fresh-eyes review would have caught a bug is not in the suite.

## 2026-11-28: claude-opus-5-5, claude-sonnet-5-5 — effort, measured on the benchmark

- Scope: model (no change made; evidence for routing)
- Applies to: anthropic/claude-opus-5-5, anthropic/claude-sonnet-5-5
- Changed: nothing in Calliopi
- Basis: measured
- Sources read in full: none
- Measured: all 20 bench tasks × low, medium, high, xhigh × 10 runs per model (1,600 runs, Pi 1.7.0, Calliopi packages as of ef6e04b; `bench/specs/s2-drop.yaml` twice, `s2-sonnet-k10`, `s2-sonnet-k10-rest`, `s2-opus-k10`; records in `pr-assets`). Strict passes: opus 200/200 at every effort (median $0.031 at low to $0.052 at xhigh per run, 8 to 15 s). Sonnet 173, 176, 184, 195 of 200 from low to xhigh ($0.015 to $0.022, 7 to 10 s); every miss is precision, never the diagnosis: review line citations one line off (review/spot-bug 0/10 at low and medium, 9–10/10 from high; review/duration 7, 7, 2, 6 of 10, worst at high, always "lines 5, 11" for 5, 12; review/token-bucket 2, 5, 5, 10 of 10), and search/unused-flags answers out of the requested order or form (4, 4, 8, 9 of 10). Opus cited every line right.
- Not adopted: nothing yet.
- Open risk / revisit when: sonnet's off-by-one citations may come from reading files without line numbers; a read tool that shows them is a harness change to measure with `harnessRef`. The tasks do not separate opus at any effort.
