# @calliopi/calliopi-agents

서브에이전트: 모델이 일을 맡기면 **자식 Pi가 부모 Pi의 pseudo-terminal에서** 그 일을 하고, 계약(과제, 완료 조건, 예산)에 따라 `finish`로 결과를 보고합니다. pane은 열지 않습니다. 자식은 진짜 Pi 화면을 그리고 있어서, `/cl-agents`로 floating window에 띄워 thinking과 도구 호출을 그대로 보고 직접 입력해 끼어들 수 있습니다. 터미널 멀티플렉서가 없어도 동작합니다. 기록과 규칙은 `@calliopi/core/agents`에 있습니다.

> 진행 상황: 위임(`subagent` 도구), 자식(child 확장), 위임 시점 요약과 배경, 계약 알림, `/cl-agents`, **Active Goal**(goal 링크, 자동 계속, 정리, 내보내기)까지. 이탈 판정, worktree 격리와 쓰기 역할은 다음 단계입니다. 설계: `/load-plan subagents`.

## 위임: `subagent` 도구

모델만 호출합니다(사용자 명령은 없음 — "리뷰어한테 맡겨"처럼 말로 시킵니다).

```ts
subagent({
  tasks: [{ role: 'reviewer', task: '…', done: '…', model?, context?: 'none' | 'summary', budget?: { turns, minutes, tokens } }],  // 최대 4개, 병렬
  background?: false,  // 기본 true: 바로 돌아오고, 하나씩 끝날 때마다 모델을 깨움. false면 모두 끝날 때까지 기다림
})
```

- **역할 카탈로그**: `agents/*.md`를 이 패키지의 기본(`scout`, `reviewer`) → `<Pi agent dir>/agents` → 프로젝트 `.agents/agents`, `.pi/agents` 순으로 읽습니다. 사용자 역할은 같은 이름의 기본 역할을 대신하지만, **프로젝트 역할은 새 이름만 추가할 수 있고**(저장소의 `reviewer.md`가 읽기 전용 reviewer를 바꾸지 못하게) 최소 `approval: once`로 다뤄집니다. `approval`, `context`, `model_locked`, `tools` 값이 잘못되면(예: `approval: yes`) 느슨한 기본값으로 떨어지지 않고 그 파일을 오류로 건너뜁니다. 역할의 `when`/`not_when`은 도구 이름을 명시한 system prompt 규칙(`promptGuidelines`)이 됩니다. 잘못된 파일은 건너뛰고 문제로 보고합니다.
- **규칙**: 최상위 Pi는 모든 역할에, 자식은 역할의 `allowed_subagents`에만, 최대 깊이 2 미만에서만 위임합니다. 모델은 고정된 역할 → 호출 → 역할 기본값 → 부모. 도구는 부모 Pi에서 **지금 켜진** 도구 중 역할이 허용한 것만(위임할 수 있는 역할에는 `subagent`도). 역할이 `mcp__` 도구를 적지 않으면 자식은 `--no-mcp`로 떠서 MCP 도구를 받지 않습니다. 역할 정의가 `bash`를 허용하면 "읽기 전용"은 지침일 뿐 강제가 아닙니다. 예산은 부모가 남긴 만큼까지(`@calliopi/core/agents`).
- **승인**: 역할의 `approval`이 `once`면 세션에서 처음 한 번, `always`면 매번 확인합니다. UI가 없으면 거절합니다.
- **상한**: 한 번에 4개, 이 Pi 실행에서 20개(`/reload`나 새 세션이면 다시 셉니다). 동시에 온 호출도 상한을 넘지 못하게 시작 전에 자리를 잡아 둡니다.
- **검사 먼저**: 역할, 위임 규칙, 모델, 예산(부모가 남긴 것이 없으면 거절), 승인을 모두 확인한 뒤에야 하나라도 시작합니다. 거절로 남겨지는 자식이 없습니다.
- **실행**: 자식마다 기록(`<Pi agent dir>/calliopi-agents/<최상위 세션>/<id>/`), system prompt, 세션 파일을 먼저 만들고, **동시에** 부모의 pseudo-terminal에서 띄웁니다(`lib/fleet.ts`). 환경은 그대로 물려받고 명령줄에는 올리지 않습니다. 부모가 `-e`로 받은 확장도 넘깁니다. 기록을 준비하거나 시작하는 단계에서 하나라도 실패하면 나머지도 멈춥니다(전부 아니면 없음). 시작한 뒤 60초 안에 상태를 쓰지 못한 자식(확장 로드 실패 등)은 `error`로 끝냅니다. 자식은 `CALLIOPI_AGENT_DIR`를 읽은 즉시 환경에서 지우고, `--session-id`가 자기 id일 때만 자식으로 동작하므로, 자식이 실행한 다른 Pi(테스트 등)가 자식 행세를 하지 않습니다.
- **수명**: 자식은 부모 Pi의 세션과 함께 삽니다. 부모 Pi가 끝나거나 `/new`, `/resume`, `/fork`, `/reload`로 이 확장이 바뀌면 실행 중인 자식은 `stopped`로 기록하고 종료합니다(결과를 받을 곳이 없어지므로). 결과를 보고한 자식은 Pi를 종료하고, 마지막 화면은 `/cl-agents`에서 볼 수 있게 남습니다. 결과 없이 죽은 자식도 `stopped`로 기록해 아무도 기다리지 않게 하고, 마지막 상태의 턴·토큰을 결과에 남겨 예산에서 빠지지 않게 합니다. 부모가 강제로 죽어 기록이 남지 않은 자식은 세션을 다시 열 때 `stopped`로 닫습니다.
- **알려진 한계**: 부모 Pi가 꺼져 있는 동안 끝난 결과는 모델에 다시 알리지 않습니다(기록과 `/cl-agents`에는 남음). 자식은 부모와 함께 끝나며, 재시작한 부모가 실행 중인 자식에 다시 붙지는 않습니다.
- **background**(기본, fire-and-forget): 바로 돌아오고, 자식이 끝나면 결과를 `steer` + `triggerTurn`으로 보내 모델을 깨웁니다(`/cl-run`과 같은 방식). 모델이 쉬고 있으면 바로 답하고, 작업 중이면 다음 요청 전에 끼어듭니다. 대화 기록에는 `✓ scout-2 · 완료 · 12초 · 턴 2`처럼 한 줄로 보이고 펼치면 전달한 내용이 보입니다.
- **foreground**(`background: false`): 진행 상황을 한 줄씩 보여 주며 모두 끝날 때까지 기다리고, 결과(`resultForParent`)를 도구 결과로 돌려줍니다. 다음 단계가 그 결과에 달려 있을 때만 씁니다. 중단(Esc)하면 자식들에게 `stop`을 보내고, 그 뒤에 끝나는 것은 background처럼 알립니다.

