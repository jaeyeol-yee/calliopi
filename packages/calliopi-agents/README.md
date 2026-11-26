# @calliopi/calliopi-agents

서브에이전트: 모델이 일을 맡기면 **자식 Pi가 터미널 멀티플렉서 pane에서** 그 일을 하고, 계약(과제, 완료 조건, 예산)에 따라 `finish`로 결과를 보고합니다. 자식은 진짜 Pi 화면이라 thinking, 도구 호출을 그대로 보고, pane에 직접 입력해 끼어들 수 있습니다. 기록과 규칙은 `@calliopi/core/agents`에 있습니다.

> 진행 상황: 위임(`subagent` 도구), 자식(child 확장), 위임 시점 요약과 배경, 계약 알림까지. tree viewer, 이탈 대응, 내보내기, worktree 격리는 다음 단계입니다. 설계: `/load-plan subagents`.

## 위임: `subagent` 도구

모델만 호출합니다(사용자 명령은 없음 — "리뷰어한테 맡겨"처럼 말로 시킵니다).

```ts
subagent({
  tasks: [{ role: 'reviewer', task: '…', done: '…', model?, context?: 'none' | 'summary', budget?: { turns, minutes, tokens } }],  // 최대 4개, 병렬
  background?: true,   // 바로 돌아오고, 하나씩 끝날 때마다 모델을 깨움
})
```

- **역할 카탈로그**: `agents/*.md`를 이 패키지의 기본(`scout`, `reviewer`) → `<Pi agent dir>/agents` → 프로젝트 `.agents/agents`, `.pi/agents` 순으로 읽고 뒤가 앞을 대신합니다. 역할의 `when`/`not_when`은 도구 이름을 명시한 system prompt 규칙(`promptGuidelines`)이 됩니다. 잘못된 파일은 건너뛰고 문제로 보고합니다.
- **규칙**: 최상위 Pi는 모든 역할에, 자식은 역할의 `allowed_subagents`에만, 최대 깊이 2 미만에서만 위임합니다. 모델은 고정된 역할 → 호출 → 역할 기본값 → 부모. 도구는 부모 Pi에 등록된 도구 중 역할이 허용한 것만. 예산은 부모가 남긴 만큼까지(`@calliopi/core/agents`).
- **승인**: 역할의 `approval`이 `once`면 세션에서 처음 한 번, `always`면 매번 확인합니다. UI가 없으면 거절합니다.
- **상한**: 한 번에 4개, 세션에서 20개.
- **실행**: 자식마다 기록(`<Pi agent dir>/calliopi-agents/<최상위 세션>/<id>/`), system prompt, 세션 파일을 먼저 만들고 multiplexer의 백그라운드 창(tmux) 또는 옆 pane(Rex, herdr)에 띄웁니다. 부모가 `-e`로 받은 확장도 자식에게 넘깁니다.
- **foreground**(기본): 진행 상황을 한 줄씩 보여 주며 모두 끝날 때까지 기다리고, 결과(`resultForParent`)를 도구 결과로 돌려줍니다. 중단(Esc)하면 자식들에게 `stop`을 보냅니다.
- **background**: 바로 돌아오고, 자식이 끝나면 결과를 `steer` + `triggerTurn`으로 보내 모델을 깨웁니다(`/cl-run`과 같은 방식). 대화 기록에는 `✓ scout-2 · 완료 · 12초 · 턴 2`처럼 한 줄로 보이고 펼치면 전달한 내용이 보입니다.

## 위임 시점 요약과 배경 (`context: summary`, 역할 기본값)

요약은 매 턴 만들지 않고 **일을 맡기는 순간에만** 만듭니다. auto compaction과는 별개입니다.

- 마지막 위임 요약(없으면 마지막 compaction 요약) 이후의 메시지만, Pi가 compaction에 쓰는 요약기(`generateSummaryWithUsage`)로 이전 요약에 이어 갱신합니다. 형식도 같습니다(Goal, Constraints & Preferences, Progress, Key Decisions, Next Steps, Critical Context). 새 메시지가 없으면 요청 없이 이전 요약을 씁니다.
- 요약은 부모 세션에 `calliopi-summary` 항목으로 남습니다(모델 맥락에는 들어가지 않음). "맡길 때 부모가 무엇을 알고 있었나"의 기록입니다.
- 요약은 자식들이 시작하는 동안 **병렬로** 만들고, 한 번 만든 것을 역할에 맞게 잘라(파일을 바꾸지 않는 역할은 Progress 제외) 각 자식의 inbox에 보냅니다. 자식은 과제보다 먼저 받거나(최대 10초 대기), 늦으면 steer로 받습니다.
- 요약이 실패하면 빈 배경을 보내 자식이 기다리지 않게 하고, 과제만으로 진행합니다.

