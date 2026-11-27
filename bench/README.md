# bench

Calliopi의 모델 벤치마크입니다. 같은 과제를 실행 조건(arm: 모델 × effort × 하네스 on/off)별로 반복해 돌리고, 결정적인 정답 검사(oracle)로 판정합니다. 모델별 경향, 버전 간 회귀, 과제 종류별 비용 임계점을 근거로 남기는 것이 목적입니다. 근거 기준은 `docs/research/agent-self-improvement-evidence.md`에 있습니다.

```bash
npm run bench -- bench/specs/smoke.yaml               # faux 모델로 실행기·채점·리포트 확인 (비용 없음)
npm run bench -- bench/specs/s1-coarse.yaml --dry-run # 계획된 실행 목록과 spec 검사
npm run bench -- bench/specs/s1-coarse.yaml           # 실제 모델 호출: 비용이 듭니다
npm run bench -- --report bench/.out/<spec>           # 기록된 실행으로 리포트
npm run bench:test                                    # 타입 검사와 단위 테스트
```

temperature 같은 sampling 값은 실험 축이 아닙니다. 대상 모델은 thinking이나 추론 모델이라 provider가 받지 않거나 Pi가 보내지 않습니다. 조절하는 값은 effort이고, 무작위성은 반복과 중앙값으로 다룹니다.

## 구성
- `lib/catalog.ts`: Pi가 모르는 것만 둡니다. 계열, 계보(같은 제품군의 버전들)와 버전 순서, 가설 등급입니다. 가격, context, 지원 effort는 실행 시 설치된 Pi에서 읽습니다. 카탈로그의 모든 id가 Pi에 있는지 테스트가 확인합니다.
- `specs/*.yaml`: 실행 조건을 곱하지 않고 나열합니다. 실제 모델을 쓰는 spec은 `budgetUsd`가 있어야 하고, 이번 실행이 그만큼 쓰면 새 실행을 시작하지 않습니다. effort를 목록으로 주면 effort마다 조건 하나가 됩니다. 같은 조건을 반복하려면 `label`을 붙입니다(노이즈 대조). `harness: off`는 Calliopi 확장 없이 Pi만 돌립니다. `harnessRef: <git ref>`는 그 시점의 Calliopi를 worktree로 꺼내(`npm ci` 포함, 커밋마다 한 번) 씁니다. 프롬프트나 역할을 바꾸는 PR의 전후를 같은 시간대에 비교할 때 씁니다. 모델이 받지 않는 effort는 Pi가 몰래 다른 값으로 바꾸므로 spec 검사에서 거부합니다.
- `tasks/<class>/<name>/`: `task.yaml`(프롬프트, 버전, 변경 허용 범위, oracle)과 `fixture/`. 종류는 search, small-fix, multi-file, review(종류마다 쉬운 것과 함정이 있는 것 하나씩), 그리고 faux 전용 smoke입니다. 테스트가 과제마다 "아무것도 안 하면 실패, 기준 답이면 통과"를 확인합니다. 프롬프트·fixture·oracle을 바꾸면 `version`을 올립니다.
- `run.ts`, `lib/run.ts`: 실행마다 fixture를 저장소 밖 임시 디렉터리에 복사하고(git 초기화 포함) `pi -p --model <M> --thinking <effort>`를 돌립니다. 사용자 확장·스킬·AGENTS.md는 읽지 않습니다. 결과는 `bench/.out/<spec>/runs.jsonl`에 쌓이고, 실행별 답변·세션·남은 파일은 `runs/` 아래에 남습니다.
- `lib/report.ts`: 조건 × 과제 종류별 성공률과 반복 간 최악–최고, 실행당 비용·턴·토큰의 중앙값과 범위(캐시 적중이 실행마다 0~89%로 흔들려 한 번의 비용은 대표값이 못 됩니다), 캐시 적중, 도구 오류, 병렬 호출 비율, 범위 초과, 시간 초과. 종류별 임계점(최악 반복이 목표에 닿는 조건 중 중앙값 비용이 가장 낮은 것), effort 포화점, 계보 내 버전 비교를 냅니다.

모든 기록에 Pi 버전, 하네스 커밋(`-dirty` 포함), 과제 버전이 남습니다. 같은 모델의 반복 조건 사이 차이보다 작은 차이는 노이즈로 봅니다.