## Active Goal

세션에는 **열린 goal이 하나**만 있습니다(`active` ↔ `paused` → `done` | `abandoned`). 그동안 맡긴 서브에이전트는 그 goal에 링크되고(손자는 상속), goal이 닫히면 그 에이전트들도 함께 정리됩니다.

```text
/cl-goal 로그인 실패 재시도 구현 --done 테스트 통과, 401은 재시도 안 함   만들고 바로 시작
/cl-goal                    지금 goal (목표, 진척, 사용량, 서브에이전트)
/cl-goal pause | resume     일시 중지 / 이어서 (resume은 바로 다시 시작)
/cl-goal done [메모] | abandon [메모]
```

- 모델 도구: `goal_get`, `goal_create`(목표, 완료 조건, 예산), `goal_update`(`progress`로 진척 메모, `status: done`은 완료 조건을 실제로 확인한 뒤, `blocked`는 사용자가 필요할 때 → 일시 중지).
- **목적 고정**: active인 동안 매 요청 끝에 goal(목표, 완료 조건, 진척)을 붙입니다(저장 안 함). footer에 `◆ 목표 · 진행 중`.
- **자동 계속**: active인 채로 실행이 끝나면 완료 조건을 확인하고 다음 단계를 하라는 메시지로 이어서 일합니다(followUp + triggerTurn). 이어서 하지 않는 경우:
  - 사용자 메시지가 기다리고 있을 때(그것이 먼저), goal의 서브에이전트가 실행 중일 때(결과가 깨움)
  - 일시 중지되는 경우: 사용자가 중단(Esc), 모델 요청 실패, 도구 호출 없는 실행이 3번 연속, 자동 계속 20번, goal 예산(턴·토큰, 서브에이전트 포함) 초과 — 이유를 알리고 `/cl-goal resume`으로 이어갑니다.
