# @calliopi/ui

Calliopi의 표현 계층입니다. floating terminal overlay, 표, 대화 기록 헤더처럼 **화면과 입력**만 다룹니다. 어떤 작업을 할지는 애플리케이션(`calliopi-fanout`, `calliopi-workflows`)이 정합니다.

## 대화 기록 헤더와 thinking 테두리

대화 기록에서 사용자 입력과 Pi의 각 응답(모델 턴)을 헤더로 구분하고, thinking을 테두리 상자로 묶습니다. 배경색을 쓰지 않으므로 테마와 무관하게 보입니다.

```text
────────────────────────────────────────   ← 화면 폭 전체
◉ 사용자
────────────────────────────────────────
설정 파일 버전 올려줘

────────────────────────────────────────
⛭ Pi                                       ← 모델 응답마다, 그 응답의 모든 블록보다 앞
────────────────────────────────────────
  ╭─ ∴ thinking ─────────────────────╮     ← 펼친 thinking: 들여쓰기 + 테두리
  │ 버전 필드만 바꾸면 된다…          │
  ╰──────────────────────────────────╯
  ┊ ∴ Thinking...                          ← 숨긴 thinking: 한 줄
edit config.json                           ← 도구 블록 (헤더 없음)
```

- **설정**
  - `/cl-headers full|compact|off`: `full`(선·헤더·선, 기본), `compact`(`── ◉ 사용자 ───` 한 줄), `off`. 바로 적용됩니다.
  - `/cl-headers thinking on|off`: thinking 테두리. 새로 그려지는 메시지부터 적용되고, 이전 기록은 `/reload` 후 반영됩니다.
  - 설정은 `~/.pi/agent/calliopi-ui.json`의 `turnHeaders`에 저장되며 모든 프로젝트에 적용됩니다. 같은 곳에서 `userIcon`, `userLabel`, `assistantIcon`, `assistantLabel`을 바꿀 수 있습니다.
- **아이콘**: 기본 `◉`, `⛭`, `∴`는 Unicode 이모지 속성이 없는 문자라 컬러 이모지로 바뀌지 않습니다. 말풍선 문자(`💭`, `💬`, `🗨`)는 모두 이모지라 쓰지 않습니다. 글꼴에 `⛭`이 없어 빈 네모로 보이면 `▣`나 `◈`로 바꾸세요.
- **헤더 위치**: Pi는 모델 응답마다 응답 컴포넌트를 하나씩 만들고, 그 응답의 thinking·텍스트를 담습니다. 도구 블록은 그 뒤에 별도로 붙습니다. 헤더는 이 응답 컴포넌트가 직접 그리므로 thinking보다 앞에 오고, **도구만 호출하는 응답**에서도 도구 블록 바깥 위에 나옵니다. 사용자가 직접 실행한 `!명령`은 별도 컴포넌트라 Pi 헤더가 붙지 않습니다.
- **thinking 테두리**: 클릭으로 펼치고 접는 동작은 그대로입니다. 폭이 좁으면 제목을 `∴`로 줄이고, 그래도 좁으면 테두리 없이 그립니다.
- **표시만 바꿉니다.** 저장된 메시지와 모델에 전달되는 내용은 그대로입니다.

### 구현 방식과 안전장치

확장 API로는 이 위치에 헤더를 넣을 수 없습니다. Markdown 변환 훅은 텍스트 블록마다만 호출되고, 도구만 호출하는 응답이나 숨긴 thinking에는 닿지 않습니다. 그래서 Pi가 공개 export하는 `AssistantMessageComponent`·`UserMessageComponent`의 `render`를, thinking 테두리는 `updateContent`를 감쌉니다.

- 감싼 함수는 예외가 나면 Pi의 원래 출력을 돌려줍니다. pi-tui는 render 예외를 처리되지 않은 예외로 바꿔 Pi를 종료하기 때문입니다.
- `/reload`·세션 종료 때 원래 함수로 되돌리고, 다시 불러와도 두 번 감싸지 않습니다.
- 클래스 모양이 예상과 다르면(Pi 업데이트 등) 감싸지 않습니다. 이때 헤더는 Markdown 변환 훅으로 대신 그립니다. 도구만 호출하는 응답과 thinking 앞에는 붙지 않고, thinking 테두리는 꺼집니다. `/cl-headers`가 어느 경로인지 알려줍니다.
- Pi의 내부 구조에 기대므로 Pi를 업데이트하면 `npm test --workspace @calliopi/ui`로 확인하세요. 실제 Pi 컴포넌트를 그려서 순서·폭·클릭·복구를 검증합니다.

## UI override: footer 슬롯

