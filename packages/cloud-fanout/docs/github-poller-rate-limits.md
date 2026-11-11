# GitHub 리뷰 poller: API 제한과 요청 정책

## 확인한 공식 근거

- REST 제한: https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api
- 권장 사용법: https://docs.github.com/en/rest/guides/best-practices-for-using-the-rest-api
- 잔여량 조회: https://docs.github.com/en/rest/rate-limit/rate-limit#get-rate-limit-status
- PR 상세: https://docs.github.com/en/rest/pulls/pulls#get-a-pull-request

현재 인증의 `gh api rate_limit`을 읽기 전용으로 1회 확인했다. REST core는 limit=5000, remaining=4989였으며 이는 확인 시점의 스냅샷이다. 인증 토큰이나 계정별 응답 전체는 저장하지 않는다.

## Primary 제한

- 일반 인증 사용자: 보통 시간당 5,000회. PAT, OAuth, 사용자 대신 실행되는 앱 요청 등이 사용자 예산을 공유할 수 있다. 새 토큰이 별도 5,000회 예산을 보장하지 않는다.
- 비인증: IP 기준 시간당 60회. 비공개 저장소 접근도 불가능하므로 인증 실패 시 익명 polling으로 전환하지 않는다.
- GitHub App 설치 토큰, Enterprise, Actions GITHUB_TOKEN 등은 기준이 다르다. 5,000을 상수로 가정하지 않고 응답 헤더를 따른다.
- PR REST 상세는 core를 사용한다. search와 GraphQL은 다른 resource와 한도 계산이 있으므로 혼합하지 않는다. PR 조회를 검색 API로 매번 대체하지 않는다.
- GraphQL을 써도 비용 기반 한도와 secondary 제한이 있다. 단순히 GraphQL로 바꾸면 무제한 batch가 되는 것은 아니다.

매 응답에서 `x-ratelimit-limit`, `x-ratelimit-remaining`, `x-ratelimit-reset`(Unix seconds), `x-ratelimit-resource`를 읽어 저장한다. `GET /rate_limit`은 primary를 소비하지 않지만 secondary에는 영향을 줄 수 있으므로 매 tick 호출하지 않는다.

## Secondary 제한

공식 공개 기준에는 REST/GraphQL 합산 동시 요청 100개 이하, REST 분당 900 points 등의 제한이 있다. 일반 GET/HEAD/OPTIONS는 통상 1 point지만 일부 endpoint의 비용은 비공개다. CPU 시간 등의 추가 제한도 있어 공개 숫자 이하라고 안전이 보장되지는 않는다. 기준은 변경될 수 있다.

따라서 우리 GET poller는 **직렬 큐, 동시성 1**을 기본으로 한다. 스크롤, 렌더, Pi 세션 수에 따라 요청 수가 늘어나지 않아야 한다. 낮은 요청 빈도와 jitter를 사용하고 시작 직후 전 PR을 한꺼번에 요청하지 않는다.

## Polling 예산

아래는 GitHub 보장값이 아닌 초기 구현 정책이다.

- PR 기본 재조회: 180초 + 최대 15초 jitter. 상세 진입 시 해당 PR만 재검증하며 최근 30초 내 요청은 캐시 재사용.
- 실제 요청은 공용 직렬 큐·예산·서버 제한에 따라 지연될 수 있다. 현재 구현은 변화 없음에 따른 추가 주기 증가 대신 3분 기본값과 예산 제한을 사용한다.
- 병합 확인: 해당 산출물 자동 재조회 종료.
- 병합 없이 닫힘: 재열림을 확인하도록 3분 기본 주기로 유지한다. merged와 closed_unmerged의 종료 정책을 같게 처리하지 않는다.
- 한도: 같은 GitHub 인증 범위의 자동 요청 최대 시간당 300회, burst는 최대 1회/초. 메타데이터·PR 검색 등 보조 요청도 포함한다.
- 실제 예산은 위 상한과 서버의 remaining/reset, 다른 작업을 위한 reserve 중 더 보수적인 값으로 정한다. low-watermark 아래에서는 자동 확인을 일시중지하고 재개 시각을 표시한다.
- 수동 refresh도 같은 큐와 제한을 사용한다. 클릭 연타는 병합하며 rate-limit 대기를 우회하지 않는다.
- rate limit 확인용 요청, metadata 요청, 실패 응답도 실제 요청이다. 304가 될 것이라 미리 예산에서 제외하지 않는다.