- **닫을 때**(`done` | `abandoned`): 링크된 실행 중 서브에이전트를 중지하고, 끝난 것의 화면을 해제하고, goal 결과에 서브에이전트들의 결과 한 줄씩을 붙입니다.
- **자동 goal (implicit)**: 열린 goal이 없는데 요청에 서브에이전트가 필요하면(`subagent` 호출) goal이 저절로 열립니다. 목표는 사용자의 마지막 요청(한 줄, 120자)이고, footer에 `◇ 목표 · 자동`으로 표시됩니다. 그 요청의 서브에이전트를 묶기만 합니다.
  - 목적 고정, 자동 계속, 일시 중지를 하지 않습니다.
  - 서브에이전트가 모두 끝나고 실행이 끝나면(기다리는 메시지 없음) 스스로 `done`으로 닫힙니다. 화면은 해제하지 않아 계속 볼 수 있습니다.
  - `goal_create`나 `/cl-goal <목표>`를 쓰면 이 goal이 명시적 goal로 바뀌고, 서브에이전트는 그대로 유지됩니다.
  - `/cl-agents`에서는 열린 goal이 없을 때 가장 최근에 닫힌 자동 goal을 펼쳐 보여 줍니다.
  - 앞 요청의 서브에이전트가 도는 중에 새 요청에서 또 위임하면 같은 goal에 붙고, 목록에서는 요청별 소제목(`» 요청`)으로 나뉩니다.
  - 일시 중지·`blocked`가 되지 않습니다(그러면 영영 닫히지 않으므로). 세션을 다시 열 때 남아 있던 자동 goal은 닫습니다. 서브에이전트가 모두 시작하지 못했으면 `abandoned`로 닫습니다.
  - 명시적 goal로 바꾸면 goal 자신의 사용량·자동 계속 횟수는 0부터 다시 셉니다(서브에이전트 토큰은 계속 포함).
- 저장: `<레지스트리>/<세션>/goals/<id>.json`, 변경 이력은 세션의 `calliopi-goal` 항목.

## 정리 (GC)

goal을 만들 때, 닫을 때, 서브에이전트를 띄울 때 오래된 기록을 지웁니다.

- 닫힌 goal의 서브에이전트(goal 없는 것은 자기가 끝난 시점부터): **3일** 뒤 `requests.jsonl`, **14일** 뒤 디렉터리 전체. 그다음 아무것도 남지 않은 goal 파일과 빈 세션 디렉터리.
- 실행 중인 서브에이전트와 열린 goal의 것은 건드리지 않습니다. `exports/`도 지우지 않습니다.
- 기간: `<Pi agent dir>/calliopi-agents.json` — `{ "retention": { "requestsDays": 3, "recordsDays": 14 } }`.
- 메모리: 끝난 서브에이전트의 화면은 goal이 닫힐 때 해제됩니다(그 뒤로는 기록으로 보여 줌).

## `/cl-note`: 세션 메모

에이전트가 헛돌았거나 직접 교정해야 했을 때 한 줄을 남깁니다. 무엇을 고칠지 나중에 정하는 사람을 위한 기록이고, 모델에게는 보내지 않습니다(턴을 시작하지 않고, 대화 컨텍스트에도 들어가지 않습니다).

```text
/cl-note 편집할 때마다 전체 테스트를 다시 돌림
/cl-note                 최근 메모 5개
```

- **저장**: `<Pi agent dir>/calliopi-notes.jsonl`에 한 줄에 하나씩 덧붙입니다(0600). 시각, 메모, 세션 id와 세션 파일, 작업 디렉터리, 그때의 모델을 함께 남깁니다. 여러 줄을 붙여 넣어도 한 줄로 합칩니다.
- **세션 표시**: 같은 메모를 세션에 custom entry(`calliopi-note`)로도 남겨, 세션 파일에서 메모한 지점을 찾을 수 있습니다. Pi의 custom entry는 모델 컨텍스트에 들어가지 않습니다.
- **모아 보기**: `npm run signals`가 실행 집계와 세션 smell 뒤에 `## Notes`로 최근 50개를 보여 줍니다(`--session <id>`면 그 세션의 메모만).
- 최상위 Pi에만 있습니다. 서브에이전트(자식 Pi)에는 등록하지 않습니다.
- 메모는 자동으로 지우지 않습니다(GC 대상이 아님). 지우려면 파일을 직접 편집합니다.
- 메모를 고르고 묶고 처리 표시하는 기능은 없습니다. 사람이 읽고 정합니다.

## 세션 smell (`npm run signals`)

최상위 Pi 세션이 잘못 흘러간 흔적을 세션 파일에서 결정적 규칙으로 셉니다. 세기만 합니다: 모델에게 알리지 않고, 알림도 없습니다. 감지기는 세션 entry를 받는 순수 함수(`@calliopi/core/smells`)이고 리포트를 실행할 때 계산하므로, 감지기가 생기기 전에 기록된 세션도 읽습니다. 배경과 선례는 [docs/research/session-smell-triggers.md](../../docs/research/session-smell-triggers.md)에 있습니다.

