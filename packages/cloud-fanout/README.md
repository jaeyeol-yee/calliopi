# @calliopi/cloud-fanout

## 전담 세션과 선택형 현황

상태 모델과 floating 목록의 구현 기준은 [상태 추적 API 검토](docs/status-tracking.md)를 참고하세요. 실행 완료와 PR 병합은 별개의 상태입니다.

같은 프로젝트(같은 `CURSOR_FANOUT_DIR`)의 별도 **대화형 Pi 세션**에서 `/fanout attach`를 실행하면 그 세션이 팬아웃을 전담합니다. 메인 세션에서 `/fanout <목표>` 또는 `cloud_fanout_launch`로 전달한 작업은 로컬 mailbox에 저장되고, 담당 세션이 idle일 때 받아 계획·승인을 진행합니다. 승인 우회나 터미널 키 입력 주입은 하지 않습니다.

- `/fanout show`: 같은 Rex 세션의 담당 pane을 현재 pane 오른쪽으로 이동하고, 담당이 idle이면 현황 창을 엽니다. 다른 Rex 세션을 가로질러 pane을 이동하지 않습니다.
- fullscreen 화면 우측 상단에 비포커스 floating box를 표시합니다. 하단 status/widget은 표시하지 않습니다. `진행 / 검토 / 보관`을 클릭해 전환하고, 최대 5행의 목록 안에서 휠로 스크롤합니다. 행을 클릭하면 그 작업의 상세 창을 엽니다.
- `/fanout focus`: floating 목록에 키보드 포커스를 줍니다. ←→ 분류, ↑↓·PgUp/PgDn 선택, Enter 상세, Esc 편집창 복귀. 기본 단축키는 등록하지 않습니다(`Ctrl+Shift+F`는 Pi 대화 검색 키입니다).
- `/fanout inbox`: 기본 현황 overlay(24시간이 지난 보관 항목 제외). ↑↓로 작업 선택, Enter로 상세 결과, Esc로 돌아가기/닫기. 상세의 메타데이터는 행 구분선이 있는 2열 표로 표시합니다. 본문은 Markdown 원문의 `##`, `**`, 코드 펜스를 그대로 유지하고 구문 색상만 적용합니다. 목록과 상세 영역 오른쪽의 별도 세로 칸에 ANSI 강조색 `▲`/`▼`를 두며 더 스크롤할 수 있는 방향만 표시합니다. 이모지나 Nerd Font는 사용하지 않습니다. 에이전트·저장소·브랜치·PR은 OSC 8 하이퍼링크로 열 수 있습니다. Run ID는 공식 웹 URL이 없으므로 텍스트로 유지합니다. `m`으로 메타데이터 표를 접고 본문에 집중할 수 있습니다. 상세를 열 때 해당 PR을 재검증합니다. `u`로 재검증, PR 없는 완료 작업은 `a`로 명시적으로 확인/보관하며, 병합됨·취소됨 항목도 `a`로 보관 시각을 기록합니다. 새 run에는 이전 확인 표시를 적용하지 않습니다.
- `/fanout widget off|on`: floating box를 숨김/표시합니다. 폭 48칸 미만 또는 높이 18줄 미만에서는 자동 숨김이며 `/fanout inbox`로 접근할 수 있습니다.
- 현황에서 `d`: 선택한 에이전트의 GitHub 기본 브랜치 대비 원격 diff를 표시합니다. 읽기 전용 분석 등 push된 브랜치가 없는 작업은 diff가 없다는 안내가 나옵니다. ↑↓, 마우스 휠(fullscreen), PgUp/PgDn, Home/End로 스크롤합니다.
- 현황에서 `r`: 같은 diff를 `delta`로 별도 Rex pane에 엽니다(설치 필요). pager 키로 리뷰하고 `q`로 종료합니다. 저장소 checkout·수정 없이 `.cursor-fanout/reviews`에 읽기용 diff를 저장합니다. `lazygit` 브랜치 checkout 리뷰는 아직 지원하지 않습니다.
- `/fanout diff`: 로컬 HEAD 대비 staged/unstaged/미추적 파일 리뷰. 출력 제한을 넘으면 생략 안내를 표시합니다. 클라우드 작업 리뷰는 현황에서 `d`/`r`을 사용하세요.
- regular 모드에서는 floating box를 표시하지 않습니다. `/fanout inbox` 명령을 사용하세요.
- 담당이 지정되면 다른 세션에는 짧은 현황과 완료 알림만 표시하고, 전체 보고서는 담당 세션에만 전달합니다. `/fanout report`로 명시적으로 가져올 수 있습니다.
- `/fanout detach`: 담당 해제. 클라우드 작업과 트래커는 계속 실행됩니다. 담당 역할은 세션에 저장되어 reload/resume 시 복원됩니다(다른 담당이 살아 있으면 빼앗지 않음).
- 담당 Pi를 종료하면 수신은 중단됩니다. 패널 포커스를 옮기는 것과 Pi 프로세스를 종료하는 것은 다릅니다. 전담 세션은 실행 상태로 유지하세요.
- 로컬 변경/미추적 파일이 있으면 클라우드가 볼 수 없음을 실행 전에 확인합니다. 자동 push는 하지 않습니다. 이 경고는 원격 브랜치와 파일의 존재를 검증하는 완전한 사전 점검은 아닙니다.

