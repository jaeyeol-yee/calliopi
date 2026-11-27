# @calliopi/core

Calliopi의 가장 아래 계층입니다. 다른 패키지를 참조하지 않고, 화면 구현(pi-tui·PTY)에도 의존하지 않습니다. 프로그램 실행기(`RunProgram`)를 주입받으므로 Pi에서는 floating terminal pane이, 테스트에서는 가짜 실행기가 같은 코드를 돌립니다.

| export | 내용 |
|---|---|
| `@calliopi/core/fzf` | 번호 기반 fzf 선택 `fzfSelect`(검색어·커서 복원), `nodePreview`, `shellQuote`, 사용자 fzf 설정 무시 |
| `@calliopi/core/workflow` | 단계 스택 엔진 `runWorkflow` |
| `@calliopi/core/types` | `RunProgram`, `PtyRunResult` |
| `@calliopi/core/capture` | 출력을 받는 실행기 `Capture`, 기본 구현 `capture(timeoutMs)` (시간 제한, 프롬프트 금지) |
| `@calliopi/core/pr-lookup` | 현재 브랜치가 속한 PR 조회 `lookupPulls` |
| `@calliopi/core/usage` | 구독 사용량 strategy(`claude`, `codex`, `cursor`), `fetchUsage`, `defaultEnv` |
| `@calliopi/core/multiplexer` | 터미널 멀티플렉서 strategy(`rex`, `herdr`, `tmux`), `detectMultiplexer`, `openSidePane` |
| `@calliopi/core/agents` | 서브에이전트 기록: 레지스트리(`createAgent`, `postInbox`, `writeResult`), 예산과 상속(`budgetFor`, `remaining`, `exceeded`), goal(`moveGoal`, `listGoals`, `planPrune`), 역할 카탈로그(`parseRole`, `mergeCatalog`, `roleGuidelines`), 위임 규칙(`mayDelegate`, `resolveModel`, `resolveTools`), 종료 분류(`classifyEnd`), 요청 델타 기록(`encodeRequest`, `decodeRequests`), tree(`buildTree`, `treeRows`) |
| `@calliopi/core/notes` | 세션 메모: `appendNote`, `readNotes`, `formatNotes`. `<Pi agent dir>/calliopi-notes.jsonl`에 한 줄에 하나씩(0600) |
| `@calliopi/core/web` | `web_fetch` 엔진: 주소 정책(`isPublicAddress`), URL 검사(`checkUrl`), 호스트 규칙(`decide`), `fetchPage`, HTML→텍스트(`htmlToText`), 페이징·캐시·비신뢰 포장(`readPage`) |

## PR 조회

`lookupPulls({ cwd, run, parents })`는 현재 브랜치의 작업이 어느 PR에 들어 있는지 찾습니다. 브랜치 이름이 아니라 **커밋**으로 찾습니다. 같은 브랜치를 fork와 upstream에 함께 올렸거나, 다른 이름으로 push했거나, 머지 후 지운 경우에도 찾을 수 있습니다.

- 후보 저장소: 모든 GitHub remote(github.com)와 각 fork의 부모 저장소(`gh api repos/{repo}`의 `parent`, `parents` Map에 캐시).
- 후보 커밋: `HEAD`와 `@{push}`. push하지 않은 커밋은 GitHub에 없으므로(422) 마지막으로 push한 커밋으로 찾습니다. `ahead`는 push하지 않은 커밋 수입니다.
- `gh api repos/{repo}/commits/{sha}/pulls` 결과 중 **head가 우리 커밋이거나 head 브랜치 이름이 우리 브랜치 이름인** PR만 남깁니다. main의 머지 커밋은 머지한 PR에 속하지만, 그렇다고 main이 그 PR의 브랜치는 아니기 때문입니다.
- 상태: `open`, `draft`, `merged`(`merged_at` 있음), `closed`. 이 순서로, 같으면 최근 갱신 순으로 정렬합니다.
- `git`·`gh`는 주입한 `Capture`로 실행합니다. 테스트는 가짜 `Capture`를 씁니다.

## 워크플로우