| smell | 규칙 (run = 사용자 메시지 사이에 에이전트가 한 일) | 잠정 임계치 |
|---|---|---|
| `repeat` | 한 run에서 같은 도구를 같은 인자로 호출 | 3회 이상 |
| `error-streak` | 한 run에서 도구 결과가 연속으로 오류 | 3회 이상 |
| `interrupted` | 사용자가 답변을 중단(`stopReason: aborted`) | 1회 |
| `context-jump` | 한 run의 두 요청 사이에 프롬프트(input + cache read + cache write)가 증가 | 30,000 토큰 이상 |
| `restate` | 사용자가 친 메시지가 바로 앞의 것과 거의 같음(문자 쌍의 Dice 유사도, 둘 다 20자 이상). `/`, `<`, `[`로 시작하는 메시지(슬래시 명령, 스킬·템플릿, 하네스가 쓴 메시지)는 비교하지 않음 | 60% 이상 |
| `backtrack` | 작업을 버리는 git 명령: `restore`(`--staged`만이면 제외), `revert`(`--abort`·`--quit` 제외), `reset --hard`, `checkout --`·`checkout .` (에이전트의 `bash`, 사용자의 `!`) | 1회 |

```bash
npm run signals                    # 모든 최상위 세션
npm run signals -- --days 14       # 최근 14일에 시작한 세션(메모도 같은 기간)
npm run signals -- --session <id>  # 한 세션
```

- **읽는 곳**: `<Pi agent dir>/sessions/<프로젝트>/*.jsonl`. 서브에이전트의 세션은 레지스트리에 있어 여기 들어오지 않습니다(위의 실행 집계가 봅니다).
- **보고**: smell별로 한 번이라도 나온 세션 수와 비율, 전체 건수, 가장 자주 걸린 도구. 같은 수를 결과별, 하네스 버전별, 모델별로 한 번씩 더. 그리고 최근 10건을 세션 id, entry id와 함께 보여 줍니다(그 지점을 열어 실제 문제인지 판단하기 위한 것).
- **결과**(세션이 어떻게 끝났는지의 대리 지표): `git commit`이나 `gh pr create`가 성공했으면(에이전트의 `bash` 결과가 오류가 아님, 또는 사용자의 `!`가 0으로 끝남. `--dry-run`·`--help` 제외) `shipped`, 아니면 마지막 답변이 중단됐으면 `aborted`, 오류였으면 `error`, 그 밖은 `other`.
- **하네스 버전**: run이 시작될 때 이 Calliopi 체크아웃의 커밋(12자)과 추적 파일의 미커밋 변경 여부를 세션에 custom entry(`calliopi-harness`)로 남깁니다(`lib/harness.ts`). 세션에 마지막으로 남긴 값과 같으면 다시 쓰지 않습니다. 리포트는 요청이 가장 많이 돈 버전으로 세션을 묶고(`abc123def456`, `abc123def456-dirty`), 기록이 없는 세션은 `unrecorded`입니다. Pi의 custom entry는 모델 컨텍스트에 들어가지 않습니다. 최상위 Pi에만 있습니다. 코드가 git 체크아웃 안에 없거나, 그 체크아웃의 `package.json` 이름이 `calliopi`가 아니면(다른 저장소 안에 복사된 경우) 아무것도 남기지 않습니다. 버전은 확장을 불러올 때 한 번 읽으므로(`git` 호출 2번, 각 3초 제한) run은 기다리지 않습니다. 새로 만든 추적되지 않는 파일은 dirty로 치지 않습니다.
- **세부 내용에는 개수, 도구 이름, git 하위 명령만** 들어갑니다. 사용자나 모델이 쓴 글, 도구 인자, 경로는 넣지 않습니다. 세션 파일의 도구 이름·모델 이름·id가 평범한 이름 꼴이 아니면 `unknown`으로 바꿉니다.
- **임계치는 잠정값**입니다. 발생률과 정밀도(걸린 것이 실제 문제인 비율)를 재기 위한 출발점이고, 근거는 아직 없습니다.
- **알려진 한계**:
  - 폴링처럼 정당한 반복도 `repeat`로 잡힙니다.
  - `interrupted`는 중단한 이유를 모릅니다(방향 수정, 오타, 단순 취소가 섞임).
  - `context-jump`는 큰 파일을 일부러 읽은 경우도 잡고, 함께 보고하는 도구는 직전에 실행된 도구일 뿐 원인이 아닐 수 있습니다.
  - `restate`는 같은 메시지를 실수로 두 번 보낸 것과 답을 못 받아 다시 말한 것을 구분하지 못합니다. 바로 앞 메시지와만 비교합니다.
  - `backtrack`은 의도한 정리(실험을 버림)도 잡습니다.
  - git·gh 명령은 셸을 실행하지 않고 읽습니다: heredoc 본문과 따옴표 안은 버리고, `;`, `&`, `|`, `(`, 줄바꿈으로 자른 조각의 첫 명령만 봅니다(앞의 `A=1`, `sudo`, `then` 등과 git 자체 옵션은 건너뜀). `$(…)` 안이나 `eval`, alias, 스크립트 파일 안의 명령은 보지 못합니다.
  - `shipped`는 코드 작업이 아닌 세션(조사, 질문)에는 맞지 않습니다. 커밋 뒤에 잘못된 세션도 `shipped`이고, `git commit … || true`처럼 실패를 가린 명령도 성공으로 봅니다.
  - `/tree`·`/fork`로 가지가 있는 세션은 파일 순서대로 한 줄로 읽습니다.
  - 모델 요청 자체는 최상위 세션에 기록되지 않으므로 prefix 재작성은 여기서 세지 않습니다.