### 보관 항목의 24시간 표시 정책

- 명시적으로 보관한 시각 `archivedAt`부터 24시간 동안은 기본 목록·보관 탭에 표시하며, 24시간이 되면 기본 목록과 건수에서 제외합니다. 레지스트리나 Cursor 원격 데이터는 삭제하지 않습니다.
- `/fanout history`: 시간 필터 없이 전체 기록을 엽니다. 오래된 항목의 결과·diff도 여기서 확인할 수 있습니다.
- `a`: 로컬 보관입니다. Cursor 원격 archive와는 별개입니다. 반복해 눌러도 같은 실행의 보관 시각을 연장하지 않습니다.
- `/fanout archive <label>`: 확인창을 거쳐 Cursor 공식 archive API를 호출하고 성공 후 보관 시각을 기록합니다. 실행 취소·영구 삭제는 하지 않습니다.
- 숨김은 확인/보관된 완료 결과, 병합됨, 취소됨 등 정리된 항목에만 적용합니다. 실행 중·미검토 PR·미해결 오류는 오래돼도 자동으로 숨기지 않습니다.
- `archivedRunId`를 함께 기록하므로 같은 에이전트의 새 실행에 이전 보관 시각을 적용하지 않습니다. 시각이 없거나 잘못된 과거 기록은 임의의 시각으로 채우지 않고 계속 표시합니다.
- 화면을 켜둔 채 24시간이 지나도 로컬 타이머로 갱신합니다. 추가 API 요청 없이 목록·건수만 바뀌며, 읽고 있던 상세 창은 갑자기 다른 항목으로 전환하지 않습니다.

### GitHub 리뷰 상태 갱신

- Cursor 실행 상태와 GitHub PR 병합 상태는 별도입니다. `FINISHED`만으로 병합됨이라고 표시하지 않습니다.
- PR이 있는 완료 작업은 별도 `bin/review-watch.mjs`가 기본 3분(+ 최대 15초 jitter)마다 확인합니다. Cursor 트래커가 실행 완료 후 종료돼도 GitHub 리뷰 확인은 계속됩니다.
- 상세를 열면 해당 PR만 재검증합니다. 최근 30초 내 요청은 재사용하고, 동시 요청은 합칩니다. 렌더·스크롤은 API를 호출하지 않습니다.
- GitHub 인증 범위별 캐시·ETag·직렬 요청 lease·시간당 300회 예산을 `~/.cache/calliopi/github`에 공유합니다. 헤더의 잔여량/갱신 시각과 Retry-After를 존중하며 약 10%의 primary 잔여량을 다른 도구에 남깁니다. 제한 시 3분 주기보다 늦어질 수 있고 마지막 확인 시각/갱신 대기를 표시합니다.
- 병합된 PR은 polling을 끝냅니다. 병합 없이 닫힌 PR은 재열림을 확인합니다. 여러 브랜치 중 일부만 병합됐으면 부분 병합으로 표시합니다. PR이 없는 브랜치의 직접 병합이나 PR 자동 발견은 아직 지원하지 않습니다.
- 실제 diff 열기는 기존 `d`/`r` 경로이며 다중 브랜치의 첫 항목을 사용합니다. 목록의 병합 판정은 전체 산출물을 확인하므로 이 제한과 구분됩니다.
- GitHub 리뷰 데몬은 Pi 종료 후에도 미병합 PR을 확인할 수 있습니다. `/fanout reviews off`로 프로젝트의 자동 확인을 중지하고 `on`으로 재개합니다. 중지 설정은 reload 후에도 유지하며, 진행 중인 요청은 마무리합니다. 상세를 열 때의 명시적 재검증은 계속 가능합니다. 토큰 원문은 캐시에 기록하지 않습니다.

mailbox는 `.cursor-fanout/sidecar`에 저장됩니다. 전달된 요청은 `.delivered`로 남습니다. 재시작 시 아직 전달하지 않은 요청은 같은 담당 세션으로 복구되며, 다른 담당에게 자동 재배정하지 않습니다. 프로세스가 메시지 주입 직후 중단되는 경우에는 중복 전달 가능성이 있습니다. 새 요청 전송은 API 호출이 아니며, 1초 간격의 로컬 mailbox 확인만 사용합니다.

이 패키지는 Cursor Cloud Agents를 N개 병렬로 생성(fan-out)합니다. 생성된 에이전트의 **REST raw status**와 **summary(`Run.result`)**·PR·토큰은 백그라운드에서 추적합니다.
핵심 트래커는 의존성이 없는 Node 코드이고 멀티플렉서를 모릅니다. pane 배치·완료 이벤트·대시보드 표시는 rex 계층(CLI·Server API·Lua)이 얇게 감쌉니다. tmux는 쓰지 않습니다.

Pi 패키지 manifest에 확장이 등록돼 있으며, CLI와 rex 레이어도 독립적으로 사용할 수 있습니다.

