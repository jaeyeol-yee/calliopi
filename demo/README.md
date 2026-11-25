# demo

Pi 화면을 시나리오대로 녹화해 GIF로 만듭니다. 모델 답변은 faux 모델(`@earendil-works/pi-ai`의
`fauxProvider`)이 시나리오에 적힌 그대로 흘려보내므로 API 키가 필요 없고, 매번 같은 결과가 나옵니다.

```text
demo/scenarios/<name>.yaml  →  assets/scenarios/<name>.gif
```

## 사용

```bash
npm run demo                        # 모든 시나리오
npm run demo -- conversation        # 지정한 시나리오
npm run demo -- --tape conversation # demo/.out/<name>.tape만 생성 (녹화 없음)
npm run demo:check                  # GIF 없는 시나리오, 시나리오 없는 GIF
npm run demo:test                   # 타입 검사와 단위 테스트
```

녹화에는 [VHS](https://github.com/charmbracelet/vhs)(ttyd, ffmpeg 포함)가 필요합니다(`brew install vhs`).
한글 글자 폭을 맞추려면 2칸 폭 CJK 고정폭 폰트를 `DEMO_FONT_FAMILY`로 지정하세요
(CI는 `Noto Sans Mono CJK KR`).

## 시나리오

```yaml
title: 대화 시나리오
project: retry-demo          # Pi에 ~/retry-demo로 보이는 작업 디렉터리
terminal: { width: 1200, height: 720, fontSize: 16 }   # 선택: fontFamily, theme
tokensPerSecond: 80          # 답변 출력 속도
piArgs: []                   # pi에 추가로 넘길 인자
setup: |                     # 녹화 전 작업 디렉터리에서 실행 (녹화되지 않음)
  git init -q
multiplexer: tmux            # 선택: Pi를 tmux 안에서 실행 (/cl-run처럼 pane을 여는 명령)
completions:                 # 선택: 확장이 대화 밖에서 보내는 단발 요청(/cl-run ?)의 답
  - match: "<wanted>\\n테스트"  #   요청 본문에 맞는 첫 정규식의 text를 돌려줍니다
    text: npm test

turns:
  - prompt: 사용자가 입력할 문장          # 입력 후 Enter
    reply:                               # faux 모델의 답변
      - thinking: 생각 블록
      - tool: read                       # 도구 호출. 실제로 실행됩니다
        args: { path: src/auth.ts }
      - text: 도구 결과를 받은 뒤의 본문
    wait: 정규식                          # 선택: 기본은 마지막 text의 끝 두 단어
    pause: 2s                            # 선택: 답변 뒤 멈춤 (기본 2s)

  - tape: |                              # VHS 명령을 그대로 (/명령, 키 조작 등)
      Type "/cl-log"
      Enter
    reply: [...]                         # 선택: 이 키 입력이 보낸 메시지에 대한 답변
```

- n번째 대화 턴에는 `reply`가 있는 n번째 턴의 답변이 갑니다. 확장이 턴에 끼워 넣는 메시지(`/cl-run`의 작업 결과 등)는 세지 않습니다.
- `completions`는 순서와 무관하고 `turns`의 답변 번호에 들어가지 않습니다.
- `multiplexer: tmux`는 녹화마다 전용 tmux 서버와 설정으로 Pi를 띄웁니다. 사용자의 tmux와 `~/.tmux.conf`는 쓰지 않습니다. tmux가 `PATH`에 있어야 합니다.
- `tool` 블록은 모델 호출 하나를 끝냅니다. 그 뒤의 블록은 도구 결과를 받은 다음 호출로 이어집니다.

## 격리

녹화마다 임시 `HOME`과 `PI_CODING_AGENT_DIR`을 만들고 `--no-session --no-skills --no-context-files`로
Pi를 실행합니다. 사용자 설정, 세션, 스킬은 읽지 않고, 확장은 `demo/faux-extension.ts`와 calliopi 루트
패키지만 불러옵니다.

## CI (`.github/workflows/demo.yml`)

- PR이 시나리오를 **추가**하면(이름 변경 포함) 그 시나리오만 녹화합니다. GIF가 이미 커밋돼 있고 그 뒤로
  시나리오가 바뀌지 않았으면 건너뜁니다. 코드 변경으로는 다시 녹화하지 않습니다.
- bot의 GIF 커밋에는 `[skip ci]`가 붙어 workflow가 다시 돌지 않습니다.
- 같은 저장소의 PR이면 GIF를 PR 브랜치에 커밋하고, fork PR이면 artifact로만 올립니다.
- 다시 녹화하려면 workflow를 수동 실행합니다(`only`에 이름을 공백으로 구분, 비우면 전체).
