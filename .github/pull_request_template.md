## Why / What
<!-- 1–3줄. 관련 이슈가 있으면 링크 -->

## Type
<!-- 하나만 고른다. 모델 동작(prompt, model, tool 설명)이 다른 유형과 섞이면 PR이나 커밋을 나눈다. -->
- [ ] prompt: 모델이 보는 글을 바꾼다 (시스템 프롬프트, 역할, 계약, 리마인더, 도구 설명, 자동 진행·깨우기)
- [ ] model: 모델별 설정 (기본 모델, effort, temperature, provider 매핑)
- [ ] tool: 모델이 부를 도구를 추가하거나 스키마를 바꾼다
- [ ] feat: 사람이 쓰는 명령, 화면, 패널
- [ ] fix / perf: 버그, 리뷰 지적, 경계 조건, 성능
- [ ] refactor: 동작은 그대로
- [ ] chore / docs: 데모, CI, 설정, 문서

## Test Plan
<!-- 실행한 명령과 결과. 유형별로 아래를 더한다.
- prompt: 아래 Evidence
- model: 대상 모델, 그 모델로 돌린 smoke 결과나 provider 문서 링크, 비용·캐시 영향
- tool: 계약 테스트(입력 검증, 오류, 한도), 실제 세션에서 제때 호출된 trace 1건
- feat: 터미널 폭·멀티플렉서별 확인, 스크린샷이나 데모 녹화
- fix: 고치기 전에 실패하는 재현 테스트. perf는 전후 수치
- refactor: 기존 테스트를 고치지 않고 통과, 모델에게 가는 프롬프트·도구 목록이 그대로임
-->

## Evidence
<!-- prompt 유형만. 기준: docs/research/agent-self-improvement-evidence.md -->
- Claim / Status (measured · partial · unverified):
- 모델 2개 계열 이상, Pi 버전:
- 과제 n, 반복 k, 대조군(끈 상태나 main), 결과(모델별 전후, 토큰·턴, prefix 재작성):
- 회귀·효과 없음 / What it is NOT:
- 재현 스크립트: <!-- 없으면 숫자를 쓰지 않는다 -->

## AI
- 사용한 에이전트·모델:
- [ ] 사람이 diff를 읽고 설명할 수 있다