```text
packages/cloud-fanout/
├── bin/tracker.mjs        CLI 진입점 (launch·watch·add·follow·stream·report·…)
├── lib/
│   ├── auth.mjs           apiKey → CURSOR_API_KEY → ~/.cursor/sdk/auth.json(만료 체크)
│   ├── api.mjs            v1 REST 클라이언트 + 토큰버킷 + 429 Retry-After 전역 정지
│   ├── registry.mjs       source of truth (0600 JSON, O_EXCL 락, tmp+rename 원자 쓰기)
│   ├── launch.mjs         spec → N× POST /v1/agents (client agentId로 재진입 안전)
│   ├── poller.mjs         상태별 차등 폴링, listRuns 배치, 종료 시 result/git/usage 수집
│   ├── dashboard.mjs      cursor-cloud-dashboard.txt 롤링 프레임
│   ├── follow.mjs         에이전트별 뷰 (레지스트리만 읽음, 종료 코드 = raw status)
│   ├── stream.mjs         SSE 실시간 (Last-Event-ID 재연결, 410 → GET Run 폴링)
│   ├── report.mjs         aggregator (summary·PR·토큰 합산)
│   └── pijournal.mjs      Pi 라이프사이클 저널에서 ID만 발견 (선택)
├── rex/
│   ├── fanout.sh          rex CLI + Server API 레이어 (launch·up·add·watch·down)
│   ├── fanout.lua         rex do: detach 데몬 + pane 그리드 + child_exited 반응
│   └── actions.lua        rex.action: `rex do fanout spec=… yes=true`
├── examples/fanout.example.json
└── test/                  목 Cursor API + node:test (네트워크·과금 없음)
```

## 인증

트래커는 `CURSOR_API_KEY` → `~/.cursor/sdk/auth.json` 순서로 키를 찾습니다. 둘 다 없으면 SDK 브라우저 로그인으로 만들 수 있습니다.

```bash
npm i -D @cursor/sdk                       # 선택 의존성: login 경로에서만 lazy import
node $F/bin/tracker.mjs login              # Cursor.auth.status 확인 → 없거나 만료면 await Cursor.auth.login() (90일 키, 0600 저장)
node $F/bin/tracker.mjs whoami             # GET /v1/me — 과금 없는 인증 확인
```

`launch --yes`도 TTY에서는 같은 login을 먼저 await합니다. 데몬·pane·rex 액션처럼 비대화형인 곳에서는 브라우저를 띄우지 않고 exit 4로 끝납니다. 로그인 키는 `auth.json`에 저장되므로, env를 물려받지 못하는 pane과 rex 서버 액션에서도 그대로 동작합니다. 만료는 SDK의 `apiKeyExpiresAtMs` 필드로 확인합니다.

로그인은 인증을 해결할 뿐이고, 생성 승인과는 별개입니다. `--yes` 게이트는 그대로 유지됩니다.

## Pi 통합 (네이티브)

calliopi 루트 manifest에 `./packages/cloud-fanout/extensions`가 등록되어 있어 Pi가 자동으로 불러옵니다. 반영하려면 `/reload`를 실행합니다.

| 종류 | 이름 | 동작 |
|---|---|---|
| 명령 | **`/fanout <목표>`** | 모델이 목표를 서로 독립적인 작업으로 나눠 `cloud_fanout_launch`를 호출합니다. 계획 지침은 숨겨진 컨텍스트로 들어가므로 대화창에는 입력한 한 줄만 보입니다. 사용자가 파일을 만들 필요는 없습니다 |
| 승인 | 계획 **표** + `Launch N / Edit plan / Cancel` | 표에는 배치·에이전트 수·경로·레포·과금 안내와 `# / label / task`가 표시됩니다(한글은 표시 폭 기준으로 자릅니다). Edit plan을 누르면 작업 목록 JSON을 편집기에서 고친 뒤 표를 다시 보여 줍니다. 승인한 계획은 기록용으로 `<state>/specs/<batch>.json`에 저장됩니다 |
| 명령 | `/fanout launch <spec.json>` | 파일로 넘기는 호환 경로입니다. 같은 표 승인을 거칩니다. CLI에서는 `launch --spec -`로 stdin도 받습니다 |
| 명령 | `/fanout status` · `report` · `tree <label>` · `add <bc-id>` · `followup`/`steer <label> <text>` · `cancel <label>` · `up`(rex pane) · `widget on/off` · `stop` | |
| 도구 | `cloud_fanout_launch`, `cloud_fanout_status`, `cloud_fanout_report`, `cloud_fanout_diff`, `cloud_fanout_followup` | 모델이 호출합니다. 생성과 후속 지시는 UI 승인이 필요하고, 비대화형 모드에서는 거부합니다 |
| 화면 | 우측 상단 비포커스 floating 목록 · 메타데이터 표/Markdown 상세 · 완료 알림 | 렌더·스크롤은 레지스트리만 읽습니다. GitHub 자동/상세 갱신은 공유 예산을 사용하는 별도 경로입니다 |
| 컨텍스트 | 배치가 모두 끝나면 리포트를 `deliverAs: "nextTurn"`로 넣습니다 | 실행 중인 대화를 끊지 않고, 다음 턴에 모델이 결과를 봅니다 |

## Automation 경로 (생성)

이 계정에서는 사용자 API 키로 하는 REST 생성이 막혀 있어서(아래 한계 참조) Cursor Automations를 사용합니다.

