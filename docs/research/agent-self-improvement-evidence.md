# 하네스 자기개선(RSI): 경향과 Calliopi의 입장

2026-11 조사. 1차 출처는 [부록](#부록-출처)에 있다. 조사 노트 전체는 브랜치 `ccr-50505e62-xh1pf7`에 있다.

## 1. RSI를 하는 방식과 그 경향

| 방식 | 누가 제안하고 누가 판정하나 | 대표 | 관찰된 결과 |
|---|---|---|---|
| 근거 붙은 PR | 사람이 제안하고, eval과 사람이 판정한다 | opencode, choco-pi, superpowers, BMAD, Aider | 실제 제품에서 살아남은 방식은 거의 이것뿐이다. 부정 결과도 기록한다. |
| eval → trace 분석 → 수정 루프 | 에이전트가 trace를 읽고 제안하고, 사람이 채택한다 | Anthropic 도구 작성 가이드, SWE-agent 실패 분류 | 도구 설명과 스키마에서 효과가 컸다. 지금 반자동으로 할 수 있는 최대치다. |
| 내부 과제 세트 + 온라인 A/B | 팀이 제안하고, 실사용 지표가 판정한다 | Cursor(CursorBench, 시맨틱 검색) | 공개 벤치에서 효과가 없던 변경이 내부 세트에서는 효과가 있었다. 사용 규모가 있어야 한다. |
| 텍스트 최적화기 | 최적화기가 제안하고, 자동 채점이 판정한다 | GEPA, DSPy, skill-creator 트리거 루프 | 자동 채점할 수 있는 과제가 많을 때만 쓸 수 있다. 실용적 범위는 트리거 설명문 정도다. |
| 아카이브 기반 하네스 탐색 | 에이전트가 자기 코드를 고치고, 벤치가 판정한다 | ADAS, SICA, DGM, HGM, Meta-Harness, AHE, Live-SWE-agent | 점수는 크게 올랐고, held-out 모델로 일부 전이됐다(AHE 69.7→77.0%). 비용이 크고, 평가기를 우회한 사례가 보고됐다. 아직 연구 단계다. |
| 검증 없는 온라인 학습 루프 | 플러그인이 스스로 갱신하고, 판정자는 없다 | 다수의 "self-learning" 플러그인(예: ruflo) | 측정값을 지어내거나 철회한 수치를 계속 주입했다. 반면교사다. |

경향:
- **제안은 자동화되고 판정은 고정된다.** 연구와 제품 모두 제안 쪽(trace 분석, 후보 생성)은 에이전트에게 넘긴다. 반면 평가기와 과제 세트는 바꿀 수 없게 두고, 사람이 최종 게이트를 맡는다. 판정까지 자동화한 사례는 연구실 밖에 없다.
- **공개 리더보드에서 실사용 과제 세트로 옮겨 가고 있다.** SWE-bench Verified가 오염과 결함 테스트(감사 과제의 59.4%) 때문에 폐기됐다. 앞선 팀들은 자기 세션에서 과제를 뽑는다.
- **단일 점수에서 비용을 함께 보는 쪽으로 옮겨 가고 있다.** HAL은 정확도와 비용의 Pareto로 비교한다. 결과는 "100배 비싸고 1% 낫다" 같은 차이였다.
- **범용 튜닝에서 모델별 적합으로 옮겨 가고 있다.** 크게 측정된 효과는 대부분 모델별이었다. 추론 기록 보존 −30%, 편집 형식에 따른 실패율 최대 50%가 그 예다. 범용 스캐폴드의 가치는 줄었다. bash 하나로 된 100줄 에이전트가 SWE-bench Verified 74%를 냈다.

## 2. 비자명한 교훈

1. **성공률로는 작은 개선이 보이지 않는다.** 인프라 설정만으로 6pp가 움직인다. 쌍대 비교에서 결과가 갈리는 과제를 20%로 잡으면, 5pp 차이를 잡는 데 약 600과제가, 15pp는 약 70과제가 필요하다. 소규모 프로젝트에서 측정할 수 있는 개선은 큰 효과나 분산이 작은 지표(prefix 재작성, 캐시 적중, 토큰·턴, 실패 유형)뿐이다.
2. **일괄 지시는 경향을 옮길 뿐 정확도를 올리지 못한다.** 비공개 채점 벤치 A(익명)에서 "관대하게" 지시는 짜게 주는 경향만 줄였다. 정확도를 올린 것은 같은 과제의 실제 판정 예시였다(5개로 +6.5–8pp, 10개 근처에서 포화).
3. **공개 벤치와 제품의 병목은 다르다.** 시맨틱 검색은 SWE-bench에서 효과가 없었고 대형 저장소에서는 있었다. 제품 품질 개선이 SWE-bench를 움직이지 못했다는 보고도 있다(Augment).
4. **오래 남는 자산은 평가 장비보다 부정 결과 이력이다.** 개선을 이어 간 프로젝트의 근거는 커밋이 아니라 모델별 이력 문서(choco-pi)와 벤치 이력(Aider)에 남았다.

## 3. Calliopi의 입장

- 벤치 점수로 자동 RSI를 돌리지 않는다. 판정은 사람과 고정된 평가기가 한다.
- 자동으로 측정하는 것은 결정적 지표다. `requests.jsonl`의 system·tools 해시에서 prefix 재작성을 세고, 캐시 적중, 토큰·턴, `classifyEnd` 실패 유형을 본다.
- 모델별 특성과 부정 결과를 `docs/model-guidance-history.md`에 남긴다.
- reviewer 같은 판정 역할은 문구를 다듬지 않는다. 이 저장소에서 채택되거나 기각된 판정 예시를 few-shot으로 쌓는다.
- PR은 유형을 표시하고 유형에 맞는 근거를 낸다(`.github/pull_request_template.md`). eval이 필요한 것은 모델이 보는 것이나 하는 일을 바꾸는 "모델 동작" 유형뿐이다. 기존 PR #1–#16에서 이 유형은 기능 PR 안에 섞여 들어왔고(#11, #12, #13, #15) 근거가 남지 않았다. 그래서 섞이면 나누거나 해당 커밋을 표시한다.

## 4. 범용 하네스임을 입증하려면

경향을 따르면 "쓸 만한 범용 하네스"라는 주장에는 다음이 필요하다.

1. **하네스만 따로 재는 외부 벤치.** Terminal-Bench 2.x 부분집합을 Harbor로 돌린다(`badlogic/pi-terminal-bench` 참고). 같은 모델로 최소 기준선(mini-swe-agent, Terminus 2)과 비교해 확장 효과와 모델 효과를 분리한다.
2. **모델 2개 계열 이상.** 한 모델에서만 좋으면 범용이 아니라 모델 적합이다.
3. **비용과 함께 보고.** 정확도·토큰·달러를 Pareto로 내고, 반복 k ≥ 3에 최악·최고 범위를 붙인다. API 오류와 에이전트 실패는 따로 센다.
4. **실사용 과제 세트.** 실제 Calliopi 세션 실패에서 뽑은 과제를 쓴다. 각 과제는 오라클로 풀리고 no-op으로는 실패해야 한다. held-out을 분리해 둔다.
5. **노이즈 하한 공개.** 같은 설정을 두 번 돌려 차이를 재고, 그보다 작은 차이는 주장하지 않는다.

순서는 P0 prefix 리포트, P1 과제 세트와 노이즈 측정, P2 외부 벤치 부분집합 순이다.

## 부록: 출처

- 하네스: anomalyco/opencode PR #53166, #66076, #65683; choco-pi https://github.com/Nebu1eto/choco-pi (`docs/model-guidance-history.md`, `tools/prefix-eval`); Aider https://aider.chat/HISTORY.html; OpenHands PR #3985; cline/cline PR #12482
- 스킬·방법론: obra/superpowers 커밋 256b42f4, 40e86658; bmad-code-org/BMAD-METHOD PR #2675, #2524; anthropics/skills `skill-creator`; https://agentskills.io/skill-creation/optimizing-descriptions; ruvnet/ruflo `docs/reviews/intelligence-system-audit-2026-05-29.md`
- 엔지니어링 글: https://www.anthropic.com/research/writing-tools-for-agents, https://www.anthropic.com/research/claude-think-tool, https://www.anthropic.com/research/infrastructure-noise, https://openai.com/index/why-we-no-longer-evaluate-swe-bench-verified/, https://cursor.com/blog/semsearch, https://cursor.com/blog/codex-model-harness, https://cursor.com/blog/cursorbench, https://www.augmentcode.com/blog/1-open-source-agent-on-swe-bench-verified-by-combining-claude-3-7-and-o1
- 연구: SWE-agent https://arxiv.org/abs/2405.15793, ADAS https://arxiv.org/abs/2408.08435, SICA https://arxiv.org/abs/2504.15228, DGM https://arxiv.org/abs/2505.22954, HGM https://arxiv.org/abs/2510.21614, Live-SWE-agent https://arxiv.org/abs/2511.13646, Meta-Harness https://arxiv.org/abs/2603.28052, HAL https://arxiv.org/abs/2510.11977, GEPA https://github.com/gepa-ai/gepa
- 벤치마크: mini-swe-agent https://github.com/SWE-agent/mini-swe-agent, Terminal-Bench https://www.tbench.ai, Harbor https://github.com/harbor-framework/harbor, pi-terminal-bench https://github.com/badlogic/pi-terminal-bench, SWE-rebench https://swe-rebench.com/
- 비공개 채점 벤치 A: 대학 STEM 손글씨 답안 464건의 루브릭 일치율. 발행처 요청으로 익명 처리.
