# @calliopi/core

Calliopi의 가장 아래 계층입니다. 다른 패키지를 참조하지 않고, 화면 구현(pi-tui·PTY)에도 의존하지 않습니다. 프로그램 실행기(`RunProgram`)를 주입받으므로 Pi에서는 floating terminal pane이, 테스트에서는 가짜 실행기가 같은 코드를 돌립니다.

| export | 내용 |
|---|---|
| `@calliopi/core/fzf` | 번호 기반 fzf 선택 `fzfSelect`(검색어·커서 복원), `nodePreview`, `shellQuote`, 사용자 fzf 설정 무시 |
| `@calliopi/core/workflow` | 단계 스택 엔진 `runWorkflow` |
| `@calliopi/core/types` | `RunProgram`, `PtyRunResult` |

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
