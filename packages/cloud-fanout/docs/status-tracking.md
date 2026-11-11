# Floating 작업 목록을 위한 상태 추적 검토

## 근거

- Cursor 공식 OpenAPI: https://cursor.com/docs-static/cloud-agents-openapi.yaml
- Cursor Cloud Agents API 안내: https://cursor.com/docs/cloud-agent/api/overview
- 설치된 `@cursor/sdk` 1.3.1의 `dist/esm/cloud-api-client.d.ts`, `run.d.ts`
- GitHub PR 조회: https://docs.github.com/en/rest/pulls/pulls#get-a-pull-request

공식 OpenAPI를 다운로드해 AgentSummary, Run, RunGit, SSE endpoint를 확인했다. SDK 타입과 공식 REST 스펙이 일치하지 않는 부분이 있으므로 UI는 REST raw 상태를 보존한다. 새로운 유료 에이전트 실행은 하지 않았다.

## API에서 확인되는 사실

### Agent와 Run은 다르다

`AgentSummary.status`는 `ACTIVE | ARCHIVED`로 세션 수명주기다. 실행 상태는 `latestRunId`가 가리키는 Run에서 읽는다. ACTIVE를 RUNNING으로 간주하면 안 된다.

Run의 raw 상태:

| Cursor 상태 | UI 의미 | 종료 여부 |
|---|---|---|
| CREATING | 준비 중 | 진행 |
| RUNNING | 실행 중 | 진행 |
| WAITING_FOR_BACKGROUND_WORK | 백그라운드 작업 대기 | 진행 |
| FINISHED | 실행 완료 | 종료 |
| ERROR | 실행 오류 | 종료 |
| CANCELLED | 취소됨 | 종료 |
| EXPIRED | 만료됨 | 종료 |

알 수 없는 상태는 raw 값을 보존하고 종료로 추정하지 않는다. `WAITING_FOR_BACKGROUND_WORK`는 사람의 승인 대기가 아니다. Pi 승인 UI는 별도 로컬 상태로 기록해야 한다.

SDK 1.3.1의 V1Run 타입에는 WAITING_FOR_BACKGROUND_WORK가 없지만 공식 OpenAPI에는 있다. SDK의 고수준 RunStatus는 `running | finished | error | cancelled`로 더 축약돼 있다.

### REST와 SSE

- `GET /v1/agents/{id}/runs`: 실행 목록과 최신 실행 발견.
- `GET /v1/agents/{id}/runs/{runId}`: 특정 실행 상태, 결과, 시간, git 스냅샷.
- `GET /v1/agents/{id}/runs/{runId}/stream`: SSE.
- SSE `status`: `{runId, status}`. 이벤트 id가 없고 reconnect마다 replay된다.
- SSE `result`: `{runId, status, text?, durationMs?, git?}`.
- SSE에는 `assistant`, `thinking`, `tool_call`, `interaction_update`, `heartbeat`, `error`, `done`도 있다.
- `Last-Event-ID`로 재접속. 보관 기간 이후 `410 stream_expired`면 REST로 복구한다.
- `done`은 스트림 종료 신호로, 그 자체를 성공으로 해석하지 않는다.
- 429 응답의 Retry-After와 rate-limit 헤더를 존중한다. UI 프레임·스크롤마다 API를 호출하지 않는다.

### Git 메타데이터의 한계

`Run.git.branches[]`는 `repoUrl`, 선택적 `branch`, 선택적 `prUrl`이다. merged, mergedAt, reviewDecision 등의 필드는 없다.

이 스냅샷은 **per-agent**다. 같은 에이전트의 여러 Run에서 공유하므로 후속 실행마다 새 PR이라고 가정하면 안 된다. stacked agent는 여러 branch를 반환할 수 있다. 첫 항목만 확인해서 전체 작업을 병합됨으로 판정하지 않는다.

공식 문서는 pushed branch라고 설명하지만, 이번 읽기 전용 시연에서는 branch 이름이 반환돼도 GitHub branch endpoint에서 404였다. 그러므로 원격 존재 여부를 별도 확인한다. 404 하나로 병합·삭제·실패를 단정하지 않는다.

## 실행과 리뷰 상태를 분리

한 enum에 RUNNING, FINISHED, MERGED를 섞지 않는다.

```text
execution: { runId, rawStatus, updatedAt, finalized }
review: {
  state: unknown | pending | merged | closed_unmerged | acknowledged,
  branches: [{ repo, branch, prUrl, state, mergedAt, headSha }],
  checkedAt, lastError
}
```

