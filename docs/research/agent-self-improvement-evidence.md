# 에이전트 하네스의 자기개선: 무엇을 근거로 받아들이나

2026-11 조사. 하네스 코드, 스킬·플러그인, 방법론 프레임워크, 연구, 공개·내부 벤치마크를 1차 출처(저장소, PR·커밋, 엔지니어링 글, 논문)로 확인했다. 출처는 [부록](#부록-출처)에 있다.

## 1. 요약

- 벤치마크나 모델 특성 분석을 근거로 하네스를 고친 사례는 있다. 하지만 소수에 몰려 있다. 근거는 대개 커밋·PR이 아니라 엔지니어링 글이나 별도 이력 문서에 남는다.
- 여러 출처에서 공통으로 통한 근거는 다섯 가지다. 같은 과제로 한 쌍대 비교, 반복 실행, 같은 시간대 대조군, 부정 결과 기록, 사람이 읽은 trace다.
- 단일 실행 점수, 재현 방법 없는 % 주장, LLM 판정이나 에이전트 자기보고만으로 내린 결정은 근거가 되지 못했다.
- 플러그인은 유형마다 필요한 근거가 다르다. 효과가 결정적인 것은 일반 테스트로 충분하다. 모델을 거치는 것은 기준선과 비교하는 eval이 있어야 한다.

## 2. 플러그인 유형별 근거

| 유형 | 예 | 효과 | 받아들일 근거 | 비용 |
|---|---|---|---|---|
| 단순 스킬(지식·절차) | SKILL.md, rules | 트리거는 휴리스틱, 내용은 정적 | frontmatter·링크·크기·스크립트·보안 검사, 트리거 평가(should 10 / near-miss 10, 각 3회, train/val 고정), `verified-at` | 낮음 |
| 결정적 훅·가드·린트 | 차단 hook, Vale 규칙 | 결정적 | 단위 테스트, 규칙마다 양성/음성 fixture, 사람 글 코퍼스에서의 오탐률 | 낮음 |
| 도구·MCP·확장 | web_fetch, MCP 서버 | 실행은 결정적, 호출 시점은 휴리스틱 | 계약 테스트, 제때 호출되는지 trace | 낮음–중간 |
| 역할·서브에이전트 | scout, reviewer | 위임은 휴리스틱, 도구 제한은 결정적 | 도구 허용·거부 테스트, 역할 없이 실패하는 기준선(RED), 아래 휴리스틱 튜닝과 같은 A/B | 중간 |
| 휴리스틱 프롬프트·행동 튜닝 | 출력 스타일, 리마인더, 모델별 프롬프트 | 휴리스틱 | 같은 시간대 대조군(끈 상태, 직전 버전), 과제 15–30 × 3–5회 쌍대 비교, held-out, 2개 모델 계열 이상, prefix 재작성 0, 토큰·턴 | 높음 |
| deslop | 정규식 린트, LLM 재작성 | 혼합 | 결정적 부분은 린트와 같음. 재작성은 블라인드 선호, 사실 보존 diff, 멱등성 | 중간 |
| 루프·오케스트레이터 | 반복 루프, goal | 제어는 결정적, 단계는 휴리스틱 | 종료·예산 상한 테스트, 끝까지 돌린 성공률과 비용 | 중간–높음 |

자동 최적화기(GEPA, DSPy 계열)는 세 조건을 모두 갖췄을 때만 비용을 정당화한다. 자동 판정할 수 있는 과제가 100개 이상이고, 롤아웃 수백 회를 감당할 예산이 있고, 최적화 대상이 텍스트 하나일 때다. 트리거 설명문 하나라면 train/test로 나누고 질의당 3회 돌리는 방식(skill-creator)이 싸다.

## 3. 엄밀성 단계

| 단계 | 내용 | 사례 |
|---|---|---|
| L0 | 사용감 | 대부분의 스킬 팩, 방법론 프레임워크, 검증 없는 학습 루프 |
| L1 | 일화·관찰 | 대부분의 모델별 프롬프트 PR |
| L2 | 단일 실행 수치 | Aider HISTORY, OpenHands #3985 |
| L3 | 쌍대 비교 + 반복 + 모델별 결과 | superpowers, BMAD #2675·#2524, compound-engineering, Anthropic think 도구·도구 작성 글, Cursor 검색·Codex 하네스 글, SWE-agent ablation, Cline #12482 |
| L4 | L3 + 신뢰구간·노이즈 측정 + 대조군 + 부정 결과·회귀 공개 | opencode Code Mode PR들, choco-pi 모델 지침 이력, Stencil 편집 형식 벤치, 비공개 채점 벤치 A(익명) |

## 4. 벤치마크가 하네스 설계에 알려 준 것

1. 도구 인터페이스가 1급 설계 대상이다. 편집 도구는 str_replace 계열로 수렴했고, 편집 형식은 모델이 학습한 형식을 따라야 한다.
2. 모델별 조정이 필요하다. 같은 하네스에서도 추론 기록 보존 여부만으로 30%가 달라졌고, 편집 형식에 따라 실패율이 50% 가까이 되기도 했다.
3. 명시적인 사고·계획 공간과 지속성 지시는 효과가 크다. 토큰 절약 지시처럼 상충하는 지시는 성능을 깎는다.
4. 샘플링과 검증은 +3–10%를 주지만 비용이 크다. 제품에서는 단일 시도를 고른 곳이 많다.
5. 공개 벤치와 제품의 병목은 다를 수 있다. 시맨틱 검색은 SWE-bench에서는 효과가 없었고 대형 저장소 내부 벤치에서는 있었다.
6. 일괄 지시는 경향만 옮기고 정확도는 올리지 못할 수 있다. 같은 과제의 판정 예시 몇 개가 일반 지시보다 효과가 컸다(익명 채점 벤치 A: 5개 예시로 +6.5–8pp, 10개 근처에서 포화).

## 5. 경계할 것

- 방법, n, 모델이 없는 % 주장. 표본 몇 개로 붙인 "100%" 배지.
- 지어낸 측정값. 철회한 수치를 훅이 계속 주입한 사례도 있었다.
- 결함과 오염이 있는 벤치. SWE-bench Verified는 감사한 미해결 과제의 59.4%에서 테스트가 결함이었고 보고가 중단됐다.
- 단일 실행에서 1–3pp 차이를 개선으로 보는 것. 인프라 설정만으로 6pp가 움직였다.
- 같은 과제 세트에서 반복해서 고르는 것(승자의 저주), 에이전트 자기보고, LLM 판정 하나만 쓰는 것.

## 6. Calliopi 적용안

**Evidence 템플릿**(PR·커밋 본문)

- Claim
- Status: measured / partial / unverified
- 모델(2개 이상)과 Pi 버전
- 과제 n, 반복 k
- 같은 시간대 대조군
- 결과: 모델별 전후, CI, 턴·토큰·비용
- 회귀와 효과 없음
- What it is NOT
- 재현 스크립트 경로. 스크립트가 없으면 숫자를 쓰지 않는다.

**모델 지침 이력**: `docs/model-guidance-history.md`에 모델별 특성(게으름, 범위 초과, 편집 형식, 도구 호출 방식, 추론 연속성)을 근거 단계·링크와 함께 기록한다. 부정 결과도 남긴다.

**채택 절차**

- S0 기계 게이트: 타입 검사, 테스트, 불변 경로를 건드리지 않았는지. 불변 경로는 평가기, 과제, 기록 계층, 역할 신뢰 규칙이다.
- S1 smoke: 과제 5–10개를 짝지어 비교한다. 새 실패나 prefix 재작성이 생기면 즉시 기각한다.
- S2 전체: 같은 과제에 k = 3–5회. 개선을 주장하려면 쌍대 검정에서 유의해야 하고, 정리성 변경은 비열등이면 된다. 동률이면 비용이 결정한다. 결과가 뒤집힌 과제는 trace를 읽고 diff의 원인 줄을 찾는다.
- S3 held-out: 한 번만 쓰고, 실패하면 기각한다.
- S4 사람 리뷰와 실사용.

**Calliopi 부품으로 실행하는 법**

- `subagent`로 구버전과 새 버전 역할을 같은 과제에 띄운다.
- 실험 하나를 goal 하나로 묶어 예산 상한을 건다.
- 지표는 `classifyEnd`, 토큰 집계, `requests.jsonl`에서 뽑는다. system·tools 해시로 prefix 재작성을 센다.
- 평가 arm에서는 `web_fetch`를 끄거나 호스트를 막는다.
- `requests.jsonl`은 3일 뒤 gc가 지우므로 실험 원본은 따로 내보낸다.

**외부 기준점**: Terminal-Bench 2.x 부분집합 10–20개를 Harbor로 돌린다(`badlogic/pi-terminal-bench` 참고). 같은 모델로 bash만 쓰는 기준선(mini-swe-agent, Terminus 2)과 비교해 확장 효과와 모델 효과를 분리한다. API 오류와 에이전트 실패는 따로 센다.

**단계 계획**

| 단계 | 내용 | 종료 조건 |
|---|---|---|
| P0 | Evidence 템플릿, `requests.jsonl` prefix 리포트 | 같은 입력 두 세션에서 재작성 0, 의도적으로 바꾼 세션에서 재작성 1 이상 |
| P1 | 실제 실패에서 뽑은 과제 20–40개, 각 과제에 오라클·no-op 검사, 비공개 held-out 5–10개 | 모든 과제에서 오라클 = 1, no-op = 0 |
| P2 | 사람이 낸 후보 1–2건(예: reviewer.md 축약)을 S0–S4로 돌림 | 판정이 재판정만으로 재현됨 |
| P3 (선택) | 제안만 하는 improver 역할 | 잘못된 채택 예산 안에서 사람이 제안할 때와 비교 |

## 7. 미해결

- 비용 대비 최소 n·k, held-out 교체 주기
- 판정 주체: assertion, reviewer 서브에이전트, 사람
- 메인 세션 prefix 측정(`requests.jsonl`에는 자식 요청만 남음)
- 화면 UI처럼 headless로 관찰할 수 없는 부분의 검증

## 부록: 출처

이전 조사 노트(스니펫 수준 근거 포함)는 브랜치 `ccr-50505e62-xh1pf7`에 남아 있다.

**하네스 PR·커밋**
- opencode: anomalyco/opencode PR #53166, #62176, #63258, #65683, #65778, #66076, #66674, #57666
- OpenHands PR #3985; openai/codex PR #2359, #4569; cline/cline PR #12482, #8028
- oh-my-pi 커밋 842da38
- choco-pi: https://github.com/Nebu1eto/choco-pi (커밋 77ca4333, 3a2c00f0, 78872c1f, 8d8cf8f; `tools/prefix-eval/README.md`, `docs/model-guidance-history.md`)
- Aider: https://aider.chat/HISTORY.html, https://aider.chat/docs/unified-diffs.html, https://aider.chat/2024/12/21/polyglot.html

**스킬·플러그인·방법론**
- obra/superpowers: 커밋 256b42f4, 40e86658, 5e03007c, PR #2548, `skills/writing-skills/SKILL.md`
- anthropics/skills: `skills/skill-creator` (`scripts/run_eval.py`, `run_loop.py`)
- EveryInc/compound-engineering-plugin: PR #2086, `.agents/skills/ce-skill-work/references/evaluate.md`, `skills/ce-noslop`
- wshobson/agents PR #842; bmad-code-org/BMAD-METHOD PR #2675, #2524
- ruvnet/ruflo `docs/reviews/intelligence-system-audit-2026-05-29.md`, 커밋 731661c8
- Agent Skills: https://agentskills.io/specification, https://agentskills.io/skill-creation/optimizing-descriptions
- Claude Code plugin eval: https://code.claude.com/docs/en/plugin-evals
- Snyk ToxicSkills: https://snyk.io/blog/toxicskills-malicious-ai-agent-skills-clawhub/
- deslop: blader/humanizer (#229, #318), tbhb/vale-ai-tells (#89), eric-tramel/slop-guard, sam-paech/slop-score, cursor/plugins `cursor-team-kit/skills/deslop`
- oh-my-openagent `docs/guide/agent-model-matching.md`; gepa-ai/gepa

**엔지니어링 글·벤치마크**
- Anthropic: https://www.anthropic.com/research/swe-bench-sonnet, https://www.anthropic.com/research/claude-think-tool, https://www.anthropic.com/research/writing-tools-for-agents, https://www.anthropic.com/research/infrastructure-noise
- OpenAI: https://developers.openai.com/cookbook/examples/gpt4-1_prompting_guide, https://openai.com/index/why-we-no-longer-evaluate-swe-bench-verified/
- Cursor: https://cursor.com/blog/semsearch, https://cursor.com/blog/codex-model-harness, https://cursor.com/blog/cursorbench
- Stencil: https://stencil.so/blog/the-harness-problem
- Factory, Warp, Augment, Refact, Trae: https://factory.com/news/terminal-bench, https://www.warp.dev/blog/swe-bench-verified, https://www.augmentcode.com/blog/1-open-source-agent-on-swe-bench-verified-by-combining-claude-3-7-and-o1, https://refact.ai/blog/2025/open-source-sota-on-swe-bench-verified-refact-ai/, https://arxiv.org/abs/2507.23370
- 연구: SWE-agent https://arxiv.org/abs/2405.15793, Agentless https://arxiv.org/abs/2407.01489, SICA https://arxiv.org/abs/2504.15228, DGM https://arxiv.org/abs/2505.22954, HGM https://arxiv.org/abs/2510.21614, ADAS https://arxiv.org/abs/2408.08435, Live-SWE-agent https://arxiv.org/abs/2511.13646, Meta-Harness https://arxiv.org/abs/2603.28052, HAL https://arxiv.org/abs/2510.11977
- 벤치마크: SWE-bench Pro https://github.com/scaleapi/SWE-bench_Pro-os, SWE-rebench https://swe-rebench.com/, Terminal-Bench https://www.tbench.ai, Harbor https://github.com/harbor-framework/harbor, pi-terminal-bench https://github.com/badlogic/pi-terminal-bench
- 비공개 채점 벤치 A: 대학 STEM 손글씨 답안 464건의 루브릭 일치율. 발행처 요청으로 익명 처리.