각 단계는 fzf 목록 하나입니다. 항목을 고르면 `onSelect`가 다음 중 하나를 돌려줍니다.

| 반환 | 동작 |
|---|---|
| `{ next: step }` | 다음 단계로 |
| `'stay'` | 같은 단계를 다시 띄움 (예: 프로그램을 실행한 뒤) |
| `{ done: value }` | 워크플로우 종료, `value` 반환 |

- `Esc`는 한 단계 돌아가며 그 단계의 검색어와 커서를 복원합니다(검색어가 없을 때만 커서 위치). 첫 단계에서 `Esc`를 누르면 `null`로 끝납니다.
- `cancelled()`가 참이면(overlay가 닫힘) fzf와 `onSelect` 뒤마다 `null`로 끝납니다. 중간에 죽은 fzf의 깨진 출력보다 취소가 우선합니다.
- 항목은 번호로만 주고받습니다. 미리보기는 `nodePreview(script, stateFile)`로 만들고, 스크립트는 마지막 인자로 번호를 받습니다.

```ts
const step: WorkflowStep<string> = {
  name: 'files', prompt: 'File > ', items: files, preview: nodePreview(previewScript, listFile),
  async onSelect({ index }, io) { await io.run('vim', ['--', files[index]]); return { done: files[index] }; },
};
const picked = await runWorkflow(step, { run, directory, setFooter, cancelled });
```

사용 예: `calliopi-workflows`의 `lib/editor-flow.ts`(파일 → Vim), `lib/git-log.ts`의 `browseLog`(커밋 → 파일 → pager).

## 터미널 멀티플렉서

Pi는 자기 화면을 나눌 수 없어서(overlay는 대화 기록을 가립니다) 옆에 띄우는 화면은 멀티플렉서 pane에 엽니다. 멀티플렉서마다 strategy 하나가 `openSide`(오른쪽에 새 pane)와 `moveBeside`(있는 pane을 오른쪽으로)를 구현합니다.

- **판정**: 지금 Pi가 들어 있는 멀티플렉서, 즉 **조상 프로세스 중 가장 가까운** `rex`·`herdr`·`tmux`를 씁니다(`ps -A -o pid=,ppid=,comm=` 한 번). 멀티플렉서는 중첩되고(tmux 안의 herdr, Rex 안의 tmux) 환경 변수를 물려주므로 환경 변수만으로는 고를 수 없습니다. pane id는 그 멀티플렉서의 환경 변수에서 읽습니다.
- `ps`가 실패하거나 아무것도 찾지 못하면 환경 변수로 Rex → herdr → tmux 순서입니다. `CALLIOPI_MULTIPLEXER=rex|herdr|tmux`로 강제할 수 있습니다.

| | 이 pane | 새 pane | 프로그램 종료 후 유지(`keepOpen`) |
|---|---|---|---|
| Rex | `REX_SESSION`, `REX_BLOCK` | `rex split --split=right -- 명령…` | `--keep-open` |
| herdr | `HERDR_PANE_ID`, `HERDR_SOCKET_PATH` | `herdr pane split` 뒤 `pane run`으로 실행 스크립트 한 줄 | 사용자 셸이 남음 |
| tmux (3.1+) | `TMUX`, `TMUX_PANE` | `tmux split-window -h -l N% -- 명령…` | 종료 후 Enter를 기다리는 `sh`로 감쌈 |

- herdr의 split은 명령을 받지 않고 사용자 셸을 띄웁니다. `pane run`은 그 셸에 한 줄을 입력하므로, 프로그램과 인자는 POSIX quoting한 임시 스크립트(실행되면 스스로 지움)에 쓰고 셸에는 ` exec sh '<스크립트>'`만 보냅니다. zsh·fish 등 셸 문법과 무관하고, 앞의 공백으로 셸 history에 남지 않습니다. herdr의 `--ratio`는 나뉘는 쪽 pane이 차지하는 비율이라 `1 − 비율`을 넘깁니다.
- tmux의 `remain-on-exit`은 split 뒤에 설정하면 빨리 끝나는 프로그램과 경합하므로 쓰지 않습니다.