```bash
node bin/tracker.mjs automation create --repo https://github.com/OWNER/REPO --branch main --issue-key
#   공식 CRUD(AutomationsService, Cursor Terraform provider와 같은 경로)로 웹훅 트리거 automation을 만듭니다
#   --issue-key: 웹훅 키 발급만 비공식 RPC를 1회 사용합니다(실패하면 UI에서 발급해 webhook.json에 저장)
node bin/tracker.mjs launch --spec spec.json          # webhook.json이 있으면 자동으로 --via automation
node bin/tracker.mjs launch --spec spec.json --yes
```

- 항목마다 문서화된 웹훅 POST를 1회 보냅니다(`Authorization: Bearer <sender key>`, `{fanout_key, label, task}`). 응답 `{success, backgroundComposerId}`의 에이전트 ID를 레지스트리에 바로 기록합니다.
- 이후의 상태·요약·스트림·후속 지시·steer·취소는 **공개 REST**를 씁니다.
- 결과 코드는 `Run.git.branches[]`(공개 REST)에서 레포와 브랜치를 읽은 뒤 **gh로 GitHub에서** 가져옵니다. `tracker tree <label>`로 볼 수 있습니다.
- 레포와 모델은 automation마다 고정입니다. 답변 첫머리의 `<calliopi_result>` 블록으로 fanout_key와 에이전트 ID를 대조합니다. 요약에서는 이 블록을 숨기고 일치 여부만 표시합니다.
- 웹훅에는 클라이언트 ID가 없어서, 응답을 잃으면 `post_ambiguous`로 남기고 **재전송하지 않습니다**(중복 생성 방지).
- automation 에이전트는 `/usage` 토큰이 0으로 나와 리포트 토큰 합계에서 빠집니다. 공개 `GET /v1/agents` 목록에도 나오지 않습니다(앱에서는 Agents Window의 Automations 소스 필터를 켜면 보입니다).

## 사용 (rex pane 기준)

아래는 모두 rex 터미널(`REX_SESSION`/`REX_BLOCK`이 설정된 곳)에서 실행합니다. Pi 안에서는 앞에 `!`를 붙입니다. 생성은 즉시 반환되므로 Pi 세션을 막지 않습니다. `/cursor-runtime cloud`처럼 `run.wait()`로 블로킹하지 않습니다.

```bash
F=~/agent-labs/calliopi/packages/cloud-fanout
export CURSOR_FANOUT_DIR=$PWD/.cursor-fanout        # 레지스트리·대시보드·로그 위치 (0700)

# 1) launch — --yes 없이는 계획만 출력합니다 (exit 2). 모델별로 포함 풀/선불 크레딧 중 어디서 차감되는지 표시합니다.
$F/rex/fanout.sh launch spec.json
$F/rex/fanout.sh launch spec.json --yes
#   → 트래커 pane (아래 30%), dashboard 탭(tail -F),
#     에이전트별 follow pane 그리드(session.new_split 1회, 원자적), 이벤트 반응기 pane

# 2) watch — 트래커 pane만 띄움 (현재 pane 아래, 30%, 포커스 유지)
$F/rex/fanout.sh watch
#   내부적으로:
#   rex split --split=below --ratio 30 --focus=false -- node tracker.mjs --dir … watch   (auth.json 로그인일 때)
#   또는 Lua detach 데몬 + tail -F tracker.log                                           (env 키일 때, 아래 참고)

# 3) add — 이미 존재하는 에이전트(웹·Pi·다른 머신에서 만든 것)를 추적하고 pane을 추가
$F/rex/fanout.sh add bc-xxxxxxxx-… [run-…] [label]
node $F/bin/tracker.mjs import-pi --dry-run         # Pi가 띄운 에이전트 발견 (ID만)

# 상태 / 리포트 / 정리
$F/rex/fanout.sh status                             # 네트워크 호출 없음
$F/rex/fanout.sh report                             # report.md를 새 탭으로
$F/rex/fanout.sh down                               # 우리 pane만 닫고 데몬 정지 (에이전트·레지스트리는 유지)
```

Lua만으로 실행할 수도 있습니다. detach 데몬, pane, 반응기를 한 스크립트가 처리합니다.

```bash
rex do $F/rex/fanout.lua tracker=$F/bin/tracker.mjs dir=$CURSOR_FANOUT_DIR node=$(command -v node) cwd=$PWD \
       stop_when_done=true            # 모두 종료되면 리포트 pane을 열고 rex.stop(0)
```

커스텀 액션으로도 호출할 수 있습니다(`rex do fanout …` 한 줄). 사용하려면 `~/.config/rex/init.lua`에 아래를 추가하고 `rex config reload`를 실행합니다.

```lua
CALLIOPI_FANOUT = { node = "/abs/path/node", rex = "/abs/path/rex" }   -- 서버 PATH에 없을 때
dofile(os.getenv("HOME") .. "/agent-labs/calliopi/packages/cloud-fanout/rex/actions.lua")
```

```bash
rex do fanout spec=spec.json            # 계획만 (무료, JSON 반환)
rex do fanout spec=spec.json yes=true   # detach로 생성 → 반응기 → pane
rex do fanout_status | rex do fanout_report | rex do fanout_up
# 설치 전 시험: rex do $F/rex/actions.lua --action fanout spec=spec.json
```

