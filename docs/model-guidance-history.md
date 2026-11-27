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
