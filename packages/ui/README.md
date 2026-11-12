# @calliopi/ui

## 파일 picker + Vim

Pi 안의 floating terminal에서 파일 하나를 선택하고 편집합니다. Rex나 외부 터미널 창을 사용하지 않습니다.

```text
/calliopi-edit → fzf → Enter → Vim → :wq 또는 :q → Pi로 복귀
```

루트에서 `npm install` 후 Pi에서 `/reload`합니다. 시스템 `PATH`에 `rg`, `fzf`, `vim`이 필요하고 `bat`은 선택 사항입니다. macOS/Linux의 대화형 Pi를 지원합니다. 최소 크기는 40칸 × 12줄이며 fullscreen·regular 모드 모두 사용할 수 있습니다.

- 현재 Pi 작업 디렉터리에서 `rg --files`로 검색합니다. ignored·hidden 파일은 기본 제외합니다.
- fzf에서 `Esc` 또는 `Ctrl+C`는 선택 취소입니다. `Enter`로 파일 하나를 엽니다.
- Vim에서 `:wq`는 저장 후 종료, `:q`는 종료, `:q!`는 저장하지 않고 종료입니다. `Esc`는 Vim의 모드 전환이며 창을 닫지 않습니다.
- fzf/Vim이 열려 있는 동안 키 입력은 Pi 대신 해당 프로그램에 전달합니다. 창 크기 변경은 PTY에도 반영합니다. v1은 키보드 전용이며 마우스 입력은 전달하지 않습니다.
- 한글 등 IME 입력은 조합이 끝난 글자만 전달합니다. 자모 키 이벤트를 포함해 해석하지 못한 Kitty 키 이벤트는 내부 프로그램에 넘기지 않습니다.
- 입력 문제 진단: `/calliopi-edit --debug-input`은 받은 키 시퀀스와 변환 결과를 `$TMPDIR/calliopi-input-*.jsonl`(0600)에 기록합니다. **입력한 내용이 그대로 남으므로** 확인 후 삭제하세요.
- 편집기는 시스템 `vim`이며 사용자 Vim 설정은 그대로 읽습니다. `$EDITOR`/`$VISUAL` 선택과 여러 파일 추적은 아직 지원하지 않습니다.

### Pi로 변경 사항 전달

선택한 파일을 **Vim 실행 직전과 종료 직후** 비교합니다. `git diff HEAD`가 아니므로 기존 미커밋 변경과 이번 편집을 구분할 수 있고, untracked 파일도 지원합니다.

- 변경이 있으면 경로와 diff를 `calliopi-file-edit` 메시지로 **다음 사용자 턴에 전달**합니다. 자동으로 모델을 실행하거나 리뷰를 요청하지 않습니다.
- 변경이 없거나 선택을 취소하면 메시지를 추가하지 않습니다.
- 선택한 파일만 추적합니다. Vim에서 연 다른 버퍼는 추적하지 않으며, 편집 중 다른 프로세스가 같은 파일을 바꾸면 그 변경도 포함될 수 있습니다.
- 파일이 1 MiB를 넘거나 바이너리/non-UTF-8이면 내용을 첨부하지 않습니다. diff가 24 KiB 또는 400줄을 넘으면 경로·크기·생략 사유만 전달합니다. diff 생성용 `git`이 없어도 편집은 가능하며 경로·크기만 전달합니다.
- `.env*`, credential/secret 파일명, 개인 키·인증서 경로는 picker와 preview에서 제외합니다. **파일명 기반 방어이지 파일 내용의 비밀 탐지 기능은 아닙니다.** 프로젝트 밖의 경로나 symlink 대상도 제외합니다.
- 다음 턴 메시지는 Pi의 `nextTurn` 큐를 사용합니다. 전송 전에 종료하거나 `/reload`할 경우까지 별도 복구를 보장하지 않습니다.
- `/reload`·세션 교체·Pi 종료 시 PTY와 임시 파일을 정리합니다. Vim에서 저장하지 않은 내용의 복구는 보장하지 않습니다.

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
  - `/calliopi-headers full|compact|off`: `full`(선·헤더·선, 기본), `compact`(`── ◉ 사용자 ───` 한 줄), `off`. 바로 적용됩니다.
  - `/calliopi-headers thinking on|off`: thinking 테두리. 새로 그려지는 메시지부터 적용되고, 이전 기록은 `/reload` 후 반영됩니다.
  - 설정은 `~/.pi/agent/calliopi-ui.json`의 `turnHeaders`에 저장되며 모든 프로젝트에 적용됩니다. 같은 곳에서 `userIcon`, `userLabel`, `assistantIcon`, `assistantLabel`을 바꿀 수 있습니다.