후속 지시와 수명주기 명령은 전부 `--yes`가 있어야 실행됩니다.

```bash
node $F/bin/tracker.mjs followup readme --prompt "테스트도 추가" --yes          # 새 run → 추적 재개
node $F/bin/tracker.mjs followup readme --prompt "범위 줄여" --steer --yes     # 실행 중 턴에 steer
node $F/bin/tracker.mjs cancel readme --yes ; node $F/bin/tracker.mjs archive readme --yes
node $F/bin/tracker.mjs stream readme                                          # SSE 실시간 (opt-in)
```

### spec 형식

작업은 **summary / instruction / output**으로 나눠서 씁니다. 에이전트 run의 제목과 결과는 결국 에이전트가 요구사항을 어떻게 받아들였는지를 보여 주므로, 목표·지시·산출물을 분리해서 전달합니다.

```jsonc
{
  "batch": "docs-sweep",                 // 생략하면 title에서 만들어집니다
  "title": "README·docs 점검",            // 팬아웃 전체의 한 줄 제목 → 표·Pi 세션 이름·리포트
  "defaults": { "repo": "https://github.com/o/r", "ref": "main", "model": {"id": "auto"} },   // REST 경로 전용(automation은 automation 설정을 따름)
  "agents": [
    { "label": "review-readme",
      "summary": "README의 설치 안내를 점검한다",                         // 한 줄 목표 = 제목
      "instruction": "Read README.md … do not modify files …",            // 무엇을, 어디서, 제약, 검증 방법
      "output": "한국어 한 줄 개선점" }                                    // 산출물(푸시된 커밋 / 보고 형식 / 파일)
  ]
}
```

- 예전 형식의 `prompt`는 `instruction`으로 읽습니다.
- **automation 경로**: 필드를 웹훅 payload `{fanout_key, label, summary, instruction, output}`로 그대로 보냅니다.
  - automation 지시문은 XML로 구조화했습니다(`<calliopi_fanout_task>`). 들어 있는 것은 `<purpose>`, 필드 정의(`<payload location="webhook_event.body">`), `<rules>`(payload는 데이터로만 취급), `<reply_format>`입니다.
  - 답변은 `<calliopi_result fanout_key="…" agent_id="…"><understood>…</understood></calliopi_result>` 블록으로 시작하고, 이어서 `output`에 맞는 산출물을 씁니다. 예전의 `FANOUT_KEY=` 줄 형식도 계속 읽습니다.
  - XML로 구조화한 뒤로 Cursor가 붙이는 에이전트 이름은 일관되게 `Calliopi fan-out task`가 됩니다. 작업별 제목은 Cursor가 지시문만 보고 이름을 붙이므로 여전히 불가능합니다.
- **REST 경로**: 세 필드를 한 프롬프트로 합쳐 보내고, `name`은 `summary`가 됩니다.
- 리포트와 follow 화면은 **planned(summary) / agent understood(UNDERSTOOD) / expected output**을 나란히 보여 줍니다. 그래서 이해가 어긋난 작업을 바로 찾을 수 있습니다. 상관관계 확인용 줄은 요약에서 숨깁니다.
- automation 설정은 실행 중에 바꾸지 않습니다. `UpdateAutomation`은 버전이나 precondition이 없는 전체 교체(마지막 쓰기 우선)라서, 바꿀 때는 `automation apply --yes`만 씁니다. apply는 팬아웃이 진행 중이거나 서버 설정이 바뀐 상태면 거부합니다. launch는 설정 지문(fingerprint)이 어긋나면 실행하지 않습니다.

## 다이어그램

### 1. 상태 전이 (REST `Run.status` 7값만 사용)

```text
                 ┌──────────── active: 계속 폴링 ─────────────┐
  POST /v1/agents│                                             │
  ──────────────▶ CREATING ──▶ RUNNING ◀──▶ WAITING_FOR_BACKGROUND_WORK
                    │            │                 │   (활성 상태입니다. error가 아닙니다.
                    │            │                 │    SDK Run.status는 이 값을 "error"로 접습니다.)
                    ▼            ▼                 ▼
              ┌───────── terminal: result/git/usage 1회 수집 후 finalized ─────────┐
              │ FINISHED (exit 0) │ ERROR (10) │ CANCELLED (11) │ EXPIRED (12)     │
              └────────────────────────────────────────────────────────────────────┘
  로컬 전용: 404 → missing (13) · 모르는 값 → 활성 취급 + 경고 (ERROR로 매핑하지 않음)
  follow-up run: 같은 agent의 새 run이 newest가 되면 finalized=false로 되돌리고 다시 추적
```

### 2. 폴링·rate limit·폴백

