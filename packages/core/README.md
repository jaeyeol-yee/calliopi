# @calliopi/core

Calliopi의 가장 아래 계층입니다. 다른 패키지를 참조하지 않고, 화면 구현(pi-tui·PTY)에도 의존하지 않습니다. 프로그램 실행기(`RunProgram`)를 주입받으므로 Pi에서는 floating terminal pane이, 테스트에서는 가짜 실행기가 같은 코드를 돌립니다.

| export | 내용 |
|---|---|
| `@calliopi/core/fzf` | 번호 기반 fzf 선택 `fzfSelect`(검색어·커서 복원), `nodePreview`, `shellQuote`, 사용자 fzf 설정 무시 |
| `@calliopi/core/workflow` | 단계 스택 엔진 `runWorkflow` |
| `@calliopi/core/types` | `RunProgram`, `PtyRunResult` |
| `@calliopi/core/capture` | 출력을 받는 실행기 `Capture`, 기본 구현 `capture(timeoutMs)` (시간 제한, 프롬프트 금지) |
| `@calliopi/core/pr-lookup` | 현재 브랜치가 속한 PR 조회 `lookupPulls` |

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