- **아이콘**: 기본 `◉`, `⛭`, `∴`는 Unicode 이모지 속성이 없는 문자라 컬러 이모지로 바뀌지 않습니다. 말풍선 문자(`💭`, `💬`, `🗨`)는 모두 이모지라 쓰지 않습니다. 글꼴에 `⛭`이 없어 빈 네모로 보이면 `▣`나 `◈`로 바꾸세요.
- **헤더 위치**: Pi는 모델 응답마다 응답 컴포넌트를 하나씩 만들고, 그 응답의 thinking·텍스트를 담습니다. 도구 블록은 그 뒤에 별도로 붙습니다. 헤더는 이 응답 컴포넌트가 직접 그리므로 thinking보다 앞에 오고, **도구만 호출하는 응답**에서도 도구 블록 바깥 위에 나옵니다. 사용자가 직접 실행한 `!명령`은 별도 컴포넌트라 Pi 헤더가 붙지 않습니다.
- **thinking 테두리**: 클릭으로 펼치고 접는 동작은 그대로입니다. 폭이 좁으면 제목을 `∴`로 줄이고, 그래도 좁으면 테두리 없이 그립니다.
- **표시만 바꿉니다.** 저장된 메시지와 모델에 전달되는 내용은 그대로입니다.

### 구현 방식과 안전장치

확장 API로는 이 위치에 헤더를 넣을 수 없습니다. Markdown 변환 훅은 텍스트 블록마다만 호출되고, 도구만 호출하는 응답이나 숨긴 thinking에는 닿지 않습니다. 그래서 Pi가 공개 export하는 `AssistantMessageComponent`·`UserMessageComponent`의 `render`를, thinking 테두리는 `updateContent`를 감쌉니다.

- 감싼 함수는 예외가 나면 Pi의 원래 출력을 돌려줍니다. pi-tui는 render 예외를 처리되지 않은 예외로 바꿔 Pi를 종료하기 때문입니다.
- `/reload`·세션 종료 때 원래 함수로 되돌리고, 다시 불러와도 두 번 감싸지 않습니다.
- 클래스 모양이 예상과 다르면(Pi 업데이트 등) 감싸지 않습니다. 이때 헤더는 Markdown 변환 훅으로 대신 그립니다. 도구만 호출하는 응답과 thinking 앞에는 붙지 않고, thinking 테두리는 꺼집니다. `/calliopi-headers`가 어느 경로인지 알려줍니다.
- Pi의 내부 구조에 기대므로 Pi를 업데이트하면 `npm test --workspace @calliopi/ui`로 확인하세요. 실제 Pi 컴포넌트를 그려서 순서·폭·클릭·복구를 검증합니다.

## git 기록 탐색

같은 floating terminal에서 커밋 → 변경 파일 → diff 순서로 탐색합니다. **보기 전용**이며 Pi 대화에 아무것도 전달하지 않습니다.

터미널 폭이 100칸 이상이면 **분할 화면**입니다. 왼쪽과 오른쪽 모두 실제 fzf라서, 오른쪽 변경 파일 목록에도 들어가 검색·선택할 수 있습니다.

```text
╭ Commits ────────────┬ Files · 9771367 ─────────────╮
│ > 9771367 Add…      │ > +50 -0  lib/fzf.ts         │   왼쪽 커서를 옮기면
│   69a5fd5 Ren…      │   +93 -0  lib/git-log.ts     │   오른쪽 파일 목록과
│                     │ ╭ diff 미리보기 ──────────╮ │   diff가 따라 바뀝니다
╰ Tab/Enter: 파일 목록 · Esc: 닫기 ────────────────╯
```

| 위치 | `Tab` / `Enter` | `Esc` | 기타 |
|---|---|---|---|
| 커밋 목록 | 파일 목록으로 | Pi 복귀 | 검색어 입력·↑↓ 이동 |
| 파일 목록 | `Tab`: 커밋 목록으로 · `Enter`: 전체 화면 diff | 커밋 목록으로 | |
| diff (delta 또는 less) | | | `q`: 파일 목록으로 |