```text
watch loop (tick 5s)
 │
 ├─ due = trackable && now ≥ nextAt   (nextAt = 상태별 간격 × 1.5^unchanged, 상한 5분, ±10% jitter)
 │        CREATING 15s · RUNNING 30s · WAITING_FOR_BACKGROUND_WORK 120s
 │
 ├─ due ≥ 3 → GET /v1/agents?limit=100           (1회로 최대 100개의 updatedAt/latestRunId 확인)
 │             변화 없고 staleness guard(max(2×interval, 60s)) 이내 → 건너뜀
 │
 ├─ 에이전트당 GET /v1/agents/{id}/runs?limit=5  (status·git·durationMs — 실측상 result는 빠져 있음)
 │     └─ 추적 중인 run이 첫 페이지에 없을 때만 GET …/runs/{runId} (드묾)
 │
 ├─ newest가 terminal이고 미수집 → GET …/runs/{runId} 1회 (result=summary)
 │                               + GET /v1/agents/{id}/usage?runId=…   (403 feature_unavailable → 영구 skip)
 │
 ├─ 토큰버킷 (기본 15 req/min, CURSOR_FANOUT_RPM) — 토큰이 없으면 남은 due는 다음 tick으로
 ├─ 429 → Retry-After(초/HTTP-date, 없으면 2^n s) 동안 프로세스 전체 정지 → 재시도
 ├─ 5xx/네트워크 → GET은 백오프 재시도, POST는 client agentId가 있을 때만 재시도
 └─ 401 → 데몬 종료 (exit 4) · 403 → 5분 간격 · 404 → missing

stream AGENT (opt-in, 실시간)
  GET …/runs/{runId}/stream ──event: result──▶ 레지스트리 기록 → 트래커 nextAt=0 (usage 수집은 트래커가 담당)
     ├─ 끊김 / 90s 무 heartbeat → Last-Event-ID로 재연결 (최대 5회, 지수 백오프)
     ├─ 400 invalid_last_event_id → ID 없이 재연결
     └─ 410 stream_expired / stream_unavailable → GET Run 폴링 (15s, WAITING이면 60s)
```

### 3. rex 이벤트 흐름

```text
fanout.sh launch --yes                                    rex server
  │ tracker launch (POST ×N, fire-and-forget) ──▶ registry.json (0600)
  │                                                    ▲          │
  ├─ watch: rex split --split=below --ratio 30 ───────┤          │ (파일만 읽음, API 0회)
  │     └ (env 키) rex do fanout.lua daemon=lua        │          │
  │          └ rex.exec.start({node,tracker,watch},{detach=true})  │ ← 데몬은 rex do 종료 후에도 생존
  ├─ dashboard: rex run --label dashboard -- tail -F cursor-cloud-dashboard.txt
  ├─ agents: rex api describe session.new_split (스키마 확인)
  │          rex api call session.new_split @layout.json  (follow pane N개 그리드, 전부 생성 또는 전부 실패)
  │          └ 미지원 버전 → rex split 반복 (fallback)
  └─ reactor: rex do fanout.lua listen=true
                rex.on("terminal.child_exited") ◀── follow AGENT 프로세스 종료 (exit = raw status 코드)
                  │ tracker show --block <id> --json   (판정은 레지스트리 기준, exit code는 "끝났다"는 신호로만 사용)
                  ├─ set_block_label "✓ readme PR" / "✗ broken"
                  ├─ FINISHED가 아니면 session.zoom_block{zoom=true}
                  ├─ dashboard 라벨 "dashboard ✓3 ✗1 ⏳1"
                  └─ 모두 terminal → tracker report → report pane (stop_when_done이면 rex.stop(0))
                rex.on("block_closed") → tracker pane --clear (pane↔agent 매핑 정리)
```

## 레지스트리 (source of truth)

레지스트리 파일은 `$CURSOR_FANOUT_DIR/registry.json`(0600, 디렉터리 0700)입니다. 에이전트 레코드는 다음 필드를 가집니다.

- `phase`: `planned → created | create_failed`, 그리고 `imported`(add/pi-journal)
- `key`: spec 항목의 결정적 해시. 재실행 시 같은 항목을 식별합니다.
- `agentId`: POST 전에 미리 발급해 저장하는 `bc-<uuid>`
- `runId` / `status`: newest run과 그 raw status
- `runs{}`: run별 status·result·durationMs·usage·gitDelta
- `history[]`: 전이 기록(최대 50개)
- `git`: per-agent 스냅샷
- `pane`: rex block 매핑
- `poll`: nextAt·interval·unchanged

`meta.panes`에는 watch·dashboard·events·report 역할 pane이, `meta.events`에는 최근 전이가 들어갑니다.

Pi 저널(`~/.pi/agent/sessions/**/.cursor-cloud-lifecycle-*.journal`)은 `import-pi`로만 읽습니다. `bc-…`/`run-…` ID를 패턴으로 뽑아 `imported`로 등록하고, 그 밖의 내용은 복사하지 않습니다.

## 검증한 것

- `npm test`(12개 통과, automation 웹훅 경로 포함). 목 Cursor API(`test/mock-cursor.mjs`)로 아래 항목을 확인했습니다.
  - `--yes` 게이트
  - 생성 후 연결이 끊겨도 `409 agent_id_conflict` 경로로 복구하며 중복 생성이 없음
  - 부분 실패(400) 후 재실행 시 아무것도 다시 만들지 않음
  - WAITING_FOR_BACKGROUND_WORK가 ERROR로 기록되지 않음
  - 429 `Retry-After` 준수
  - usage 403 시 우아한 강등
  - SSE와 410 폴백
  - follow-up run 재추적
  - 파일과 출력에 API 키가 없음
  - 저널에서 ID만 흡수