## 서브에이전트 기록

부모 Pi가 맡긴 일을 자식 Pi가 부모의 pseudo-terminal에서 하고 결과를 돌려줍니다. 부모, 자식, viewer는 서로 직접 통신하지 않고 **레지스트리의 같은 기록**을 봅니다: `<root>/<최상위 세션 id>/<agent id>/`(0700)에 `meta.json`(부모가 쓴 호출), `status.json`(자식의 진행), `result.json`(한 번만, 먼저 쓴 쪽이 남음), `inbox/NNNNNN.json`(부모 → 자식, 순번대로), `delivered.json`(자식이 받은 마지막 순번과 id), `requests.jsonl`(모델 요청), `session.jsonl`(자식의 Pi 세션).

- **예산은 재귀의 줄어드는 인자처럼**: 자식의 예산은 요청 → 역할 기본값 → `DEFAULT_BUDGET` 순으로 정하고, `MAX_BUDGET`과 **부모의 남은 예산**을 넘지 못합니다(`budgetFor`). 무응답 시간은 소모되지 않으므로 상속하지 않습니다.
- **위임 규칙**: 최상위 Pi는 모든 역할에, 자식은 역할 파일의 `allowed_subagents`에 있는 역할에만, 최대 깊이(기본 2) 미만에서만 위임합니다. 모델은 고정된 역할 → 호출자 → 역할 기본값 → 부모 순. 도구는 부모의 도구 중에서만 고르고 `disallowed_tools`를 뺍니다.
- **종료**: 자식이 `finish`로 보고하면 그 판정(`done`, `partial`, `blocked`)을, 아니면 하네스가 본 것(`error` → `drifted` → `budget_exceeded` → `idle` → `stopped` → `unanswered`)을 씁니다. `finish` 없이 끝나면 부모에게 "확인된 결과가 아니다"라고 알립니다.
- **요청 기록**: Pi의 `before_provider_request` payload를 순서대로 남기되, 이전 요청과 같은 최상위 키는 생략하고 배열(messages 등)은 같은 앞부분의 길이와 새 꼬리만 저장합니다. provider 형식에 의존하지 않습니다.
- **goal**(`goals.ts`): 세션의 열린 goal은 하나(`active` ↔ `paused` → `done` | `abandoned`, 닫힌 goal은 다시 열 수 없음). `goals/<id>.json`에 저장하고, 에이전트의 `meta.goal`이 링크입니다. `goalOverBudget`은 goal 자신과 링크된 에이전트의 토큰을 함께 셉니다.
- **정리 계획**(`planPrune`): 끝난 에이전트의 `requests.jsonl`은 `requestsDays`, 디렉터리 전체는 `recordsDays`가 지나면 지웁니다. 기준은 goal이 닫힌 시각(goal이 없거나 사라졌으면 자기가 끝난 시각)이고, 실행 중이거나 열린 goal의 것은 건드리지 않습니다. `staleGoals`는 남은 에이전트가 없는 오래된 goal입니다.
- **역할 카탈로그**: YAML 파싱은 호출자(Pi `parseFrontmatter`)가 하고, 여기서는 값을 역할로 정규화합니다. `when`/`not_when`은 `roleGuidelines`로 도구 이름을 명시한 system prompt 규칙이 됩니다.

## 구독 사용량