## `/cl-debrief`: 세션이 끝난 뒤의 분석

대화형 세션이 smell과 함께 끝나면, 별도의 Pi가 백그라운드에서 걸린 지점을 읽고 "실제 문제였는가, 원인은 어디로 보이는가"를 적어 둡니다. **기본은 꺼져 있습니다.** 실행할 때마다 모델 호출이 한 번 들고, 세션의 발췌가 그 모델로 전송되기 때문입니다.

```text
/cl-debrief on                  켜기 (그 세션의 모델로 분석)
/cl-debrief on openai/gpt-x     켜기, 분석 모델 지정
/cl-debrief off                 끄기
/cl-debrief status              켜짐 여부, 모델, 건수
/cl-debrief                     아직 안 본 결과 하나 보기
```

- **언제**: Pi를 종료하거나 `/new`, `/resume`으로 세션을 떠날 때. `/reload`와 `/fork`는 세션이 이어지므로 제외합니다. `pi -p`나 rpc처럼 대화형이 아닌 실행, 저장되지 않는 세션, smell이 없는 세션에서는 아무것도 띄우지 않습니다. 같은 세션은 앞선 분석이 끝났고 그 뒤로 세션이 더 길어졌을 때만 다시 분석합니다(시간 초과나 오류로 끝난 분석도 세션이 그대로면 다시 하지 않음).
- **무엇을 보내나**: 걸린 지점마다 앞뒤 3개 entry의 발췌와 감지기의 설명입니다(최대 8지점). entry마다 글은 400자까지, 도구 호출은 4개까지 인자 200자씩, 도구 결과는 400자까지 자르고 제어 문자는 뺍니다. 세션 파일 전체를 보내지는 않지만, **사용자가 쓴 글과 도구 인자·결과의 앞부분이 들어가므로 거기 있던 비밀값도 함께 전송될 수 있습니다.** 보낸 내용은 `<세션 id>.prompt.md`에 그대로 남습니다.
- **어떻게 도나**: `pi -p --no-session --no-tools --no-extensions`를 부모와 분리된 프로세스로 띄웁니다. 도구가 없어 파일을 읽거나 고칠 수 없고, 세션을 남기지 않습니다. 발췌는 명령줄 인자가 아니라 표준 입력으로 넘깁니다(`ps`에 보이지 않음). 부모 Pi가 종료돼도 계속 돌고, 답을 쓰면 스스로 끝납니다. 시간 제한(기본 5분, 1~60분)을 넘으면 종료를 요청하고(TERM) 5초 뒤 강제로 끝냅니다(KILL). 끝날 때 그 프로세스 그룹에 남은 것도 함께 정리합니다. 아무도 기다리지 않습니다.
- **다시 띄우지 않음**: 분석용 Pi는 설정이나 자동 탐색으로 잡히는 확장을 불러오지 않습니다(`--no-extensions`). 부모 Pi가 명령줄 `-e`로 받은 확장만 넘기는데, 그 안에 Calliopi가 있어도 `CALLIOPI_DEBRIEF=1`을 보고 아무것도 등록하지 않습니다(도구, goal, 메모, 또 다른 분석 모두 없음).
- **결과**: `<Pi agent dir>/calliopi-debriefs/`(0700)에 세션별로 기록(`.json`), 보낸 내용(`.prompt.md`), 답(`.md`), 종료 상태(`.exit`: 종료 코드 또는 `timeout`), stderr(`.md.log`)가 남습니다(모두 0600). 다음에 Pi를 시작하면 "지난 세션 debrief N건"을 알리고, `/cl-debrief`로 하나씩 봅니다. `npm run signals`에는 `## Debriefs`로 상태별 건수와 최근 결과의 요약 줄이 나옵니다. 알림과 결과는 사람에게만 보이고 모델 컨텍스트에 들어가지 않습니다.
- **모델**: 지정하지 않으면 세션을 돌린 모델이 자기 세션을 읽습니다. 모델은 자기 작업을 관대하게 보는 경향이 있으므로 다른 계열의 모델을 지정하는 편이 낫습니다.
- **설정**: `<Pi agent dir>/calliopi-agents.json` — `{ "debrief": { "enabled": true, "model": "provider/id", "timeoutMinutes": 5 } }`.
- **한계**:
  - 결과는 모델이 발췌를 읽고 쓴 의견입니다. 측정이 아니고, 맞는지 확인된 적이 없습니다.
  - 발췌는 짧습니다. 판단에 부족하면 "cannot tell"이라고 쓰게 했습니다.
  - 결과 파일은 자동으로 지우지 않습니다.
  - 종료 순간 `sh`가 없거나 Pi가 강제로 죽으면 분석이 시작되지 않거나 `결과 없음`으로 남습니다.
  - macOS와 Linux의 `sh`와 `ps`를 전제로 합니다.
  - 분석 모델이 설정에 설치된 확장이 제공하는 모델이면 분석용 Pi에서 찾지 못해 `오류`로 끝납니다. Pi에 기본으로 있는 provider의 모델을 `on provider/model`로 지정하세요.