- rex 실연동(이 세션, 목 API 사용)
  - `fanout.sh launch --yes` 실행 시 watch·dashboard·follow pane·반응기가 생성됨
  - `child_exited`(exit 0 / 10 / 11)에 따라 라벨이 바뀌고, 실패 pane이 zoom됨
  - 모두 종료되면 report pane이 열림
  - `add`는 `session.new_split` 경로로 pane을 추가함
  - `fanout.lua` 단독 실행과 `actions.lua --action fanout`이 동작함
  - `down`으로 원상 복구됨
- Pi 시운전(실API): rex pane에서 대화형 Pi로 `/fanout launch` → 승인 다이얼로그 → automation 웹훅으로 2건 생성 → 푸터·위젯·완료 알림 실시간 갱신 → `/fanout tree doc`(gh)로 push된 diff 확인 → 다음 턴에 리포트가 컨텍스트로 들어가 모델이 요약 → 트래커는 전부 끝나자 스스로 종료
- 실제 Cursor API(GET만, 과금 없음)
  - `login`으로 발급한 키(`backendUrl=api2.cursor.sh`)가 `api.cursor.com/v1`에서 동작합니다(`whoami`).
  - 응답 형태가 스펙과 일치합니다: AgentSummary·Run·usage. `/usage`는 이 계정에서 활성화돼 있습니다.
  - 기존 FINISHED 에이전트 2개를 `add` → `tick` 하자 summary·PR·토큰이 모두 수집됐고, 상태 파일에 키가 없었습니다.
  - 생성(POST) 2건(no-repo, `composer-2.5`)은 계정 잔액 문제로 `usage_limit_exceeded` 거부. 생성 성공 경로는 아직 실API로 검증하지 못했습니다.

## 한계와 미확정 사항

### 확정된 제약 (설계에 반영)

| 항목 | 내용 | 대응 |
|---|---|---|
| rate limit | Cloud Agents는 "standard rate limiting"이라고만 문서화돼 있고 수치가 없습니다. 다른 API의 기본값은 20 req/min입니다. | 기본 15 req/min 토큰버킷, 429 시 전역 정지, 차등·감쇠 간격. 에이전트당 실행 중 약 0.2–2 req/min이며, 오래 걸릴수록 줄어듭니다. |
| 배치 조회 | 여러 에이전트의 run status를 한 번에 주는 엔드포인트가 없습니다. `listRuns`는 에이전트 단위입니다. | `GET /v1/agents`(100개/회)로 변화 없는 에이전트를 걸러내고, `listRuns` 1회로 status·git을 받습니다. |
| `listRuns`에 result 없음 | **실측(2026-11, 실제 에이전트 5개)**: `listRuns` 항목에는 FINISHED여도 `result`가 없고, `getRun`에만 있습니다. 스펙 문구만으로는 알 수 없는 동작입니다. | terminal 전이 시 `getRun`을 정확히 1회 호출합니다. 실패하면 finalize를 미루고 재시도합니다. 목 서버도 같은 동작을 재현합니다. |
| 블로킹 | Pi의 `/cursor-runtime cloud`는 `run.wait()`로 세션을 막습니다. | 생성은 fire-and-forget, 추적은 별도 프로세스가 맡습니다. |
| git 귀속 | `Run.git`은 per-agent 스냅샷이라 모든 run이 같은 값을 돌려줍니다. | run에는 직전 스냅샷 대비 **delta**만 귀속(`gitDelta`)하고, 전체 스냅샷은 `git`에 따로 둡니다. |
| env 전달 | rex pane은 호출한 셸의 env를 **상속하지 않습니다**(실측). `rex do`의 `rex.exec`는 상속합니다. | env 키는 Lua detach 데몬으로 전달하고, pane 데몬은 auth.json 로그인일 때만 씁니다(`FANOUT_DAEMON=auto`). 키를 argv나 파일에 쓰지 않습니다. |
| `shell="none"` | 이 rex 빌드(api_revision 11)에서 `child_exited.exit_code`가 실패 명령에도 0이었습니다(실측). | pane은 기본 로그인 셸로 실행합니다. 판정은 항상 레지스트리에서 다시 읽습니다. |
| 커스텀 액션 | init.lua 액션은 서버 프로세스 env에서 실행되고, 30초 제한이 있으며, 서버 PATH에 rex/node가 없을 수 있습니다. | 긴 작업은 detach합니다. `CALLIOPI_FANOUT.node/rex`로 경로를 지정할 수 있습니다. 서버 env에는 키가 없으므로 auth.json이 필요합니다. |
| envVars + agentId | API는 두 필드를 함께 쓰는 것을 거부합니다. | envVars 항목은 서버가 ID를 발급합니다. 재진입 시 고유 `name`으로 `listAgents`를 검색해 복구하며, 최근 100개 범위 안에서만 보장됩니다(약한 보장). |
| 5xx on POST | 생성 여부가 모호합니다. | `planned`로 남기고, 재실행 시 같은 agentId로 다시 POST합니다. 이미 생성됐다면 409가 오고 복구됩니다. |