## 자식 Pi

`CALLIOPI_AGENT_DIR`(에이전트 디렉터리)를 받고 시작한 Pi가 자식입니다. 같은 확장이 부모에서는 위임하는 쪽, 자식에서는 이 역할을 합니다.

```text
env CALLIOPI_AGENT_DIR=<dir> PI_CODING_AGENT_DIR=… pi --session-dir <dir> --session-id <id> -e … \
    --model <model> [--thinking …] --tools <허용 도구>,finish --append-system-prompt <dir>/system-prompt.md
```

- **과제는 자식이 직접 제출합니다.** 명령줄에 과제를 넣으면 Pi가 바로 제출해 버려, 부모의 배경을 그 앞에 둘 수 없기 때문입니다. `context: summary`면 inbox에 배경이 오기를 최대 10초 기다렸다가(`배경 대기 중…`) 세션에 [배경][과제] 순으로 넣고, 늦으면 과제를 먼저 보내고 배경은 도착할 때 steer로 넣습니다(늦게 왔다고 표시).
- **세션 파일**은 부모가 미리 만들어 두고(`<시각>_<id>.jsonl`), 헤더의 `parentSession`이 부모 세션을 가리킵니다. Pi는 이 파일을 열어 이어 씁니다.
- **system prompt**: 서브에이전트 규칙(혼자 일함, 범위를 지킴, 끝나면 `finish`) + 역할 파일 본문.
- **계약 알림(목적 고정)**: 과제를 보낸 뒤 매 모델 요청의 맨 끝에 `[Subagent contract] Task … Done when … Budget used …`를 붙입니다. 세션에는 저장하지 않으므로 맥락이 길어지거나 compaction이 일어나도 목적이 항상 최근 위치에 보이고, 요청의 꼬리만 바뀌어 prompt cache는 유지됩니다. 목적은 추론된 요약이 아니라 호출할 때 선언한 계약입니다.
- **`finish` 도구**: `status`(`done` | `partial` | `blocked`), `summary`, `evidence`, `artifacts`. 결과를 쓰고 실행을 끝냅니다(`terminate`).
- **finish 없이 멈추면** 한 번 상기시키고, 그래도 없으면 마지막 답을 요약 삼아 `unanswered`로 보고합니다.
- **inbox**(`inbox/NNNNNN.json`): `briefing`, `steer`, `stop`을 순번대로 한 번씩 받습니다(`delivered.json`). 파일 변경 감지 + 1초 확인.
- **예산**: 턴이 끝날 때마다 확인하고, 80%에 이르면 한 번 마무리하라고 알리고, 다 쓰면 중단해 `budget_exceeded`(무응답이 길면 `idle`)로 보고합니다.
- **기록**: `status.json`(상태, 현재 활동, 턴, 토큰, 배경 도착), `requests.jsonl`(provider로 보낸 요청 전부, 이전 요청과의 델타), `result.json`(한 번만).
- 토큰 예산은 새로 보낸 입력 + 출력 + 캐시 쓰기로 셉니다(캐시 읽기는 제외).

## 구조

```text
extensions/agents.ts   진입점: 최상위면 installParent, 자식이면 installChild (+ 위임할 수 있는 역할이면 installParent)
lib/parent.ts          subagent 도구: 검사, 승인, 기록, pane 실행, foreground 대기, background 알림
lib/catalog.ts         역할 파일 읽기 (기본 → 사용자 → 프로젝트)
lib/briefing.ts        위임 시점 요약: 입력 고르기, 역할별 자르기, 자식 inbox로 보내기
agents/                기본 역할: scout, reviewer
lib/child.ts           자식: finish 도구, 과제 제출, inbox, 예산, 기록
lib/contract.ts        자식에게 주는 문구: system prompt, 과제, 배경, 상기
lib/launch.ts          자식 준비: 세션 파일(parentSession), pane 명령(env 전달)
```

## 테스트

`npm test -w @calliopi/calliopi-agents`. 실제 tmux 서버(전용 socket)에 최상위 Pi와 자식 Pi를 demo의 faux 모델로 띄워(자식의 답은 `DEMO_CHILD_SCENARIO`) foreground 결과 반환, background 깨우기, 세션 헤더의 `parentSession`, 위임 시점 요약(faux `completions`)과 잘린 배경이 과제보다 먼저 오는지, 그리고 배경 → 과제 순서, `finish`, inbox `stop`, 상기 후 `unanswered`를 확인합니다. faux 모델은 provider 요청(payload)을 만들지 않으므로 요청 기록은 handler를 직접 호출해 확인합니다.