`lib/ui-override/footer-slot.ts`의 `FooterSlot`은 Pi footer 첫 줄(`~/repo (branch)`)의 오른쪽 빈 공간을 슬롯으로 씁니다. Pi footer는 그대로 두고, 그 자리에 한 줄짜리 non-capturing overlay를 그립니다. 확장은 `slot.set(key, text)`로 조각을 채우거나 지웁니다. 여러 조각은 key 순서로 두 칸 띄워 잇습니다.

```text
~/calliopi (feat/x)                         onto jaeyeol-yee/calliopi#4 open   ← 슬롯
↑52 R4.2k W2.1k 1.7%/128k (auto)                          (faux) demo • medium
```

- **위치**: TUI 트리에서 Pi의 footer 컴포넌트를 찾아 매 프레임 터미널 폭으로 그려 보고, footer 줄 수(2줄, 상태 문구가 있으면 3줄)에 맞춰 첫 줄로 옮깁니다. 첫 줄과 슬롯 사이에 2칸이 남지 않으면 숨깁니다.
- **overlay 옵션 갱신**: Pi는 넘겨받은 overlay 옵션 객체를 저장해 두고 매 프레임 다시 읽습니다. 슬롯은 이 객체의 `width`(조각을 바꿀 때)와 `offsetY`(그릴 때)를 바꿔 크기와 위치를 맞춥니다. overlay는 자기 폭만큼 아래 내용을 덮으므로 폭은 텍스트 폭과 같아야 합니다.
- **footer가 없을 때**: 다른 확장이 footer를 교체하면 Pi footer를 찾지 못하므로 슬롯을 숨깁니다(재탐색은 초당 한 번).
- Pi의 내부 구조에 기대므로 Pi를 업데이트하면 `test/footer-slot.test.ts`로 확인하세요. pi-tui의 실제 overlay 합성기로 위치를 검증합니다.

## 브랜치 상태 (`/cl-branch`)

현재 브랜치가 PR에 들어 있으면 footer 슬롯에 `onto owner/repo#N 상태`를 표시합니다. PR이 없으면 아무것도 표시하지 않습니다.

```text
~/calliopi (feat/x)                              onto them/calliopi#12 open +1 ↑2
```

- **조회**: `@calliopi/core/pr-lookup`. 커밋으로 모든 GitHub remote와 fork의 부모 저장소에서 찾으므로, fork에서 upstream으로 올린 PR도 upstream 번호로 나옵니다. PR이 여러 개면 열린 것을 먼저 보이고 `+N`을 붙입니다. `↑N`은 push하지 않은 커밋 수입니다.
- **링크**: `owner/repo#N`은 PR 링크(OSC 8)입니다. 지원하는 터미널에서 클릭하면 열립니다.
- **상태 색**: open `success`, draft `muted`, merged `accent`, closed `error`.
- **갱신**: 시작할 때, `HEAD`·브랜치·push한 커밋이 바뀔 때(5초마다 로컬에서 확인), 에이전트 실행이 끝날 때, PR이 open·draft인 동안 `pollSeconds`(기본 60초)마다. merged·closed가 되면 주기 조회를 멈춥니다. 오프라인이거나 `gh`에 로그인하지 않았으면 마지막 값을 유지합니다.
- **명령**: `/cl-branch`는 PR 전체 목록(링크 포함), `/cl-branch refresh`는 즉시 다시 조회, `/cl-branch on|off`는 footer 표시를 켜고 끕니다.
- **설정**: `~/.pi/agent/calliopi-ui.json`의 `branchStatus`(`enabled`, `pollSeconds`). fullscreen TUI에서만 표시합니다(`tuiMode: regular`에서는 꺼짐).
- **요구 사항**: `git`, 로그인한 `gh`. GitHub(github.com) remote만 봅니다.

## 구독 사용량 (`/cl-usage`)

Claude, Codex, Cursor의 구독 사용량을 overlay 패널에 gauge로 보여 줍니다. 조회는 `@calliopi/core/usage`의 provider별 strategy가 합니다.

```text
╭─ 사용량 ───────────────────────────────────────────────────────────────────────────────╮
│ ╭─ Claude · Max 20x ───────────────────────────────────────────────────── Pi 로그인 ─╮ │
│ │ 주간         █░░░░░░░░░│░░░░░░░░░░░░░░░             4%  ↻ 4일 17시간 · 11/30 11:00 │ │
│ │ 주간 Fable   ░░░░░░░░░░│░░░░░░░░░░░░░░░             0%  ↻ 4일 17시간 · 11/30 10:59 │ │
│ ╰────────────────────────────────────────────────────────────────────────────────────╯ │
│ ╭─ Cursor · Ultra (통합) ──────────────────────────────────────────────── Cursor 앱 ─╮ │
│ │ 전체         █│░░░░░░░░░░░░░░░░░░░░░░░░             2%  ↻ 6일 21시간 · 12/2 15:18 │ │
│ │ └ Grok Bot   █│░░░░░░░░░░░░░░░░░░░░░░░░           1.4%  ↻ 6일 21시간 · 12/2 15:18 │ │
│ │ 추가 사용    ███░░░░░░░░░░░░░░░│░░░░░░   $0.43 / $5.00  ↻ 5일 15시간 · 12/1 09:00 │ │
│ ╰────────────────────────────────────────────────────────────────────────────────────╯ │
╰─ 17:41:43 기준  r 새로고침 · Esc 닫기 ──────────────────────────────────────────────────╯
```

