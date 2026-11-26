# @calliopi/calliopi-agents

서브에이전트: 모델이 일을 맡기면 **자식 Pi가 터미널 멀티플렉서 pane에서** 그 일을 하고, 계약(과제, 완료 조건, 예산)에 따라 `finish`로 결과를 보고합니다. 자식은 진짜 Pi 화면이라 thinking, 도구 호출을 그대로 보고, pane에 직접 입력해 끼어들 수 있습니다. 기록과 규칙은 `@calliopi/core/agents`에 있습니다.

> 진행 상황: 자식 쪽(child 확장)까지. 위임하는 쪽(`subagent` 도구, pane 실행, 결과 반환)과 위임 시점 요약, tree viewer는 다음 단계입니다. 설계: `/load-plan subagents`.

## 자식 Pi

`CALLIOPI_AGENT_DIR`(에이전트 디렉터리)를 받고 시작한 Pi가 자식입니다. 같은 확장이 부모에서는 위임하는 쪽, 자식에서는 이 역할을 합니다.

```text
env CALLIOPI_AGENT_DIR=<dir> PI_CODING_AGENT_DIR=… pi --session-dir <dir> --session-id <id> -e … \
    --model <model> [--thinking …] --tools <허용 도구>,finish --append-system-prompt <dir>/system-prompt.md
```

- **과제는 자식이 직접 제출합니다.** 명령줄에 과제를 넣으면 Pi가 바로 제출해 버려, 부모의 배경을 그 앞에 둘 수 없기 때문입니다. `context: summary`면 inbox에 배경이 오기를 최대 10초 기다렸다가(`배경 대기 중…`) 세션에 [배경][과제] 순으로 넣고, 늦으면 과제를 먼저 보내고 배경은 도착할 때 steer로 넣습니다(늦게 왔다고 표시).
- **세션 파일**은 부모가 미리 만들어 두고(`<시각>_<id>.jsonl`), 헤더의 `parentSession`이 부모 세션을 가리킵니다. Pi는 이 파일을 열어 이어 씁니다.
- **system prompt**: 서브에이전트 규칙(혼자 일함, 범위를 지킴, 끝나면 `finish`) + 역할 파일 본문.
- **`finish` 도구**: `status`(`done` | `partial` | `blocked`), `summary`, `evidence`, `artifacts`. 결과를 쓰고 실행을 끝냅니다(`terminate`).
- **finish 없이 멈추면** 한 번 상기시키고, 그래도 없으면 마지막 답을 요약 삼아 `unanswered`로 보고합니다.
- **inbox**(`inbox/NNNNNN.json`): `briefing`, `steer`, `stop`을 순번대로 한 번씩 받습니다(`delivered.json`). 파일 변경 감지 + 1초 확인.
- **예산**: 턴이 끝날 때마다 확인하고, 80%에 이르면 한 번 마무리하라고 알리고, 다 쓰면 중단해 `budget_exceeded`(무응답이 길면 `idle`)로 보고합니다.
- **기록**: `status.json`(상태, 현재 활동, 턴, 토큰, 배경 도착), `requests.jsonl`(provider로 보낸 요청 전부, 이전 요청과의 델타), `result.json`(한 번만).
- 토큰 예산은 새로 보낸 입력 + 출력 + 캐시 쓰기로 셉니다(캐시 읽기는 제외).

## 구조

```text
extensions/agents.ts   진입점: 자식이면 installChild
lib/child.ts           자식: finish 도구, 과제 제출, inbox, 예산, 기록
lib/contract.ts        자식에게 주는 문구: system prompt, 과제, 배경, 상기
lib/launch.ts          자식 준비: 세션 파일(parentSession), pane 명령(env 전달)
```

## 테스트

`npm test -w @calliopi/calliopi-agents`. 실제 tmux 서버(전용 socket)에 자식 Pi를 demo의 faux 모델로 띄워 배경 → 과제 순서, `finish`, inbox `stop`, 상기 후 `unanswered`를 확인합니다. faux 모델은 provider 요청(payload)을 만들지 않으므로 요청 기록은 handler를 직접 호출해 확인합니다.