조건부 요청이 모두 200이라고 가정하면 PR 10개를 180초마다 확인할 때 약 200회/시간이다. 100개면 약 2,000회/시간이므로 이 경우 모든 PR에 180초 주기를 보장하지 않는다. 큐에서 공정하게 순환하며 300회 상한이면 PR당 평균 약 20분 주기가 된다(보조 요청 제외). UI에 마지막 확인 시각과 지연을 보여준다.

프로젝트별 단일 데몬만으로는 여러 프로젝트 사이의 예산 공유가 해결되지 않는다. host+인증 주체별 공용 큐/예산 저장소가 필요하다. 다른 머신·다른 도구까지 제어할 수는 없으므로 실제 response header를 계속 반영한다. 토큰 원문을 공용 상태 파일에 기록하지 않는다.

## 조건부 요청과 중복 제거

- PR을 `host + repository + PR number + auth scope`로 식별해 중복 제거한다. 동일 PR을 여러 agent/run이 참조해도 한 번 조회해 재사용한다.
- ETag와 이전 성공 payload를 함께 보관한다.
- 다음 조회에 `If-None-Match`를 보낸다. 적절히 인증된 조건부 요청이 304를 반환하면 primary budget에 계산되지 않는다.
- 304에서는 이전 payload를 그대로 유지하고 checkedAt만 갱신한다. 응답 body가 없다는 이유로 상태를 비우지 않는다.
- 304도 네트워크 요청이며 secondary 제한을 면제하지 않는다. 예상 304를 이유로 주기를 공격적으로 줄이지 않는다.
- 캐시는 auth scope, URL, API version, Accept 표현을 구분한다. JSON PR metadata와 diff 표현의 ETag를 섞지 않는다.
- 신규 PR 확인을 위해 branch→PR 검색이 필요하면 TTL을 두고 조회한다. 매번 repository metadata, branch 존재 확인, compare diff를 모두 실행하지 않는다.
- diff 다운로드는 리뷰를 열 때만. 배경 poller는 PR 상태 metadata만 읽는다.

## 제한 및 오류 응답

1. 403/429를 보고 즉시 재시도하지 않는다. 403에는 권한 부족도 있으므로 헤더와 오류 내용을 확인한다.
2. Retry-After가 있으면 적어도 그 기간 대기한다.
3. remaining=0이면 reset 이후까지 대기한다. 여러 대기 신호가 있으면 가장 늦은 재개 시각을 사용한다.
4. secondary 제한이며 명시적인 재시각이 없으면 최소 60초 대기 후 지수 backoff와 jitter. 반복 실패 횟수를 제한한다.
5. 이 제한은 PR 하나가 아니라 해당 인증 범위의 전체 큐에 적용한다. 다른 PR/수동 refresh로 우회하지 않는다.
6. 권한 오류 403/인증 오류 401은 rate-limit 재시도로 숨기지 않는다. 확인 불가/인증 필요 상태로 표시한다.
7. 404는 삭제, 주소 오류, 권한 문제일 수 있다. merged로 추정하지 않는다.
8. 실패 시 마지막 성공한 review state와 checkedAt을 유지하되 stale 표시와 nextCheckAt을 제공한다.

## 구현 시 검증할 항목

- ETag 200→304에서 payload 보존.
- 중복 PR을 여러 agent가 참조해도 요청 1회.
- primary remaining=0, secondary 403/429, Retry-After, reset 시각, jitter/backoff.
- 권한 403은 rate-limit과 구분.
- 다수 PR과 여러 세션에서 budget 상한 및 공정한 순환.
- 수동 refresh가 대기·중복 제거·요청 한도를 우회하지 않음.
- 404 또는 네트워크 실패 시 stale 표시, 병합 오판 없음.
- 병합 확인 후 polling 중단, closed-unmerged 재열림 정책 확인.
- 렌더·스크롤에서는 API 요청 0회.

## 구현 상태

`lib/github-review.mjs`와 `bin/review-watch.mjs`에 metadata cache, 조건부 요청, 인증 scope별 공유 예산/lease, 3분 주기, 상세 30초 TTL, 오류 시 기존 상태 보존을 구현했다. 테스트는 모의 HTTP 응답으로 수행하며 유료 Cursor 실행을 만들지 않는다. 리뷰 상태는 로컬 registry에 복사하고 UI는 그 값만 읽는다. 여러 머신 간 큐 공유와 webhook 수신은 구현하지 않는다.
