# Harness/Scaffold Effects on Coding-Agent Performance: Evaluation and Ablation Evidence

Research date: 2026-11-26. Method note: in this session WebFetch could not reach arxiv.org, blog.can.ac or lesswrong.com because those hosts are blocked by the network allowlist. All findings below come from search-result snippets and summaries of primary sources, not full-text reads. Items marked "(snippet-level)" should be checked against the full text before the final report quotes exact numbers. Items marked "(background, not re-verified)" come from prior knowledge of well-known papers. This session did not confirm them.

## Q1. What do SWE-agent, Agentless, OpenHands, Moatless, AutoCodeRover and mini-SWE-agent show about harness design vs model capability? What ablations did they run?

### Takeaway
The early systems from 2024 showed that interface design alone can move results by large relative amounts with the model held fixed. In SWE-agent's ablations, the solve rate roughly halved when the linting editor was removed. By late 2025 and 2026, however, a roughly 100-line bash-only loop (mini-SWE-agent) reached more than 70% on SWE-bench Verified with frontier models. That suggests much of the value that used to come from heavy scaffolds has moved into the models, at least for SWE-bench-style tasks.

### Cited Findings
- **SWE-agent ACI ablations** (NeurIPS 2024; SWE-bench Lite, 300 instances, GPT-4 Turbo):
  - Full ACI scored 18.0%. Removing the edit command with its linter dropped the score to 10.3%, the largest drop in the ablation. — [SWE-agent paper](https://arxiv.org/pdf/2405.15793) (snippet-level)
  - The linter rejects syntactically invalid edits, shows the agent error snippets, discards the edit and asks for a retry. — [SWE-agent paper](https://arxiv.org/pdf/2405.15793); [SWE-agent ACI docs](https://princeton-nlp.github.io/SWE-agent/background/aci)
  - Search design mattered. Iterative search scored 12.0%, *worse* than having no search tool (15.7%). Summarized search, which returns an exhaustive list of results plus guidance on refining the query, was best. The paper notes that iterative search can exhaust the cost budget or the context window. — [SWE-agent paper](https://arxiv.org/pdf/2405.15793) (snippet-level)
  - File-viewer window: a full-file viewer scored 12.7%, compared with 18.0% for a 100-line window. The docs say the viewer "works best when displaying just 100 lines in each turn". A claim that a 30-line window is "too little" appears only in secondary summaries. — [SWE-agent paper](https://arxiv.org/pdf/2405.15793); [ACI docs](https://princeton-nlp.github.io/SWE-agent/background/aci)
  - Headline result: 12.47% on full SWE-bench with GPT-4 Turbo, versus about 3.8% for the earlier non-interactive RAG baseline. — (background, not re-verified) [SWE-agent paper](https://arxiv.org/abs/2405.15793v3)
- **Agentless** (July 2024): a fixed, non-agentic pipeline that localizes and then repairs, "without letting the LLM decide future actions or operate with complex tools". It reported the highest open-source resolve rate on SWE-bench Lite at the time, at the lowest cost ($0.34 per issue). The paper's cost comparison cites about $3.34 per issue for some agent approaches. — [Agentless paper](https://arxiv.org/abs/2407.01489); [Agentless README](https://raw.githubusercontent.com/OpenAutoCoder/Agentless/main/README.md). The resolve rate was 27.33% with GPT-4o. — (background, not re-verified)
  - The authors also found that SWE-bench Lite has problems with the exact patch in the description or with misleading issue descriptions, and built a filtered subset (Lite-S). This is an early benchmark-quality confound in harness comparisons. — [Agentless paper](https://arxiv.org/abs/2407.01489)
- **AutoCodeRover**: program-structure-aware search (AST-level class and method search) plus spectrum-based fault localization. It reported about 19% (one paper version) or 22–23% (another) on SWE-bench Lite, at about $0.43 per issue on average. — [AutoCodeRover paper](https://arxiv.org/html/2404.05427v3)
- **OpenHands CodeAct 2.1** + Claude 3.5 Sonnet (new) scored 53% on SWE-bench Verified. Anthropic's minimal scaffold (prompt + bash tool + edit tool) scored 49% with the same model, about a 4-point same-model gap. An independent blog notes that the two scaffolds share the prompt, the edit tool and the bash tool schema, so the gap comes from the remaining differences. — [OpenHands blog](https://www.openhands.dev/blog/openhands-codeact-21-an-open-state-of-the-art-software-development-agent); [Anthropic SWE-bench post](https://www.anthropic.com/engineering/swe-bench-sonnet); [J. Ganhotra analysis](https://jatinganhotra.github.io/blog/swe-agents/2024/12/31/claude-3.5-sonnet.html)
- **mini-SWE-agent**: about 100 lines of Python for the agent class, with no tools other than bash (each action is a stateless subprocess). The README claims more than 74% on SWE-bench Verified; an earlier revision said more than 70%. PyPI notes that Gemini 3 Pro reaches 74%. — [mini-swe-agent GitHub](https://github.com/SWE-agent/mini-swe-agent); [PyPI](https://pypi.org/project/mini-swe-agent/1.17.4/)
  - The official **SWE-bench "Bash Only"** leaderboard runs every model through mini-SWE-agent on Verified (500 tasks). Holding the harness fixed this way isolates the model. — [SWE-bench Bash Only](https://www.swebench.com/bash-only.html)
- **Moatless Tools**: no reliable cost or resolve-rate figures were found in this session.
- A 2026 preprint (arXiv 2605.11556) states that gains from added scaffolding complexity appear to be saturating, with performance increasingly driven by the underlying model. — [Hindsight Hint Distillation, arXiv 2605.11556](https://arxiv.org/pdf/2605.11556) (snippet-level, a claim made in passing)
- "Inside the Scaffold" (arXiv 2604.03515) presents a source-code taxonomy of coding-agent architectures. It argues that comparing agents built on different models cannot isolate whether the scaffold or the model caused a behavioral difference. — [arXiv 2604.03515](https://arxiv.org/pdf/2604.03515) (snippet-level)

### Inferences
- The 2024 interface ablations (editor, search and viewer design) mattered most when models were weaker: GPT-4-era models scored 10–20% on Lite. The success of mini-SWE-agent with 2025–26 models suggests that the marginal value of specialized tools on SWE-bench Verified has shrunk. Harness effects have not gone away, though: they now show up more in cost and tokens than in accuracy (see Q3).
- Agentless, at $0.34 compared with about $3.34 for agentic systems, was an early demonstration that harness design can move cost by roughly 10x at similar accuracy.

### Gaps
- I could not read the full SWE-agent Table 3 or the Agentless ablation tables (for example, the effect of reproduction tests and of sampling or reranking) because arxiv.org was blocked.
- I found no figures for Moatless Tools.
- I found no controlled ablation from OpenHands itself, such as removing the browsing tool or condensation.

## Q2. What is the evidence on edit formats (Aider, hashline, apply_patch) and tool design (Anthropic guidance)?

### Takeaway
Edit format is one of the best-documented harness variables. Aider showed a roughly 3x change on a laziness benchmark from the edit format alone, and the hashline author reports gains as large as 6.7% to 68.3% for weak models. Independent replication suggests the effect is much smaller for current frontier models. Anthropic's guidance treats tool descriptions and interfaces as tunable through evaluations.

### Cited Findings
- **Aider unified diffs** (Dec 2023): on an 89-task Python refactoring "laziness" benchmark, GPT-4 Turbo scored about 20% with SEARCH/REPLACE blocks and 61% with unified diffs. Lazy comments (such as "# ... rest of code") appeared on 4 tasks with udiff versus 12 at baseline. GPT-4 (June) went from 26% to 59%. — [Aider: Unified diffs make GPT-4 Turbo 3X less lazy](https://aider.chat/docs/unified-diffs.html)
  - Aider's design principle is that models edit better when the format is "familiar, simple, high-level, and flexible". GPT is worse at editing code when edits are wrapped in JSON or function calls. — [Aider unified diffs](https://aider.chat/docs/unified-diffs.html)
  - The effect varies with model version. gpt-4-0125-preview scored worse with udiff than the November model. — [Aider benchmarks-0125](https://aider.chat/docs/benchmarks-0125.html); [Aider GPT-4 Turbo April 2024](https://aider.chat/2024/04/09/gpt-4-turbo.html)
  - The Aider leaderboards record the edit format for each entry (whole, diff, udiff, and so on), which acknowledges that format is part of the configuration being compared. — [Aider refactor leaderboard](https://aider.chat/docs/leaderboards/refactor.html)
- **Hashline / oh-my-pi** (Can Bölük, "The Harness Problem", Feb 12, 2026): each line is tagged with a short content hash, and edits reference those anchors. The benchmark held each model fixed and swapped only the edit tool: 16 models × 3 tools (patch, string replace, hashline). Reported results: patch was the worst format for nearly every model, hashline matched or beat replace for most, and the weakest models gained the most. Grok Code Fast 1 went from 6.7% to 68.3% edit success. — [The Harness Problem, blog.can.ac](https://blog.can.ac/2026/02/12/the-harness-problem) (snippet-level; fetch blocked); [InventiveHQ summary](https://inventivehq.com/blog/oh-my-pi-hash-anchored-editing)
  - **Pushback**: a smaller independent replication without LSP feedback, across several languages, concluded that "for current-gen models in contemporary harnesses, edit format is not the bottleneck". It suggests the LSP feedback loop may confound the original results, and the author flags the sample as small. — [nwyin, DEV: Hashline vs Replace](https://dev.to/nwyin/hashline-vs-replace-does-the-edit-format-matter-15n2)
  - Practical caveats: one hashline plugin README warns that hashline replaces the edit protocol the model was trained on, so reliability depends on the model. oh-my-pi issue #158 documents an agent loop caused by stale line IDs. A whole-harness test on DeepSeek V4 Flash had Pi ahead of OMP, 20/30 to 17/30. — [pi-hashline-edit package](https://pi.dev/packages/@d3ara1n/pi-hashline-edit?page=59); [Composio Pi vs OMP](https://composio.dev/blog/pi-vs-omp)
- **Anthropic, "Raising the bar on SWE-bench Verified"** (Oct 2024): Claude 3.5 Sonnet (new) scored 49%, against a previous SOTA of 45%. The scaffold was deliberately minimal: a prompt, a bash tool and a string-replace edit tool, with the loop running until the model stopped or hit its 200k context. Anthropic says it "put a lot of effort into the descriptions and specs for these tools". — [Anthropic SWE-bench post](https://www.anthropic.com/engineering/swe-bench-sonnet)
- **Anthropic, "Writing effective tools for agents"** (Sept 2025): recommends building evaluations of realistic multi-step tasks, optionally specifying which tools are expected to be called, and analyzing transcripts. Repeated invalid-parameter errors suggest the descriptions need fixing. It also recommends letting Claude Code optimize the tools against the eval. — [Anthropic engineering](https://anthropic.com/engineering/writing-tools-for-agents). Secondary posts claim that precise refinements to tool descriptions brought Claude Sonnet 3.5 to SOTA on SWE-bench Verified. — [DEV summary](https://dev.to/tridaai/design-tools-for-the-model-115i). I could not confirm before/after numbers in Anthropic's text.
- Diff-XYZ (arXiv 2510.12487) is a benchmark of how well models understand and generate diffs. It shows that the best diff representation varies by model and task. — [Diff-XYZ](https://arxiv.org/pdf/2510.12487) (snippet-level; title only, no results retrieved)

### Inferences
- Edit-format effects look largest for (a) weaker or smaller models and (b) formats that require exact reproduction of text (patch, search/replace). They are smallest for frontier models that were trained on a vendor's native edit tool, such as apply_patch for OpenAI models or str_replace for Claude. A fair harness comparison should give each model its native edit format, or report results per format.
- The hashline evidence comes mainly from the tool's own author. Treat it as a demonstration that the effect *can* be large, not as an estimate of its typical size.

### Gaps
- I found no public controlled study of OpenAI's apply_patch format against alternatives. OpenAI documents it as the format GPT-4.1+ and Codex models were trained on, but I did not retrieve that source in this session.
- I could not read the full hashline benchmark tables (blocked host).

## Q3. HAL and similar efforts comparing the same model across scaffolds; Terminal-Bench harness comparisons

### Takeaway
Same-model, cross-harness comparisons now exist at scale (HAL, Terminal-Bench, several 2026 preprints). They agree that harness choice changes **cost by about 3–100x**. On **accuracy**, results range from "within noise" to about 30 points depending on benchmark and model. The best-controlled 2026 coding studies find accuracy shifts of 8 points or less, often indistinguishable from run-to-run variance. The most-cited large gaps come from leaderboard snapshots, where many variables are confounded.

### Cited Findings
- **HAL (Holistic Agent Leaderboard, Princeton; ICLR 2026)**: standardized harness infrastructure that reports accuracy and cost. The paper states that the same LLM on the same benchmark under different harnesses can produce substantially different scores. It also notes that before HAL, only 2 benchmarks had ever been evaluated with the same scaffold for 4 or more models. — [HAL paper, arXiv 2510.11977](https://arxiv.org/pdf/2510.11977); [ICLR proceedings](https://proceedings.iclr.cc/paper_files/paper/2026/hash/a0928f924a344aaebbb7f6cd8d56e34c-Abstract-Conference.html); [HAL site](https://hal.cs.princeton.edu/)
  - HAL includes a SWE-bench Verified Mini track with several scaffolds. — [HAL SWE-bench Verified Mini](https://hal.cs.princeton.edu/swebench_verified_mini)
  - HAL's scale (about 21,730 rollouts across 9 models and 9 benchmarks, about $40k) and its log-analysis findings (for example, agents searching for benchmark answers online, and higher reasoning effort reducing accuracy in many runs) are recalled from the abstract. — (background, not re-verified; abstract not fetched)
- **MIT FutureTech, "Just a Wrapper? How Much Do Scaffolds Matter?"** (Gundlach, Brown, Lynch, Thompson; 2026), an analysis of HAL data: inference efficiency for a model can vary by about **100x between scaffolds**. Scaffolds explain more of the price-performance variation than models do. Scaffold effects are model-specific: the same scaffold helps some models and hurts others. The authors caution that the results are relative to HAL's baseline. — [MIT FutureTech Substack](https://mitfuturetech.substack.com/p/just-a-wrapper-how-much-do-scaffolds); [LessWrong mirror](https://www.lesswrong.com/posts/jXLi3dhSpSMd7B6z8/just-a-wrapper-how-much-do-scaffolds-matter-1)
- **"Silent Instrument Errors Reorder Agent Leaderboards"** (arXiv 2611.04399, Nov 2026): on HAL's TAU-bench Airline, the Generalist scaffold trails the benchmark-specific Tool-Calling scaffold by 13 points on database-touching tasks. When ungraded episodes are graded offline under the same rule, the pooled gap closes to a tie, so part of the apparent scaffold gap was a grading artifact. The HAL maintainers reproduced the errors and added disclosures. — [arXiv 2611.04399](https://arxiv.org/pdf/2611.04399) (snippet-level)
- **"What Does a Harness Buy? Tokens, Mostly"** (Liu & Han, Shandong Univ.; arXiv 2610.04433, Oct 2026): the same model, the same tasks and one price list across production harnesses.
  - Cost per task varies by up to 3x across harnesses.
  - The only harness effect that cleared the noise was a *loss*: OpenCode trailed by up to 9 points.
  - Swapping the harness flips as many tasks as re-running the same harness (13% in both cases).
  - The first-call preamble was 16,581 tokens for Claude Code, 7,025 for OpenCode and 829 for mini-SWE-agent, while tool-return sizes were similar.
  - The revised version (7 models, 3 harnesses) finds no harness leads consistently across models. Numbers may differ between versions.
  — [arXiv 2610.04433](https://arxiv.org/abs/2610.04433); [DEV summary](https://dev.to/gabrielanhaia/same-model-different-coding-agent-harness-scores-mostly-held-cost-moved-up-to-3x-31o1) (snippet-level)
- **"The Scaffold Effect in Coding Agents: Harness Choice as a Hidden Variable"** (arXiv 2607.22585; ICML 2026): Qwen 3.6 Plus and MiniMax M2.5 run across Goose, OpenCode and OpenHands-SDK on a 50-task Terminal-Bench Pro subset. Harness choice produced a **40x token-cost difference** and harness-specific failure patterns, but shifted pass rate by **at most 8 points**. The authors argue the unit of evaluation should be the harness–model pair. — [arXiv 2607.22585](https://arxiv.org/html/2607.22585v1); [ICML 2026 listing](https://icml.cc/virtual/2026/82739) (snippet-level)
- **"Scaffold Effects on GAIA: A Controlled Comparison"** (arXiv 2606.08529): scaffold choice alone moves GAIA accuracy by up to 28 points within a single model, according to secondary summaries of it. — [arXiv 2606.08529](https://arxiv.org/pdf/2606.08529) (snippet-level; this is not a coding benchmark)
- A preprint indexed on alphaXiv ("Coding Agents Have Converged…", arXiv 2609.17394) reports within-model scaffold ranges of up to 29.8 points on SWE-bench Verified, compared with an 8.8-point spread among the top 30 entries. — [alphaXiv 2609.17394](https://www.alphaxiv.org/abs/2609.17394.md) (snippet-level; methods not verified)
- **Epoch AI**: says the scaffold determines SWE-bench Verified performance "as much as the model's raw capabilities". Its default is a simple loop, and it also reports Claude Code and Codex runs via Inspect-SWE. Its scaffold was "significantly upgraded" in February 2026 (benchmark v2.0.0) and key models were re-evaluated, with scores rising significantly. Pre- and post-upgrade numbers are not comparable. Epoch's benchmark review rubric scores leaderboards on "scaffold fairness" (shared, mixed or model-specific scaffolds). — [Epoch SWE-bench Verified](https://epoch.ai/benchmarks/swe-bench-verified); [Epoch: What skills does SWE-bench Verified evaluate](https://epoch.ai/blog/what-skills-does-swe-bench-verified-evaluate); [Epoch benchmark review](https://epoch.ai/benchmarks/swe-bench-verified/review)
- **Terminal-Bench**:
  - The authors built **Terminus**, a deliberately neutral, minimal harness that interacts only through a tmux session. They argue that third-party agents such as Codex CLI, Goose and Claude Code "are not the most appropriate scientific instruments for model performance". — [tbench.ai Terminus](https://www.tbench.ai/terminus); [Terminal-Bench paper, arXiv 2601.11868 / ICLR 2026](https://arxiv.org/abs/2601.11868)
  - Leaderboard snapshots (secondary aggregators): Opus 4.5 scored 57.8% with Terminus 2 and 52.1% with Claude Code, and GPT-5.2 scored 62.9% with Codex CLI. Opus 4.6 scored 58.0% in Claude Code, 74.7% in Terminus-KIRA and 81.8% in ForgeCode. Terminus 2 itself improved from 62.9% to 74.4% with Opus 4.6 through community changes. — [D. Vaughan blog, Apr 2026](https://codex.danielvaughan.com/2026/04/09/harness-performance-terminal-bench/); [Snorkel TB 2.0](https://www.snorkel.ai/blog/terminal-bench-2-0/)
  - Vals.ai (June 2026) runs everything on Terminus 2. GPT 5.5 is top at 73.2%. OpenAI's own GPT-5.4 claim of 75.1% used a specialized harness, so it is not directly comparable. — [Vals.ai Terminal-Bench 2](https://www.vals.ai/benchmarks/terminal-bench-2)
  - Harbor (released with TB 2.0) is a framework for running arbitrary agent harnesses on the same tasks in containers. — [VentureBeat on TB 2.0 + Harbor](https://develop.venturebeat.com/ai/terminal-bench-2-0-launches-alongside-harbor-a-new-framework-for-testing)

### Inferences
- There is a real tension in the evidence. Leaderboard snapshots, which are not controlled, show 15–25-point same-model gaps on Terminal-Bench (for example, Claude Code vs ForgeCode or Terminus-KIRA). Controlled academic studies find accuracy gaps of 8 points or less, roughly at the run-to-run noise floor, but large cost gaps. Plausible reasons: leaderboard entries differ in timeouts, retries, reasoning effort, number of attempts and harness tuning toward the benchmark; vendor CLIs are optimized for interactive UX and safety prompts rather than autonomous benchmark runs; and the controlled studies used mid-tier open models and small task subsets.
- The consistent finding across sources is that **cost and token efficiency are the largest and most reliable harness effects**. Accuracy effects are model-specific and sometimes negative.

### Gaps
- I could not verify HAL's exact rollout counts or its per-scaffold coding results from full text.
- The Terminal-Bench same-model numbers come from secondary blogs and aggregators; I did not read the official tbench.ai leaderboard in this session.
- I could not locate "Don't Blame the Large Language Model: How Scaffolding Evolution Shapes Coding Agent Quality" (cited as an ICLR 2026 workshop paper and HF papers 2607.03691) or "The Devil Is in the Interface" (arXiv 2608.11386, title only).

## Q4. Evidence on minimal vs heavy system prompts, long instructions, and context engineering (context rot, tool count)

### Takeaway
Evidence increasingly favors **less context**. Long or extra instructions (such as AGENTS.md) tend to raise cost and often do not raise success. Performance degrades as input length grows, even on trivial tasks. Tool-selection accuracy falls as the number of tools grows. Minimal harnesses with very short preambles (mini-SWE-agent at about 800 tokens) stay competitive.

### Cited Findings
- **Gloaguen et al., "Evaluating AGENTS.md"** (arXiv 2602.11988, Feb 2026; ICLR 2026): across several coding agents and LLMs, context files *tended to reduce* task success compared with no repository context, and raised inference cost by more than 20%. Developer-written files gave a marginal gain of about 4% on average. LLM-generated files had a small negative effect. The mechanism is behavioral: the files encourage broader exploration (more testing and file traversal), and agents follow them. The authors recommend that human-written files describe only minimal requirements. — [arXiv 2602.11988](https://arxiv.org/html/2602.11988v1); [ICLR 2026](https://iclr.cc/virtual/2026/10018749)
- **Galster et al., "On the Impact of AGENTS.md Files on the Efficiency of AI Coding Agents"** (arXiv 2601.20404): measures the runtime and token effect of AGENTS.md with OpenAI Codex on real PRs. Results not retrieved. — [arXiv 2601.20404](https://arxiv.org/html/2601.20404)
- **Harness preamble size**: Claude Code sends 16.6k tokens before the task, compared with 7.0k for OpenCode and 0.8k for mini-SWE-agent, with no consistent accuracy advantage. — [arXiv 2610.04433](https://arxiv.org/abs/2610.04433). A TestDino blog benchmarks the "harness overhead" tokens of 11 coding agents. — [TestDino](https://testdino.com/blog/harness-overhead-benchmark) (title only)
- **Chroma "Context Rot"** (July 14, 2025): 18 LLMs, including GPT-4.1, Claude 4, Gemini 2.5 and Qwen3. Performance becomes increasingly unreliable as input length grows, even on trivial tasks such as repeating a word. Degradation is worse when the needle and question are semantically dissimilar and when distractors are present. The report also tests LongMemEval. Code is public. — [Chroma research](https://research.trychroma.com/context-rot); [GitHub chroma-core/context-rot](https://github.com/chroma-core/context-rot)
- **Tool-count effects**:
  - RAG-MCP (arXiv 2505.03275): baseline tool-selection accuracy falls as the number of tools grows. Retrieving tools first raised selection accuracy from 13.62% to 43.13% and more than halved prompt tokens. — [arXiv 2505.03275](https://arxiv.org/html/2505.03275v1)
  - HumanMCP (arXiv 2602.23367): accuracy fell about 10 points for all models as the list grew from 10 to 100 tools. — [arXiv 2602.23367](https://arxiv.org/pdf/2602.23367)
  - OSWorld-MCP (arXiv 2510.24563): accuracy and tool-invocation rate drop as the tool count gets large. — [arXiv 2510.24563](https://arxiv.org/pdf/2510.24563)
  - "How Many Tools Should an LLM Agent See?" (arXiv 2605.24660) offers a chance-corrected analysis and cites LongFuncEval for declining function-calling accuracy as catalogs grow or similar tools are added. — [arXiv 2605.24660](https://arxiv.org/pdf/2605.24660)
  - A practitioner experiment reports declines across 6 models starting between 25 and 50 tools (methodology unverified). — [DEV: we gave LLMs 150 tools](https://dev.to/craigtracey/we-gave-llms-150-tools-heres-what-broke-2jaj)
- **SWE-agent** found that context-window management matters: a 100-line viewer beat a full-file view (12.7% vs 18.0%), and iterative search could exhaust the context. — [SWE-agent paper](https://arxiv.org/pdf/2405.15793)
- **Anthropic's minimal 2024 scaffold** (one prompt and two tools) set SOTA at the time, which is evidence that a light harness can be competitive. — [Anthropic SWE-bench post](https://www.anthropic.com/engineering/swe-bench-sonnet)

### Inferences
- The best-supported practical rule is that every token of instruction or tool schema has a cost: in dollars, and possibly in accuracy through context rot and tool confusion. Additions should be justified by ablation, not intuition.
- Long instructions also change *behavior* (more exploration, more testing), not only accuracy. This means harness evaluations should report trajectory statistics (steps, tokens, tool calls) alongside pass rates.

### Gaps
- I found no controlled study isolating *system-prompt length* (as opposed to AGENTS.md or tool count) on SWE-bench or Terminal-Bench with the model fixed.
- I found no rigorous public ablation of subagents (on vs off) for coding benchmarks. Anthropic's multi-agent research post covers research tasks, not coding, and was not retrieved here.
- I did not retrieve controlled evidence on context compaction or condensation strategies, such as OpenHands' condenser or Claude Code's auto-compact.

## Q5. Methodological pitfalls in comparing harnesses

### Takeaway
Fair harness comparison needs fixed or reported budgets (tokens, steps, wall-clock time, attempts), cost normalization from token counts, multiple seeds, and verified grading. Without these, harness gaps of the size commonly reported (5–15 points) can come from noise, extra attempts or grader artifacts.

### Cited Findings
- **Kapoor et al., "AI Agents That Matter"** (July 2024; TMLR 2025):
  - Agent evaluations must be cost-controlled, because repeated calls raise accuracy.
  - Simple baselines, such as retrying at temperature 0 up to 5 times, matched or beat complex SOTA agents on HumanEval at much lower cost.
  - Results should be reported as accuracy-cost Pareto frontiers, with token counts reported alongside dollar costs because prices change.
  - The paper also flags inadequate holdouts (overfitting and shortcuts) and poor reproducibility.
  — [arXiv 2407.01502](https://arxiv.org/abs/2407.01502v1); [agents.cs.princeton.edu](https://agents.cs.princeton.edu/)
- **Run-to-run noise rivals harness effects**: switching harness flips 13% of tasks, the same rate as re-running one harness. — [arXiv 2610.04433](https://arxiv.org/abs/2610.04433)
- **Grader and instrument errors** can create or erase scaffold gaps. On HAL TAU-bench, a 13-point scaffold gap closed to a tie after consistent re-grading. — [arXiv 2611.04399](https://arxiv.org/pdf/2611.04399). A related paper (arXiv 2610.00651) argues that adding tasks alone does not fix leaderboard reliability. — [arXiv 2610.00651](https://arxiv.org/pdf/2610.00651) (title only)
- **Version drift in harnesses**: Epoch's February 2026 scaffold upgrade makes older and newer SWE-bench Verified numbers non-comparable. Terminus 2 rose about 11 points with the same model through community changes. — [Epoch SWE-bench Verified](https://epoch.ai/benchmarks/swe-bench-verified); [Vaughan blog](https://codex.danielvaughan.com/2026/04/09/harness-performance-terminal-bench/)
- **Vendor-specific harnesses on leaderboards**: OpenAI's GPT-5.4 Terminal-Bench figure used a specialized harness. Terminal-Bench recommends Terminus as a neutral instrument. — [Vals.ai](https://www.vals.ai/benchmarks/terminal-bench-2); [tbench.ai Terminus](https://www.tbench.ai/terminus)
- **Model-specific scaffold interactions**: the same scaffold can help one model and hurt another, so a single-model ablation does not generalize. — [MIT FutureTech](https://mitfuturetech.substack.com/p/just-a-wrapper-how-much-do-scaffolds)
- **Benchmark contamination and quality confounds**: SWE-bench Lite issues that contain the solution in the description (Agentless's Lite-S filter). — [Agentless](https://arxiv.org/abs/2407.01489)
- **Uneven coverage**: before HAL, almost no benchmarks had been run with one shared scaffold across 4 or more models. — [HAL paper](https://arxiv.org/pdf/2510.11977)
- **Confounded feedback loops in edit-format studies**: LSP diagnostics may explain part of the reported hashline gains. — [nwyin DEV replication](https://dev.to/nwyin/hashline-vs-replace-does-the-edit-format-matter-15n2)
- **Fixed preamble overhead** skews cost comparisons (Claude Code 16.6k vs mini-SWE-agent 0.8k first-call tokens). Prompt-caching assumptions also change the effective cost. — [arXiv 2610.04433](https://arxiv.org/abs/2610.04433)

### Inferences
- A defensible harness-ablation protocol, synthesized from the sources above:
  1. Fix the model, version, temperature and reasoning effort.
  2. Fix or report step limits, wall-clock limits, token limits and attempts (pass@1 vs best-of-k).
  3. Use several seeds and report confidence intervals or task-flip rates.
  4. Normalize cost from raw token counts, including cached tokens, under one price list.
  5. Change one harness component at a time: edit format, tool set, prompt, context policy, subagents.
  6. Use a shared neutral baseline harness, such as mini-SWE-agent, Terminus or Inspect.
  7. Audit grading and logs for shortcuts and instrument errors.
- Treat leaderboard same-model gaps as upper bounds that are confounded, not as measured harness effects.

### Gaps
- I found no community-standard "harness ablation" benchmark protocol. HAL and Harbor provide infrastructure, but no standard requires per-component ablations.
- I found little published work on statistical power (how many tasks or seeds are needed to detect a 3–5-point harness effect) for coding benchmarks specifically.