provider마다 `UsageStrategy`(`fetch(env) → UsageSnapshot`)를 하나씩 둡니다([OpenUsage](https://github.com/robinebers/openusage)의 provider runtime을 참고). strategy는 이 컴퓨터에 이미 있는 로그인을 찾아 사용량 API를 읽고, gauge로 그릴 수 있는 `UsageMetric`(`used`, `limit`, `unit`, `resetsAt`, `periodMs`)으로 바꿉니다.

| provider | 인증 정보 (먼저 찾은 것) | 읽는 것 |
|---|---|---|
| Claude | Pi의 Anthropic OAuth 로그인 → `~/.claude/.credentials.json` → macOS Keychain `Claude Code-credentials` | `api/oauth/usage`: 5시간·주간, **모델별 주간 한도(Fable 등, 비활성도 표시)**, 추가 사용 / `api/oauth/profile`: 요금제 |
| Codex | `$CODEX_HOME/auth.json` (ChatGPT 로그인) | `wham/usage`: 5시간·주간 창, 추가 모델 한도, 크레딧, 요금제 |
| Cursor | Cursor 앱 `state.vscdb`의 `cursorAuth/accessToken` (`sqlite3 -readonly`) | OpenUsage와 같은 행을 퍼센트로: **전체**(`totalPercentUsed`, 결제 주기 리셋). 통합 요금제(Cursor·X·Grok)면 주간 풀 대비 **제품별(Grok Bot, Cursor)** 퍼센트(OpenUsage에는 없는 추가 행), 월 추가 사용, 크레딧 잔액. 별도 요금제면 Cursor 모델·기타 모델, **Grok Bot**(`GetSandUsageStatus`), 결제 주기의 추가 사용 |

- **읽기만 합니다.** 다른 도구의 토큰을 갱신하지 않습니다(갱신하면 그 도구의 로그인이 무효가 될 수 있음). 만료되면 그 도구를 한 번 실행하라고 안내합니다. Pi 로그인은 Pi가 직접 갱신합니다.
- 모든 지표에 리셋 시각(`resetsAt`)과 창 길이(`periodMs`)가 있으면 담습니다.
- 한 provider가 실패해도 나머지는 그대로 나오고, 실패한 provider는 `error`에 이유를 담습니다.
- 파일·명령·HTTP는 `UsageEnv`로 주입합니다. 테스트는 가짜 환경을 씁니다.

## 기본 도구: web_fetch

`extensions/web-fetch.ts`가 모든 Pi(자식 포함)에 `web_fetch({ url, offset?, limit? })`를 등록합니다. `read`의 URL판입니다. 요약하지 않고 원문 텍스트를 창 단위(기본 20,000자, 최대 100,000자)로 돌려주며, 머리말에 읽은 범위와 이어 읽을 `offset`을 적습니다.

- 끌 수 없는 안전 장치(엔진, `lib/web/`):
  - http(s)만, 자격 증명 URL 거부.
  - 공인 인터넷 주소만 허용. IPv4 특수 대역 전부를 거부하고, IPv6는 2000::/3 중 특수 대역을 뺀 것만 허용합니다(IPv4-mapped는 안의 IPv4로 판정).
  - 이름은 직접 해석해 모든 주소를 검사하고, 검사한 주소로만 연결합니다(DNS rebinding 방지).
  - 같은 origin 안의 리다이렉트(같은 호스트의 http→https 포함)만 따라가며 홉마다 재검사합니다. 다른 origin이면 따라가지 않고 그 URL을 알려 줍니다.
  - 압축 해제 후 5MB에서 자르고, 전체 30초 제한. 텍스트 형식(HTML, text/*, JSON, XML 등)만 받습니다. 제어 문자와 방향 제어 문자는 지웁니다.
  - 결과 본문은 호출마다 새 nonce를 붙인 태그로 감싸 "신뢰할 수 없는 웹 내용"으로 표시합니다. 페이지가 태그를 닫을 수 없습니다.
  - 10분, 32개, 800만 자 한도의 LRU 캐시. `offset`으로 이어 읽으면 같은 텍스트를 봅니다.
- 사용자 정책(선택): `<agentDir>/calliopi-web.json`에 `{ "allow": [], "deny": [], "ask": [] }`(호스트 패턴: `example.com`, `*.example.com`, `*`). deny가 우선, allow 목록이 있으면 일치해야 하고, ask는 세션마다 호스트당 한 번 묻습니다. 파일이 없으면 모든 공인 호스트를 묻지 않고 허용합니다(`read`가 파일마다 묻지 않는 것과 같음). 파일이 깨져 있으면 전부 막습니다.
- `bash`의 `curl`은 막지 않습니다. 웹 내용만 읽힐 역할은 `bash` 없이 `web_fetch`를 주세요.
