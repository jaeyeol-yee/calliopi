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

### 구조

```text
extensions/file-picker.ts   명령·overlay 수명·다음 턴 메시지
lib/terminal-overlay.ts    node-pty ↔ @xterm/headless ↔ Pi 렌더러
lib/terminal-input.ts      외부 Kitty 키 입력 → 내부 xterm 키 입력
lib/editor-flow.ts         fzf → 스냅샷 → Vim → 변경 비교
lib/file-edit.ts           파일 목록·경로 검사·스냅샷·diff
bin/file-preview.mjs        bat preview / plain-text fallback
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