### 미확정 (조사로 확인하지 못함, 관측 후 조정 필요)

- **`AgentSummary.updatedAt`이 run status가 바뀔 때마다 갱신되는지**는 문서에 없습니다. 실측 표본 5개에서는 모두 `agent.updatedAt ≥ run.updatedAt`이었습니다(정합적이지만 증명은 아님). 그래서 인덱스는 "건너뛰기"에만 쓰고 staleness guard로 상한을 둡니다. 갱신되지 않는다면 완료 감지가 최대 `max(2×interval, 60s)` 늦어집니다. `--no-index`로 끌 수 있습니다.
- **비용** (`docs/cloud-agent.md#billing`, `docs/models-and-pricing.md` 확인): Cloud Agents는 "다른 에이전트 작업처럼 플랜 사용량을 모델 요율로" 소모합니다.
  - Cursor 모델(`composer-*`, `grok-*`)은 구독의 **주간 포함 풀**에서 차감됩니다. 풀을 넘기기 전에는 추가 요금이 없습니다.
  - 서드파티 모델(Claude·GPT·Gemini)은 첫 요청부터 API 정가로 **선불 크레딧**에서 차감됩니다.
  - **실측(2026-11, Ultra / X Subscription, 주간 풀 여유 있음)**: 사용자 API 키로 `POST /v1/agents`를 보내면 모델(`grok-4.7`·`composer-2.5`·`auto`), 인증 방식, 레포 지정 여부와 관계없이 `400 usage_limit_exceeded: Your prepaid balance is used up`으로 거부됐습니다. 재로그인으로 키를 새로 받아도, 추가 사용 한도를 설정해도 같았습니다.
    - 같은 계정으로 웹(cursor.com/agents)에서 띄우면 정상 생성되고, **Automation 웹훅으로 만든 에이전트도 정상 실행되며 주간 풀에서 차감**됩니다.
    - `docs/agent-sdk.md`의 "사용자 API 키는 사용자 플랜으로 과금된다"와 맞지 않아 Cursor 지원팀 문의 사안입니다. 그래서 생성 경로는 Automation 웹훅을 기본으로 씁니다(아래 "Automation 경로").
    - 같은 키여도 **이미 만들어진 에이전트에 대한 후속 지시·steer·취소·스트림은 REST로 정상 동작**합니다. 막히는 것은 생성뿐입니다.
    - 거부된 요청에서는 에이전트가 만들어지지 않고 소모도 없습니다. 하네스는 이 오류를 계정 차단으로 보고 남은 큐를 `planned`로 남깁니다.
  - **모델 기본값은 `auto`입니다.** `GET /v1/models`에서 `{"id":"default","displayName":"Auto","aliases":["auto"]}`로 나옵니다.
    - 문서상 개인 플랜의 Auto는 Cost 모드뿐이고, "어떤 모델이 응답하든 주간 풀에서 차감"됩니다. 그래서 요금 예측이 가장 쉽습니다.
    - Teams·Enterprise에서 Router가 Balance나 Intelligence 모드면 서드파티로 라우팅될 수 있고, 그 경우 선불 크레딧에서 차감됩니다.
    - spec에 모델이 없으면 하네스가 `{"id":"auto"}`를 넣습니다. `"model": null`이면 요청에서 모델을 생략하고, 서버가 사용자 → 팀 → 시스템 기본값 순으로 정합니다. 이 기본값은 API로 보이지 않습니다.
    - `launch --yes`는 생성 전에 모델 ID와 alias를 `GET /v1/models`(무료)로 검증합니다. 모르는 ID가 있으면 아무것도 만들지 않고 종료합니다.
  - 남은 풀은 API로 조회할 수 없습니다(대시보드에서만 확인). 그래서 리포트는 토큰 합계만 보여 줍니다. `/usage`는 early access라 계정에 따라 403이 납니다.
- `auth.json`의 형식은 @cursor/sdk 1.3.1의 `StoredSdkCredentials`(`apiKeyExpiresAtMs`, `backendUrl`, …)로 확인했습니다. 다만 SDK 내부 저장 형식이라 버전에 따라 바뀔 수 있습니다.
- **Pi 저널 포맷**은 공개 계약이 아닙니다. ID 패턴 매칭이라 포맷이 바뀌어도 대체로 견디지만, `runId` 짝짓기는 같은 줄에 있을 때만 됩니다.
- **SSE 보존 기간**(`X-Cursor-Stream-Retention-Seconds`)의 실제 값과 heartbeat 주기는 모릅니다. 90초 워치독은 추정값입니다.
- v1 API는 **public beta**이고, GA 전에 바뀔 수 있습니다.
- Node: 사양은 24+이지만 이 머신은 22.19입니다. 22 이상에 있는 기능(fetch, `AbortSignal.any`, `util.parseArgs`, `node:test`)만 사용했고 22.19에서 검증했습니다.

### 의도적으로 넣지 않은 것

- `DELETE /v1/agents/{id}`(영구 삭제): 되돌릴 수 없어 넣지 않았습니다. `archive`만 지원합니다.
- 실패 시 자동 재시도(새 run 생성): 유료이므로 `followup --yes`로 사람이 결정하게 했습니다.