- 커밋 fzf는 계속 실행되어 검색어·커서가 그대로 유지됩니다. 파일 fzf는 커밋을 옮길 때마다 다시 띄우며, diff를 보고 돌아오면 검색어·커서를 복원합니다.
- 커밋 커서는 fzf의 `focus` 이벤트를 개인 임시 파일로 받아 따라갑니다. 다른 로컬 프로세스가 명령을 보낼 수 있는 fzf 원격 제어 서버(`--listen`)는 쓰지 않습니다. 빠르게 스크롤할 때는 80ms 모아서 한 번만 갱신합니다.

폭이 100칸 미만이거나 `/calliopi-log --steps`로 열면 단계별 화면입니다.

```text
 ① 커밋 목록      미리보기: git show --stat     Enter → ② · Esc → Pi 복귀
 ② 변경 파일 목록  미리보기: 해당 파일 diff    Enter → ③ · Esc → ①
 ③ 파일 diff       delta(없으면 less)              q → ②
```

- `git`, `fzf`, `less`가 필요하고 `delta`는 선택 사항입니다. 현재 Pi 작업 디렉터리가 속한 저장소의 현재 브랜치 기록을 최근 2000개까지 보여줍니다.
- 이전 단계로 돌아오면 검색어를 유지합니다. 검색어가 없으면 직전에 고른 항목에 커서를 둡니다.
- merge 커밋은 첫 번째 부모와, 최초 커밋은 빈 트리와 비교합니다. 이름 변경은 `이전 → 이후`로 표시합니다. 변경 파일이 없는 커밋은 선택해도 커밋 목록에 머묭니다.
- pager는 이 명령 안에서만 고정합니다. 사용자의 `pager.diff` 설정을 바꾸지 않으며, diff가 짧아도 바로 닫히지 않고 `q`로 나갑니다.
- 파일 경로는 문자 그대로 다룹니다(`GIT_LITERAL_PATHSPECS`). 항목은 번호로만 주고받아 공백·탭·줄바꿈이 있는 파일명도 안전하게 처리합니다.

### 구조

`lib`은 `.mjs`를 쓰지 않습니다. Pi의 `/reload`가 Node ESM 캐시에 남아 있는 `.mjs`를 다시 읽지 않기 때문입니다.

```text
extensions/file-picker.ts   /calliopi-edit · 다음 턴 메시지
extensions/git-log.ts       /calliopi-log
extensions/turn-headers.ts  대화 기록 헤더·thinking 테두리 설치/복구 · /calliopi-headers
lib/turn-headers.ts         헤더 줄, render 감싸기, Markdown 대체 경로
lib/thinking-frame.ts       thinking 테두리 컴포넌트, updateContent 감싸기
lib/overlay-session.ts      공용 overlay 수명·키 입력 점유·사전 확인
lib/fzf.ts                  번호 기반 fzf 선택(검색어·커서 복원)
lib/git-log.ts              커밋·파일 목록, 분할/단계별 탐색 흐름
bin/git-preview.ts          커밋/파일 미리보기
lib/terminal-overlay.ts    pane(node-pty ↔ @xterm/headless) ↔ Pi 렌더러, 단일/분할 배치
lib/terminal-input.ts      외부 Kitty 키 입력 → 내부 xterm 키 입력
lib/editor-flow.ts         fzf → 스냅샷 → Vim → 변경 비교
lib/file-edit.ts           파일 목록·경로 검사·스냅샷·diff
bin/file-preview.ts         bat preview / plain-text fallback
```

자식 프로세스의 ANSI 출력은 headless 터미널이 해석하고 Pi에는 화면 셀과 SGR 스타일만 전달합니다. 자식의 커서 이동·alternate screen·OSC clipboard 명령을 실제 Pi 터미널로 직접 쓰지 않습니다.

`node-pty`는 네이티브 의존성입니다. 지원 플랫폼의 prebuilt 또는 로컬 빌드 환경이 필요할 수 있습니다. `node-pty@1.1.0`의 Unix prebuilt `spawn-helper` 실행 권한 누락은 이 패키지의 `postinstall`에서 보정합니다. `--ignore-scripts`로 설치했다면 `npm run postinstall --workspace @calliopi/ui`를 실행하세요.

### 검증

```bash
npm test --workspace @calliopi/ui
# 설치된 Pi를 별도 PTY에서 실행해 fullscreen/regular 양쪽을 검증합니다.
# 네트워크·모델 요청 없이 임시 프로젝트만 편집합니다.
npm run smoke --workspace @calliopi/ui
```

테스트에는 실제 fzf → 실제 Vim → diff 흐름, 한글/공백/따옴표 파일명, 키 프로토콜 변환, resize·alternate screen, 취소·무변경·삭제·내용 생략·PTY 정리를 포함합니다.