- **gauge** (`lib/gauge.ts`): provider마다 박스 하나(윗변에 이름·요금제, 오른쪽에 인증 정보 출처). 막대 열은 박스끼리 맞춥니다. 퍼센트는 10% 미만이면 소수 한 자리(1.4%). 채움은 사용 비율, 색은 70% 미만 `success`, 90% 미만 `warning`, 그 이상 `error`. `│`는 **고른 속도 표시**로, 창이 지난 만큼의 위치입니다. 채움이 이 표시를 넘으면 리필보다 빨리 쓰고 있다는 뜻입니다.
- **리셋**: `↻ 남은 시간 · 리셋 시각(로컬)`. 폭이 좁으면 시각, 그다음 열 전체를 빼서 막대가 8칸 아래로 줄지 않게 합니다.
- **명령**: `/cl-usage`(설정한 provider 전부), `/cl-usage claude cursor`(골라서). 패널에서 `r` 새로고침, `Esc`·`q` 닫기. 열려 있는 동안 남은 시간은 1분마다 다시 그립니다.
- **설정**: `~/.pi/agent/calliopi-ui.json`의 `usage.providers`(기본 `["claude", "codex", "cursor"]`).
- **인증 정보**: 이 컴퓨터에 이미 있는 로그인을 읽기만 합니다. 자세한 순서는 [core README](../core/README.md#구독-사용량). macOS에서 Pi에 Anthropic 로그인이 없으면 Claude Code의 Keychain 항목을 읽으며, 이때 macOS가 접근 허용을 한 번 물을 수 있습니다. Cursor는 `sqlite3`가 필요합니다.

## 구조

화면과 입력 부품만 둡니다. 명령(`/cl-edit`, `/cl-log`)은 `calliopi-workflows`가 이 부품으로 만듭니다. `lib`은 `.mjs`를 쓰지 않습니다. Pi의 `/reload`가 Node ESM 캐시에 남아 있는 `.mjs`를 다시 읽지 않기 때문입니다.

```text
extensions/turn-headers.ts  대화 기록 헤더·thinking 테두리 설치/복구 · /cl-headers
extensions/branch-status.ts footer의 PR 상태 표시·갱신 · /cl-branch
lib/branch-status.ts        `onto owner/repo#N 상태` 표기, 조회 주기
extensions/usage.ts         구독 사용량 overlay · /cl-usage
lib/gauge.ts                사용량 gauge (막대·고른 속도 표시·리셋)
lib/usage-panel.ts          /cl-usage 패널 테두리, 인자 해석
lib/turn-headers.ts         헤더 줄, render 감싸기, Markdown 대체 경로
lib/ui-override/footer-slot.ts  footer 첫 줄 오른쪽 슬롯 (overlay)
lib/thinking-frame.ts       thinking 테두리 컴포넌트, updateContent 감싸기
lib/table.ts                키/값 표                                  export ./table
lib/overlay-session.ts      공용 overlay 수명·키 입력 점유·사전 확인   export ./overlay-session
lib/terminal-overlay.ts     pane(node-pty ↔ @xterm/headless) ↔ Pi 렌더러, 단일/분할 배치   export ./terminal-overlay
lib/terminal-input.ts       외부 Kitty 키 입력 → 내부 xterm 키 입력   export ./terminal-input
```

자식 프로세스의 ANSI 출력은 headless 터미널이 해석하고 Pi에는 화면 셀과 SGR 스타일만 전달합니다. 자식의 커서 이동·alternate screen·OSC clipboard 명령을 실제 Pi 터미널로 직접 쓰지 않습니다.

`node-pty`는 네이티브 의존성입니다. 지원 플랫폼의 prebuilt 또는 로컬 빌드 환경이 필요할 수 있습니다. `node-pty@1.1.0`의 Unix prebuilt `spawn-helper` 실행 권한 누락은 이 패키지의 `postinstall`에서 보정합니다. `--ignore-scripts`로 설치했다면 `npm run postinstall -w @calliopi/ui`를 실행하세요.

## 검증

```bash
npm test -w @calliopi/ui
```

키 프로토콜 변환, resize·alternate screen, PTY 정리, 분할 배치, 대화 헤더·thinking 테두리를 실제 Pi 컴포넌트로 검증합니다. floating terminal 위의 실제 fzf/Vim 흐름은 `calliopi-workflows` 테스트와 smoke test가 다룹니다.
