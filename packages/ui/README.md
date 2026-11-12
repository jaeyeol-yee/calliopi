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

## 구조

화면과 입력 부품만 둡니다. 명령(`/calliopi-edit`, `/calliopi-log`)은 `calliopi-workflows`가 이 부품으로 만듭니다. `lib`은 `.mjs`를 쓰지 않습니다. Pi의 `/reload`가 Node ESM 캐시에 남아 있는 `.mjs`를 다시 읽지 않기 때문입니다.

```text
extensions/turn-headers.ts  대화 기록 헤더·thinking 테두리 설치/복구 · /calliopi-headers
lib/turn-headers.ts         헤더 줄, render 감싸기, Markdown 대체 경로
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