- FINISHED는 실행 완료이며 기본적으로 검토 대기다. 성공한 코드 반영을 의미하지 않는다.
- PR이 있으면 GitHub `GET /repos/{owner}/{repo}/pulls/{number}`의 `merged`, `merged_at`, `state`, `head.sha`, `base.ref`를 확인한다.
- closed인데 merged가 false이면 병합 없이 닫힘이다.
- 여러 산출물이 있으면 각 항목의 상태를 보존하고 부분 병합을 표시한다.
- PR URL이 없으면 branch의 PR을 조회할 수 있지만, head 브랜치만으로 임의의 과거 PR과 연결하면 안 된다. 저장소·branch·commit 등의 식별 근거를 확인한다.
- PR 없이 직접 반영한 경우에는 자동 merged로 판정하지 않는다. 별도의 커밋 포함 여부 확인 또는 명시적인 사용자 처리가 필요하다.
- 읽기 전용 분석은 결과 확인 후 acknowledged(확인/보관) 처리한다. 병합됨이라고 표시하지 않는다.
- 403/404/네트워크 실패는 확인 불가다. 이전 확인값과 checkedAt을 유지하고 오래된 정보임을 표시한다.
- 새 Run이나 새 headSha가 나오면 이전 확인/병합 상태를 그대로 새 산출물에 적용하지 않는다.

## 현재 코드에서 확인된 제약

1. `lib/registry.mjs: trackable()`은 finalized agent를 제외한다.
2. `bin/tracker.mjs: watch --exit-when-done`은 전체 실행 종료 후 멈춘다.
3. 따라서 완료 후 PR 생성·병합·외부에서 시작한 후속 Run은 자동 발견하지 못한다. 로컬 followup 명령으로 재개하는 경로와 다르다.
4. `lib/poller.mjs`는 실행 종료 때 결과를 최종화하지만 GitHub PR 상태는 조회하지 않는다.
5. `lib/stream.mjs`는 status 이벤트를 출력하며, 결과 이벤트의 레지스트리 반영과 실시간 상태 이벤트 반영은 구분돼 있다.
6. 현황 리뷰는 현재 branches[0]을 사용한다. 다중 브랜치 작업에서는 산출물 선택 단계가 필요하다.
7. 기존 하단 strip을 우측 상단 비포커스 floating 목록으로 교체했다. 실행/검토/보관을 분리한다.

## 구현 방향

### 추적

GitHub의 primary/secondary 제한, 조건부 요청, 공용 예산 정책은 [GitHub poller 제한 검토](github-poller-rate-limits.md)를 따른다.

- 실행 추적(Cursor)과 산출물 리뷰 추적(GitHub)을 별도로 스케줄링한다.
- 실행 완료 시 Cursor의 빈번한 조회는 종료한다. 검토 대기 PR은 별도의 낮은 빈도 조회 또는 명시적 새로고침으로 갱신한다.
- GitHub 조회는 PR별 중복 제거, 동시성 제한, backoff, 갱신 시간 표시를 적용한다.
- 실행/백그라운드 대기는 기존 Cursor 정책을 유지한다. GitHub PR은 180초 + jitter, 상세 진입은 30초 TTL로 재검증한다. API 보장값이 아니라 구현 정책이며 rate limit에 따라 늦어질 수 있다.
- 전체 실행 종료 조건과 전체 리뷰 종료 조건을 분리한다. 리뷰 추적은 사용자 종료/보관 정책도 필요하다.
- UI는 로컬 레지스트리를 구독한다. 각 Pi 세션이 독립적으로 동일 API를 polling하지 않는다.

### Floating 목록

- fullscreen의 우측 상단에 비포커스 floating box 하나.
- 최대 4~5행, 세로 작업 목록, 박스 안에서 wheel 스크롤.
- 기본 탭은 진행. 검토 대기, 병합/보관 분류는 별도 선택.
- 행 클릭은 해당 작업과 산출물을 선택한 상세/리뷰 창으로 연결한다.
- 키보드 탐색은 명시적으로 목록에 진입했을 때만. 평소 편집창의 입력을 가로채지 않는다.
- 하단 status와 widget은 기본 숨김. regular 모드는 `/fanout inbox`를 fallback으로 유지한다.
- 승인 대기는 로컬 승인 수명주기로 표시하고 Cursor 상태에서 추측하지 않는다.
- PR 병합 확인 기능이 구현되기 전에는 병합됨 표시를 만들어내지 않는다.

## 구현 반영

우측 상단 floating 목록, 5행 스크롤, 분류별 색상, 상세 진입 시 PR 재검증, PR 없는 완료 결과의 명시적 확인/보관을 구현했다. GitHub 자동 확인은 Cursor 실행 데몬과 별도이며, PR별 캐시·ETag·공유 예산을 적용한다. `/fanout reviews off|on`으로 자동 확인을 제어한다. PR 자동 발견, PR 없는 직접 병합 감지, webhook, 다중 산출물 diff 선택은 아직 미구현이다.
