# Lightweight Evaluation Frameworks and Practices for a Small Local Coding-Agent Harness (Calliopi on Pi)

Research note, current as of 2026-11-26. Method caveat: in this session, direct page fetches were blocked for most hosts (inspect.aisi.org.uk, harborframework.com and hamel.dev did not resolve, and GitHub API access was not enabled). So almost all findings below come from web-search result snippets of the cited pages, not full-page reads. Exact CLI flags and class names should be checked against `--help` and the source before use.

## Frameworks: minimal setup to evaluate an external CLI agent, licensing, offline capability

### Takeaway
The two frameworks that fit "run my own CLI agent in a sandbox, then check the result with a script" are Harbor and Inspect AI. Harbor is the Terminal-Bench harness, and a Pi adapter for it already exists (`badlogic/pi-terminal-bench`). Inspect handles this through `sandbox_agent_bridge()` and `inspect_swe`. promptfoo is a lighter option for prompt- and output-level assertions, and OpenAI acquired it in 2026. OpenAI's hosted Evals platform is being shut down. Braintrust and LangSmith are SaaS-first with self-hosting reserved for enterprise tiers, which makes them a poor fit for a solo, offline-leaning setup.

### Cited Findings
**Harbor (Terminal-Bench harness)**
- To plug in a custom agent, implement the `BaseAgent` or `BaseInstalledAgent` interface. `BaseInstalledAgent` installs and runs an external CLI tool inside the environment through shell commands — [Harbor Core Concepts](https://www.harborframework.com/docs/core-concepts); [DeepWiki Harbor agents](https://deepwiki.com/harbor-framework/harbor/4-agents) (auto-generated summary)
- Built-in agents live in `src/harbor/agents/installed/` and are registered in an `AgentName` enum. The Claude Code agent (`claude_code.py`) is the reference implementation, and agents use `CLI_FLAGS`/`ENV_VARS` lists to map Harbor config onto tool arguments — [harbor AGENTS.md](https://github.com/harbor-framework/harbor/blob/main/AGENTS.md)
- An out-of-tree agent can be loaded with `--agent-import-path "module.path:ClassName"`. Example: `harbor run -d terminal-bench/terminal-bench-2 --agent-import-path "path.to.agent:SomeAgent" -k 5` — [Harbor configs](https://docs.harborframework.com/jobs/configs); [How to run Terminal-Bench 2.0](https://harbor-index.org/docs/run-terminal-bench-2-0)
- Examples show `-n 8` or `--n-concurrent 4` for concurrency. Several examples use `-k 5`, but I found no source that defines `-k` (it is probably attempts per task, which is unconfirmed) — [AI Learning Guides](https://ailearningguides.com/terminal-bench-2-benchmark-coding-agent/); [X article](https://x.com/adithya_s_k/article/2054961319179420035)
- A job config's tasks can point at a local task directory, or at a path inside a git repo — [Harbor configs](https://docs.harborframework.com/jobs/configs)
- A task's `task.toml` has an `[agent]` section, including `agent.timeout_sec` and `agent.user` — [Harbor Adapters guide](https://www.harborframework.com/docs/datasets/adapters); [Harbor Core Concepts](https://www.harborframework.com/docs/core-concepts)
- **Pi-specific:** `badlogic/pi-terminal-bench` is a Harbor agent adapter for the Pi coding agent. Usage is `harbor run ... --agent-import-path pi_terminal_bench:PiAgent` — [pi-terminal-bench](https://github.com/badlogic/pi-terminal-bench)
- **Pi-specific:** the `harbor-pi-sdk-agent` (PyPI) package wraps `@mariozechner/pi-coding-agent` and writes a trajectory file, a filtered Pi SDK event log (`pi-filtered.jsonl`) and an optional raw events log (`pi-raw.jsonl`) — [harbor-pi-sdk-agent on PyPI](https://pypi.org/project/harbor-pi-sdk-agent/)
- Harbor can run large numbers of evals in parallel on Modal. Cline publishes its open-weight evals on Harbor against Terminal-Bench's 89 tasks — [Cline blog](https://cline.bot/blog/open-sourcing-evals-for-open-weight-agents)
- Opik (Comet) and NVIDIA NeMo document integrations with Harbor — [Opik Harbor integration](https://www.comet.com/docs/opik/integrations/harbor); [NVIDIA Harbor runner](https://docs.nvidia.com/nemo-helix/documentation/evaluate-models/agent-eval/harbor-runner)

**Inspect AI (UK AISI) and inspect_swe**
- `sandbox_agent_bridge()` runs an agent inside a sandbox and proxies the agent's model calls back to Inspect's model provider. It supports agents written against the OpenAI Completions, OpenAI Responses, Anthropic or Google APIs. The documented pattern for a custom CLI is a standard Inspect agent that opens the bridge context and calls the CLI through `sandbox().exec()` — [Inspect agent bridge](https://inspect.aisi.org.uk/agent-bridge.html)
- `inspect_swe` packages Claude Code, Codex CLI, OpenCode, Mini SWE Agent and Gemini CLI as standard Inspect agents built on `sandbox_agent_bridge()`. Usage looks like `inspect eval task.py --solver inspect_swe/codex_cli` with `sandbox="docker"`. The package releases often (search results showed 0.2.6x versions) — [Inspect SWE](https://meridianlabs-ai.github.io/inspect_swe); [PyPI inspect-swe](https://pypi.org/project/inspect_swe/); [CHANGELOG](https://meridianlabs-ai.github.io/inspect_swe/CHANGELOG.html)
- AISI publishes a sandboxing toolkit for scalable and secure agent evals, and a separate `inspect-sandboxes` package collects further sandbox backends — [AISI blog](https://aisi.gov.uk/blog/the-inspect-sandboxing-toolkit-scalable-and-secure-ai-agent-evaluations); [inspect-sandboxes PyPI](https://pypi.org/project/inspect-sandboxes/)

**promptfoo**
- promptfoo has a coding-agent eval guide covering the Codex SDK, Claude Agent SDK, OpenCode SDK and Open Interpreter, and it supports a custom `file://` provider that launches the agent under test — [promptfoo: evaluate coding agents](https://www.promptfoo.dev/docs/guides/evaluate-coding-agents/); [promptfoo red-team coding agents](https://www.promptfoo.dev/docs/red-team/coding-agents/)
- Deterministic assertions run without an LLM ("fast, free, and stable"). Similarity, `llm-rubric` and `model-graded-*` assertions need a provider — [promptfoo assertions](https://www.promptfoo.dev/docs/configuration/expected-outputs/)
- The OpenAI Agents guide shows assertions on tool usage, sandbox commands, spans and tool order — [promptfoo OpenAI Agents guide](https://www.promptfoo.dev/docs/guides/evaluate-openai-agents-python/)
- OpenAI announced the Promptfoo acquisition on 2026-03-09. Promptfoo says it "will remain open source" — [OpenAI](https://openai.com/index/openai-to-acquire-promptfoo/); [promptfoo blog](https://promptfoo.dev/blog/promptfoo-joining-openai); [TechCrunch](https://www.techcrunch.com/2026/03/09/openai-acquires-promptfoo-to-secure-its-ai-agents/)

**OpenAI Evals**
- OpenAI announced on 2026-06-03 that the Evals platform is deprecated. Existing evals became read-only on 2026-10-31, and Agent Builder shuts down on 2026-11-30. OpenAI's migration guidance points to "Moving from OpenAI Evals to Promptfoo" — [OpenAI deprecations](https://developers.openai.com/api/docs/deprecations.md); [OpenAI evals guide](https://developers.openai.com/api/docs/guides/evals)
- The older open-source `openai/evals` repo is reportedly MIT-licensed and self-hosted — [Atlas tooling landscape](https://laoujin.github.io/Atlas/research/2026-06-04-evals-how-do-you-know-your-ai-works-session-blueprint/tooling-landscape-2026/) (secondary)

**DeepEval / Braintrust / LangSmith** (secondary comparison sources only)
- DeepEval is described as Apache-2.0, free to self-host and pytest-native, with Confident AI as the paid SaaS — [Atlas tooling landscape](https://laoujin.github.io/Atlas/research/2026-06-04-evals-how-do-you-know-your-ai-works-session-blueprint/tooling-landscape-2026/); [dev.to](https://dev.to/gabrielanhaia/picking-llm-eval-tooling-in-2026-4-questions-before-you-commit-4c5l)
- Braintrust is described as closed-source with self-hosting on the Enterprise tier only, though it offers "remote evals" that run your code on your own infrastructure — [Atlan](https://atlan.com/know/ai-agent/ai-agent-evals/braintrust-vs-agent-eval-platforms/); [PostHog](https://posthog.com/compare/best-braintrust-alternatives)
- LangSmith is described as managed, with self-hosting on higher or Enterprise tiers — [PromptLayer](https://blog.promptlayer.com/self-hosted-vs-saas-llm-eval-tools-compared/); [Arize](https://arize.com/resources/llm-and-agent-evaluation-platforms/)

### Inferences
- The lowest-effort path for Calliopi is probably Harbor with a fork or subclass of `pi-terminal-bench`'s `PiAgent`. It would install Pi plus the Calliopi extensions in the task container and run `pi -p`. Each extension configuration becomes a separate agent class or kwarg, and the A/B comparison becomes two `harbor run` jobs on the same local task directory.
- Inspect is the better choice if the developer wants a Python-native log viewer and scorers, with model calls proxied (which gives token accounting for free). The catch is that Pi's providers would need to point at the bridge's OpenAI- or Anthropic-compatible endpoint.
- promptfoo and DeepEval are output-assertion tools. They are useful for checking a single `pi -p` stdout or JSON, but they do not give you per-task repo fixtures or container isolation.
- OpenAI's hosted Evals platform should not be adopted (it is deprecated), and Braintrust and LangSmith are a poor fit for an offline, solo, free setup.

### Gaps
- I could not read the Harbor docs directly, so the exact meaning of `-k`, the required `BaseAgent` method signatures and the layout of a local `-p/--path` task were not confirmed.
- License files were not verified for Inspect AI, inspect_swe, inspect_evals, Harbor or promptfoo. My recollection is that Inspect is MIT and Harbor is Apache-2.0, but no source confirmed either in this session, so check each repo's LICENSE.
- I did not confirm whether Inspect or Harbor can run fully offline with local models. Both are local Python tools that use Docker, but the model provider is the limiting factor.

## How existing CLI coding agents evaluate themselves

### Takeaway
Most open agents now converge on Harbor and Terminal-Bench for external comparability (Goose, Cline, and Pi through an adapter). They add small in-repo suites of their own: Goose's "vibe check" developer-workflow evals, OpenCode's `opencode-bench` on real GitHub repos with three repeats, and Cline's `cline-bench` from real tasks. Aider's long-running harness is an Exercism-in-Docker runner that reports pass rates per attempt.

### Cited Findings
- **Aider:** the harness is `benchmark/benchmark.py`, run inside Docker (`./benchmark/docker_build.sh`, `docker.sh`). It uses 225 hard Exercism problems in C++, Go, Java, JS, Python and Rust. It reports `pass_rate_1` and `pass_rate_2` (one per `--tries` attempt, where the second attempt sees test-failure output), and the headline metric is the second-attempt pass rate — [Aider benchmark README mirror v0.85.1](https://git.joshthomas.dev/mirrors/aider/src/tag/v0.85.1/benchmark); [Aider polyglot post](https://aider.chat/2024/12/21/polyglot.html)
- **OpenHands:** each benchmark has `run_infer.sh` plus eval scripts (for example `eval_infer_remote.sh` for SWE-bench), with flags for model config, agent, eval limit and worker count. A remote runtime gives each instance an isolated container and is "specifically designed for agent evaluation purposes only". The V1 harness moved to a separate repo, `OpenHands/benchmarks`, which has `swebench-infer` and `--select` to run only listed instances — [OpenHands evaluation harness docs](https://docs.openhands.dev/openhands/usage/developers/evaluation-harness.md); [Remote runtime](https://docs.all-hands.dev/usage/runtimes/remote); [OpenHands/benchmarks](https://github.com/OpenHands/benchmarks)
- **Goose:** evals are defined in the Goose repo as a core suite of developer-workflow tasks (the "vibe check"). Search snippets also describe an `evals/harbor` directory with a `cmd.py` that supports run/list/show/task/compare/pull — [Goose benchmark blog](https://goose-docs.ai/blog/2025/03/31/goose-benchmark)
- **Cline:** Cline open-sourced evals for open-weight models, run on Harbor against Terminal-Bench (89 tasks). `cline-bench` is a benchmark built from real tasks in public repositories — [Cline open-weight evals](https://cline.bot/blog/open-sourcing-evals-for-open-weight-agents); [cline-bench initiative](https://cline.bot/blog/cline-bench-initiative)
- **OpenCode:** `sst/opencode-bench` evaluates OpenCode agents on real GitHub repositories. Each run is repeated three times on fresh clones, and judge scores are aggregated — [opencode-bench](https://github.com/sst/opencode-bench)
- **Pi:** Pi has a Harbor adapter (`pi-terminal-bench`). Pi stores sessions as tree-structured JSONL (each entry has an `id`/`parentId`) under `~/.pi/agent/sessions/`, grouped by working directory — [pi-terminal-bench](https://github.com/badlogic/pi-terminal-bench); [pi-coding-agent README](https://unpkg.com/@mariozechner/pi-coding-agent@0.73.1/README.md)
- The `@mariozechner/pi-coding-agent` npm name is reported to be deprecated in favor of a new scope — [search result summary of a later guide](https://flaviocopes.com/pi/) (unverified, so check which package `pi-terminal-bench` installs)

### Inferences
- For Calliopi, the "golden" external benchmark would be a small Terminal-Bench 2 subset run through `pi-terminal-bench`, which is comparable to other agents. The internal suite would be a Goose- or opencode-bench-style directory of the developer's own tasks with three repeats each.
- Aider's two-try metric is a cheap pattern worth copying: on the second try, feed the agent the test output, which measures recovery from feedback.

### Gaps
- I found no public information on how Codex CLI or Claude Code evaluate themselves internally. Their public "evals" presence is mainly through third-party harnesses (inspect_swe, Harbor built-in agents, promptfoo providers).
- Roo Code's eval repo was not covered by these searches.
- Goose's `evals/harbor` details come from a search snippet only.

## Practitioner methodology for small evals (error analysis, trace review, custom task sets, regression suites)

### Takeaway
The practitioner consensus (Hamel Husain and Shreya Shankar; Anthropic's agent-evals post) is to start from error analysis of real traces, write a small number of binary pass/fail checks targeted at the failure modes you observe, and prefer code-based graders. Run multiple trials per task because agents are nondeterministic. Capability tasks the agent gets good at graduate into a regression suite.

### Cited Findings
- Error analysis is "the most important activity in evals" and decides which evals to write. Annotate at least about 30 traces yourself before scaling, and spend about 30 minutes manually reviewing 20–50 outputs whenever you make a significant change — [Hamel Husain evals FAQ](https://hamel.dev/blog/posts/evals-faq/); [Error-analysis FAQ](https://hamel.dev/blog/posts/evals-faq/why-is-error-analysis-so-important-in-llm-evals-and-how-is-it-performed.html)
- Start with about 100 traces for error discovery. Code-based evals need to cover their logic, and LLM judges need 100–200 labeled examples per failure mode — [How many examples FAQ](https://hamel.dev/blog/posts/evals-faq/how-many-examples-do-i-need-for-an-eval.html)
- The FAQ explicitly prefers binary pass/fail over 1–5 Likert scores (the question appears in the index, but I did not read the full answer). A 100% pass rate suggests the eval is too easy — [Evals FAQ PDF](https://hamel.dev/blog/posts/evals-faq/evals-faq.pdf); [Simon Willison summary](https://www.simonwillison.net/2025/Jul/3/faqs-about-ai-evals)
- For agents, a trace covers every step across agents, tools and components. Developers are needed in error analysis to spot broken tool calls, missing context and infrastructure failures — [Arize on Husain](https://arize.com/blog/rise-of-the-ai-engineer-why-ai-evals-fail-before-the-evaluation-begins/)
- Anthropic's "Demystifying evals for AI agents": an eval gives an input and grades the output, and each attempt is a *trial*, with multiple trials run because outputs vary. Graders are code-based, model-based or human, and scoring can be weighted, binary (all graders must pass) or hybrid. A *transcript* is the full messages array of a run — [Anthropic engineering](https://anthropic.com/engineering/demystifying-evals-for-ai-agents)
- Secondary summaries of that post: start from a small, representative task set drawn from real failures, and define success before optimizing. Capability evals start with tasks the agent struggles with and become regression evals once it is good at them. Grade outcomes rather than brittle step or tool-call sequences. pass@k is at least one success in k trials, and pass^k is success in all k trials, which is a reliability measure — [idlirshkurti deep dive](https://idlirshkurti.github.io/tutorials/agent_evals.html); [snowan notes](https://snowan.gitbook.io/study-notes/ai/ai-resources-1/evals/anthropic-demisfy-ai-evals); [hapticpaper](https://hapticpaper.github.io/learning_gallery/news/2026-01-18--demystifying-evals-for-ai-agents)

### Inferences
- A practical loop for Calliopi:
  1. Sample 30–50 recent Pi session JSONLs and open-code the failures (for example wrong edit, tool error loop, ignored instruction, extension misfire).
  2. Group them into a handful of failure categories.
  3. Turn each category into 2–5 reproducible tasks (fixture repo snapshot + prompt + verifier script).
  4. Run each config k=3–5 times and report pass@1 (mean), pass^k, cost and turns.
  5. Move solved tasks into a regression set that runs before merging an extension change.
- Binary verifiers (tests pass, file diff matches, a grep for a forbidden pattern) match the developer's preference for deterministic checks. Reserve LLM judges for things that cannot be scripted, and calibrate them against your own labels.

### Gaps
- I could not read the full text of Hamel's FAQ or Anthropic's post, so the exact wording (for example any "20–50 tasks" figure in Anthropic's post) is unverified.
- I found no source with statistical guidance (confidence intervals, a minimum k) specific to small agent A/B tests.

## Trace/session-based offline analysis and prompt-cache measurement

### Takeaway
Pi's JSONL sessions and the Harbor-Pi wrapper's `pi-filtered.jsonl` and trajectory files are the natural substrate for offline metrics. Tool-error counts, retries, turn counts and token or cache fields can be mined with a small script. I found no dedicated off-the-shelf tool for Pi-session mining or for measuring prompt-cache prefixes.

### Cited Findings
- Pi sessions are JSONL with a tree structure (`id`/`parentId`) and are stored per working directory under `~/.pi/agent/sessions/` — [pi-coding-agent README](https://unpkg.com/@mariozechner/pi-coding-agent@0.73.1/README.md)
- `harbor-pi-sdk-agent` emits a trajectory, a step-by-step trajectory stream, `pi-filtered.jsonl` and optionally `pi-raw.jsonl` — [harbor-pi-sdk-agent](https://pypi.org/project/harbor-pi-sdk-agent/)
- Inspect's bridge routes all model calls through Inspect's provider, so the eval log captures each model call centrally — [Inspect agent bridge](https://inspect.aisi.org.uk/agent-bridge.html)
- promptfoo can assert on traces and spans (tool order, commands) — [promptfoo OpenAI Agents guide](https://www.promptfoo.dev/docs/guides/evaluate-openai-agents-python/)

### Inferences
- Minimal offline analyzer: iterate over the session JSONL and compute, per session, the turns, tool calls by name, tool results flagged as error, repeated identical tool calls (retries/loops), input/output/cache-read/cache-write tokens if Pi records provider usage per assistant message, and wall time.
- Cache hit ratio is cache_read / (cache_read + uncached input). Comparing it between configs is the most direct check of whether an extension breaks prefix stability, for example by injecting dynamic content early in the system prompt.
- Running the same analyzer over Harbor trial outputs and over real day-to-day sessions connects the "eval" and "production trace" views.

### Gaps
- Not verified: which usage fields (cacheRead/cacheWrite) Pi writes per message in its JSONL. Inspect a real session file in the repo.
- I found no published method or tool for measuring prompt-cache and prefix stability across agent configurations. This would be custom.

## Concrete minimal designs (task schema, parallel execution, repeated trials, result store)

### Takeaway
The de facto minimal schema, used by Harbor/Terminal-Bench and echoed by Aider and opencode-bench, is: per task, an instruction, an environment or fixture (Dockerfile or repo snapshot), a test/verifier script that gives a binary reward, and a `task.toml` with timeouts. A harness runs N tasks × k trials with concurrency n and writes a per-trial result directory with the trajectory and reward.

### Cited Findings
- Harbor tasks use `task.toml` (with `[agent]` settings such as `timeout_sec` and `user`) alongside instruction, environment and tests. Jobs take a dataset or a local task dir, an agent (built-in or `--agent-import-path`), a concurrency setting (`-n`/`--n-concurrent`) and repeated attempts (`-k`, unconfirmed) — [Harbor Core Concepts](https://www.harborframework.com/docs/core-concepts); [Harbor configs](https://docs.harborframework.com/jobs/configs); [harbor-index TB2 guide](https://harbor-index.org/docs/run-terminal-bench-2-0)
- opencode-bench repeats each run three times on fresh clones and aggregates the results — [opencode-bench](https://github.com/sst/opencode-bench)
- Aider runs each exercise in Docker with a tries parameter and records `pass_rate_N` per attempt in a results entry — [Aider benchmark mirror](https://git.joshthomas.dev/mirrors/aider/src/tag/v0.85.1/benchmark)
- OpenHands supports `--select` to run a chosen subset and gives each instance its own container for parallelism — [OpenHands/benchmarks](https://github.com/OpenHands/benchmarks); [Remote runtime](https://docs.all-hands.dev/usage/runtimes/remote)
- Anthropic recommends multiple trials per task and either combined or binary grading — [Anthropic engineering](https://anthropic.com/engineering/demystifying-evals-for-ai-agents)

### Inferences
Two options for Calliopi, both inferred from the patterns above:

**Option A (adopt Harbor):** write `tasks/<id>/{instruction.md, task.toml, environment/Dockerfile, tests/test.sh}`, then run `harbor run -p tasks --agent-import-path calliopi_agent:CalliopiPi --agent-kwarg config=A -n 4 -k 3` (flag names to be verified). This reuses `pi-terminal-bench` and keeps results comparable with Terminal-Bench.

**Option B (no framework, about 200 LOC of TS/bash):**
- `tasks/<id>/task.json`: `{prompt, fixture: "fixtures/<repo>@<sha>" | tarball, verify: "verify.sh", timeout_s, tags}`
- Runner: for each (config × task × trial), copy the fixture into a temp dir (or `git worktree`), set `PI_*` config or extension flags, run `timeout T pi -p "<prompt>" --session-dir <out>`, then run `verify.sh` (exit code 0 means pass)
- Parallelism through a bounded worker pool (for example `xargs -P` or `p-limit`)
- Result store: append-only `results.jsonl`, one row per trial with `{run_id, git_sha_of_calliopi, config, task, trial, pass, wall_s, turns, tool_errors, tokens_in/out/cache_read/cache_write, cost, session_path}`. Optionally import it into SQLite or DuckDB for comparison queries
- Report pass@1 mean ± spread across trials, pass^k, cost and cache ratio per config, plus a list of tasks that flipped between configs, which are the ones to review by hand in their traces

Use k≥3 trials because of nondeterminism. With roughly 20–40 tasks, only large differences will be distinguishable, so pair numeric results with manual trace review, as the error-analysis advice recommends.

### Gaps
- I found no source giving a recommended k or task count for small A/B agent comparisons with statistical justification.
- Not verified: whether `pi -p` supports a flag to choose the session output directory or emit JSON output (check Pi's CLI help).