## `/cl-agents`: 목록과 화면

```text
╭ 서브에이전트 · 실행 중 1 · 끝남 2 ┬ scout-1 ─────────────────────────────╮
│▸├─ ● scout-1 · read · 12초 · 턴 2 │┌──────────┬─────────────────────────┐│
│ │  └─ ○ verifier-1 · 시작 중 · 1초 ││ 상태     │ ● 실행 중 · read        ││
│ └─ ✓ reviewer-1 · 완료 · 1분 1초  │├──────────┼─────────────────────────┤│
│                                   ││ 과제     │ …                       ││
│                                   ││ 모델 · 맥락 · 예산 · 결과 · 근거 · 세션 ││
╰ ↑↓ 이동 · Enter: 화면 · x: 중지 · Esc: 닫기 ─────────────────────────────╯
```

- 왼쪽에 이 세션의 서브에이전트를 **goal별로**(열린 goal 맨 위에 펼침, 닫힌 goal은 접힘 — Enter로 펴기, goal 없는 것은 마지막) tree로(부모 아래 자식), 상태 기호(`● 실행 중`, `✓ 완료`, `◐ 일부`, `✗ 막힘/오류`, `⏱ 예산·무응답`, `■ 중지`, `? finish 없음`)와 함께 보여 주고, 오른쪽에 선택한 에이전트를 `@calliopi/ui/table` 표로 보여 줍니다(상태, 역할, 과제, 완료 조건, 모델, 맥락, 예산, 결과, 근거, 세션). goal 행을 고르면 goal(상태, 목표, 완료 조건, 진척, 사용량, 에이전트 수, 결과, 시각)을 보여 줍니다. 너비가 70칸 미만이면 표가 목록 아래로 갑니다. 상태는 0.5초마다 갱신합니다.
- **Enter**: 그 에이전트의 **실제 Pi 화면**을 창에 띄웁니다. 창 크기에 맞춰 자식이 다시 그리고, 입력은 그 자식 Pi로 갑니다(끼어들기, Esc로 중단). **ctrl+]**로 목록에 돌아오며 자식은 계속 실행됩니다(Esc는 자식에게 갑니다). 끝난 에이전트는 마지막 화면을(Esc로도 목록으로), 이 Pi가 실행하지 않은 에이전트(이전 세션)는 기록(과제, 결과, 세션 파일)을 보여 줍니다.
- **x**: 선택한 에이전트를 중지합니다(stop 요청 → 5초 안에 안 끝나면 종료).
- **e**: 선택한 goal(에이전트 행이면 그 goal)을 `<레지스트리>/exports/<goal>-….json`으로 내보냅니다: goal, 부모가 만든 위임 시점 요약, 서브에이전트 tree(계약, 상태, 결과, compaction 요약, 세션 파일). 부모가 본 결과와 자식이 한 일을 나란히 볼 수 있습니다.

