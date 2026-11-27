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