## 위임 시점 요약과 배경 (`context: summary`, 역할 기본값)

요약은 매 턴 만들지 않고 **일을 맡기는 순간에만** 만듭니다. auto compaction과는 별개입니다.

- 마지막 위임 요약(없으면 마지막 compaction 요약) 이후의 메시지만, Pi가 compaction에 쓰는 요약기(`generateSummaryWithUsage`)로 이전 요약에 이어 갱신합니다. 형식도 같습니다(Goal, Constraints & Preferences, Progress, Key Decisions, Next Steps, Critical Context). 새 메시지가 없으면 요청 없이 이전 요약을 씁니다.
- 요약은 부모 세션에 `calliopi-summary` 항목으로 남습니다(모델 맥락에는 들어가지 않음). "맡길 때 부모가 무엇을 알고 있었나"의 기록입니다.
- 요약은 자식들이 시작하는 동안 **병렬로** 만들고, 한 번 만든 것을 역할에 맞게 잘라(Goal, Constraints & Preferences, Key Decisions, Critical Context. 파일을 바꾸는 역할은 Progress도. Next Steps는 부모의 할 일이라 보내지 않음) 각 자식의 inbox에 보냅니다. 자식은 과제보다 먼저 받거나(최대 10초 대기), 늦으면 steer로 받습니다.
- 요약이 실패하면 빈 배경을 보내 자식이 기다리지 않게 하고, 과제만으로 진행합니다.

## 자식 Pi

환경 변수 `CALLIOPI_AGENT_DIR`(에이전트 디렉터리)를 받고 시작한 Pi가 자식입니다. 같은 확장이 부모에서는 위임하는 쪽, 자식에서는 이 역할을 합니다.

```text
pi --session-dir <dir> --session-id <id> -e … --model <model> [--thinking …] \
   --tools <허용 도구>,finish --append-system-prompt <dir>/system-prompt.md
```

- **과제는 자식이 직접 제출합니다.** 명령줄에 과제를 넣으면 Pi가 바로 제출해 버려, 부모의 배경을 그 앞에 둘 수 없기 때문입니다. `context: summary`면 inbox에 배경이 오기를 최대 10초 기다렸다가(`배경 대기 중…`) 세션에 [배경][과제] 순으로 넣고, 늦으면 과제를 먼저 보내고 배경은 도착할 때 steer로 넣습니다(늦게 왔다고 표시).
- **세션 파일**은 부모가 미리 만들어 두고(`<시각>_<id>.jsonl`), 헤더의 `parentSession`이 부모 세션을 가리킵니다. Pi는 이 파일을 열어 이어 씁니다.
- **system prompt**: 서브에이전트 규칙(혼자 일함, 범위를 지킴, 끝나면 `finish`) + 역할 파일 본문.
- **계약 알림(목적 고정)**: 과제를 보낸 뒤 매 모델 요청의 맨 끝에 `[Subagent contract] Task … Done when … Budget used …`를 붙입니다. 세션에는 저장하지 않으므로 맥락이 길어지거나 compaction이 일어나도 목적이 항상 최근 위치에 보입니다. 알림은 매 요청 끝으로 옮겨 가므로, Anthropic 요청에서는 캐시 표시(`cache_control`)를 알림이 아니라 그 앞 메시지에 둡니다(`lib/cache.ts`). 알림에 표시가 있으면 매 요청이 대화 전체를 캐시에 다시 쓰고 한 번도 읽지 못합니다. 목적은 추론된 요약이 아니라 호출할 때 선언한 계약입니다.
- **`finish` 도구**: `status`(`done` | `partial` | `blocked`), `summary`, `evidence`, `artifacts`. 결과를 쓰고 실행을 끝냅니다(`terminate`).
- **finish 없이 멈추면** 한 번 상기시키고, 그래도 없으면 마지막 답을 요약 삼아 `unanswered`로 보고합니다. 자기가 background로 위임한 서브에이전트가 아직 돌고 있으면 기다립니다(상기도, 종료도, 무응답 판정도 하지 않음): 결과가 도착하면 깨어납니다.
- **inbox**(`inbox/NNNNNN.json`): `briefing`, `steer`, `stop`을 순번대로 한 번씩 받습니다(`delivered.json`의 id로 판별). 과제 전에 온 `steer`는 과제를 보낸 뒤에 전달합니다. 파일 변경 감지 + 1초 확인.
- **예산**: 턴이 끝날 때마다 확인하고(자기가 위임한 자식들이 쓴 토큰도 자기 몫으로 셉니다), 80%에 이르면 한 번 마무리하라고 알리고, 다 쓰면 중단해 `budget_exceeded`로 보고합니다. 도구가 실행 중이 아닌데 아무 이벤트가 없으면 `idle`입니다(긴 명령이나 자식을 기다리는 위임은 무응답이 아님).
- **기록**: `status.json`(상태, 현재 활동, 턴, 토큰, 배경 도착), `requests.jsonl`(provider로 보낸 요청 전부, 이전 요청과의 델타), `result.json`(한 번만).
- 토큰 예산은 새로 보낸 입력 + 출력 + 캐시 쓰기로 셉니다(캐시 읽기는 제외).

## 구조

```text
extensions/agents.ts   진입점: 최상위면 installParent, 자식이면 installChild (+ 위임할 수 있는 역할이면 installParent)
lib/parent.ts          subagent 도구: 검사, 승인, 기록, 동시 실행, background 알림(기본), foreground 대기
lib/catalog.ts         역할 파일 읽기 (기본 → 사용자 → 프로젝트)
lib/briefing.ts        위임 시점 요약: 입력 고르기, 역할별 자르기, 자식 inbox로 보내기
agents/                기본 역할: scout, reviewer
lib/child.ts           자식: finish 도구, 과제 제출, inbox, 예산, 기록
lib/contract.ts        자식에게 주는 문구: system prompt, 과제, 배경, 상기
lib/launch.ts          자식 준비: 세션 파일(parentSession), 실행 명령과 환경
lib/fleet.ts           자식들의 pseudo-terminal: 시작, 중지, 결과 없이 죽은 자식 기록, 부모와 함께 종료
lib/viewer.ts          /cl-agents: goal별 목록(tree), 오른쪽 표, 실제 화면 붙이기(ctrl+]로 떼기)
lib/goals.ts           Active Goal: 도구, /cl-goal, 목적 고정, 자동 계속과 안전장치, 닫을 때 정리
lib/gc.ts              보존 기간에 따른 기록 정리
lib/notes.ts           /cl-note: 세션 메모 쓰기와 최근 메모 보기
lib/harness.ts         하네스 버전(커밋, dirty)을 세션에 남기기
lib/debrief.ts         /cl-debrief: 세션이 끝난 뒤 분리된 Pi로 걸린 지점 분석, 결과 알림
lib/signals.ts         npm run signals: 역할 lint, 실행 집계, 최상위 세션 smell, 메모
lib/export.ts          goal 내보내기(JSON)
```

## 테스트

`npm test -w @calliopi/calliopi-agents`. 테스트 프로세스의 pseudo-terminal에 최상위 Pi와 자식 Pi를 demo의 faux 모델로 띄워(자식의 답은 `DEMO_CHILD_SCENARIO`) foreground 결과 반환, background 깨우기, `/cl-agents`(목록 → 화면 → 목록 → 닫기), goal(`/cl-goal` → 자동 시작 → 링크된 서브에이전트 → `goal_update done` → 더 이어 하지 않음), 세션 헤더의 `parentSession`, 위임 시점 요약(faux `completions`)과 잘린 배경이 과제보다 먼저 오는지, 그리고 배경 → 과제 순서, `finish`, inbox `stop`, 상기 후 `unanswered`를 확인합니다. faux 모델은 provider 요청(payload)을 만들지 않으므로 요청 기록은 handler를 직접 호출해 확인합니다. `/cl-note`는 Pi 대역(stand-in)으로 handler를 호출해 파일, 세션 entry, 알림을 확인하고 모델로 보낸 것이 없는지 봅니다. 하네스 버전 기록도 같은 방식으로 확인하고, 버전 읽기는 임시 git 저장소에서 확인합니다. debrief는 pseudo-terminal의 실제 Pi에 같은 메시지를 두 번 입력하고 종료한 뒤, 분리된 분석 Pi가 결과 파일을 쓰고 끝나는지, 그 Pi가 세션·분석·에이전트 기록을 남기지 않는지, 꺼져 있거나 smell이 없으면 아무것도 생기지 않는지 확인합니다. 시간 제한은 `pi` 자리에 셸 스크립트를 넣어 확인합니다.
