# Calliopi

Pi 위에 얹는 모듈형 로컬 하네스. 브랜드는 Calliopi, 내부 패키지는 역할을 드러내는 이름을 사용합니다.

현재 Cursor Cloud Agents 팬아웃·추적 확장과 Pi 내부 floating terminal 워크플로우(파일 편집, git 기록 탐색)를 제공합니다. `context`는 아직 스켈레톤입니다.

## 이름의 유래

**Calliopi**는 **회전목마에 흐르는 음악**에서 출발한 이름입니다. 일부 증기식 회전목마에서도 사용된 악기 **calliope**의 끝을 **pi**로 바꾸어, 기반 런타임인 Pi와 연결했습니다.

회전목마에서는 말들이 각자의 움직임을 가지면서도 하나의 틀 안에서 함께 돕니다. Calliopi는 그 곁에서 흐르는 음악처럼, Pi 위의 여러 기능에 일관된 흐름과 사용 경험을 더하는 하네스를 지향합니다.

브랜드에는 회전목마의 이미지를 남기되, 내부 패키지는 `core`, `context`, `ui`처럼 역할이 드러나는 이름을 사용합니다. npm·GitHub·도메인 이름의 사용 가능 여부는 확인하지 않았습니다.

참고: [Calliope](https://en.wikipedia.org/wiki/Calliope_(instrument)), [Fairground organ](https://en.wikipedia.org/wiki/Fairground_organ).

## 구조

```text
calliopi/
├── package.json              # 유일한 Pi 설치 진입점 + npm workspace
└── packages/
    ├── core/
    │   ├── package.json
    │   ├── lib/              # fzf 선택·실행기 타입 (의존성 없음)
    │   └── extensions/       # 기본 명령·초기화·공통 설정
    ├── context/
    │   ├── package.json
    │   ├── extensions/       # 컨텍스트 구성 로직
    │   ├── skills/           # 필요할 때 읽는 작업 지침
    │   └── prompts/          # 반복 요청 템플릿
    ├── ui/
    │   ├── package.json
    │   ├── lib/              # floating terminal·표·키 입력 부품
    │   ├── extensions/       # 대화 기록 헤더
    │   └── themes/           # Pi 테마 JSON
    ├── calliopi-fanout/      # Cursor Cloud Agents 팬아웃·추적 (Pi 확장·rex 레이어 포함)
    └── calliopi-workflows/   # fzf 워크플로우: /calliopi-edit, /calliopi-log
```

`calliopi-fanout`은 Pi manifest에 등록된 확장으로 `/calliopi-fanout` 명령과 도구를 제공합니다. 독립 CLI와 rex pane에서도 사용할 수 있습니다. 사용법은 [packages/calliopi-fanout/README.md](packages/calliopi-fanout/README.md)를 보세요.

`calliopi-workflows`의 `/calliopi-edit`는 Pi floating terminal에서 fzf로 파일 하나를 골라 Vim으로 편집하고, 변경분을 다음 대화에 전달합니다. `/calliopi-log`는 같은 창에서 커밋 → 변경 파일 → diff를 탐색합니다. 사용법은 [packages/calliopi-workflows/README.md](packages/calliopi-workflows/README.md)를 보세요.

`ui`는 대화 기록의 사용자 입력과 Pi 답변 앞에 헤더를 붙입니다(`/calliopi-headers`). 사용법은 [packages/ui/README.md](packages/ui/README.md)를 보세요.

`core/extensions`와 `context`의 리소스 디렉터리는 `.gitkeep`만 포함합니다. 예시 지침이나 no-op 확장을 자동 로드하지 않습니다.

## 패키지 연결 구조

```text
Pi settings의 packages 항목
          │ 로컬 경로 등록
          ▼
calliopi/package.json 의 pi manifest
          ├── packages/core/extensions
          ├── packages/context/{extensions,skills,prompts}
          ├── packages/ui/{extensions,themes}
          ├── packages/calliopi-fanout/extensions
          └── packages/calliopi-workflows/extensions
```

- Pi는 루트 manifest에 명시된 리소스 경로를 읽습니다. 하위 `package.json`의 `pi` 선언을 재귀 탐색하는 구조가 아닙니다.
- `workspaces`는 개발용 패키지 경계입니다. Pi의 리소스 발견과는 별개입니다.
- 하위 패키지에도 자체 `pi` 선언을 두어 각 패키지의 리소스를 설명합니다. 전체 하네스를 쓸 때는 루트만 등록하세요. 루트와 하위 패키지를 중복 등록할 필요가 없습니다.
- 패키지 사이의 코드 의존성은 아래 계층을 따릅니다.

### 계층

```text
app       calliopi-fanout    calliopi-workflows     명령·도구 등록, 무엇을 할지 결정
              │                 │        │
ui, context   ui ◄──────────────┘        │           화면과 입력 / 모델이 읽을 자료
              │                          │
core          core ◄─────────────────────┘           fzf 선택·워크플로우 엔진·실행기 타입 (의존성 없음)
```

- 각 패키지는 `package.json`의 `"calliopi": { "layer": … }`로 계층(`core`, `ui`, `context`, `app`)을 선언합니다.
- **자기보다 낮은 계층만 import합니다.** 그래서 application끼리(`calliopi-fanout` ↔ `calliopi-workflows`), `ui` ↔ `context`는 서로 참조하지 않고 `core`는 아무것도 참조하지 않습니다. 둘이 함께 쓸 것이 생기면 아래 계층으로 내립니다.
- 새 애플리케이션은 `app` 계층의 새 패키지로 만들고 루트 manifest에 `extensions` 경로를 추가합니다.

### import 규칙

상대 경로(`./`, `../`) import는 쓰지 않습니다. `npm run check:imports`가 아래 규칙을 검사합니다.

| 대상 | 쓰는 형태 | 근거 |
|---|---|---|
| 같은 패키지 | `#lib/util.ts`, `#extensions/…`, `#test/…` | 그 패키지 `package.json`의 `imports` |
| 다른 패키지 | `@calliopi/ui/table` | 더 낮은 계층의 `exports`에 있는 경로만, 내 `dependencies`에 선언 후 |

- `exports`에 없는 내부 파일(`@calliopi/ui/lib/…`)은 Node가 `ERR_PACKAGE_PATH_NOT_EXPORTED`로 막습니다. 공개할 것만 `exports`에 추가합니다.
- `#` 별칭은 **그 파일이 속한 패키지** 기준으로 풀립니다. fanout이 불러온 `@calliopi/ui/table` 안의 `#lib/…`는 ui의 `lib`입니다(Node와 Pi 로더 양쪽에서 확인).
- 패키지 디렉터리를 가로지르는 경로, 자기 패키지 이름으로 자기를 import하기, 패키지 간 순환도 검사에서 실패합니다.
- 실행용 파일 경로(`new URL('../bin/x.ts', import.meta.url)`)는 import가 아니라 같은 패키지 안의 파일 위치이므로 그대로 둡니다.
- manifest는 리소스 목록이지 실행 순서나 의존성 주입 설정이 아닙니다. 패키지 로딩 순서에 의존하는 초기화는 피합니다.

## 요구 사항

최소 버전은 코드가 실제로 쓰는 옵션·기능이 처음 들어간 릴리스입니다. 판정 근거는 각 프로젝트의 changelog·릴리스 노트이고, 표에 **실측**이라고 쓴 항목은 해당 릴리스 바이너리로 경계 버전을 직접 실행해 확인했습니다. 실행 시점에는 도구가 `PATH`에 있는지만 검사하고 버전은 검사하지 않습니다.

### 실행 환경

| 항목 | 최소 | 근거 |
|---|---|---|
| OS | macOS, Linux | floating terminal(PTY)은 Windows를 지원하지 않습니다 |
| Node.js | 22.18.0 (23 계열은 23.6.0) | `.ts`를 빌드 없이 실행합니다. type stripping이 기본으로 켜진 버전입니다(Node changelog) |
| npm | Node에 포함된 버전 | workspaces 설치·실행 |
| Pi | 1.5.2에서 검증 | 하한은 확인하지 않았습니다. 대화 헤더는 Pi 내부 컴포넌트에 기대므로 Pi를 올리면 `npm run check`로 확인하세요 |
| `node-pty` 빌드 | prebuilt 또는 C/C++ 빌드 도구 | 네이티브 의존성입니다. prebuilt가 없는 플랫폼에서는 로컬 빌드합니다 |

### CLI 도구: `calliopi-workflows` (`/calliopi-edit`, `/calliopi-log`)

| 도구 | 쓰는 곳 | 필수 | 최소 버전 | 버전을 정한 기능 | 확인 |
|---|---|---|---|---|---|
| fzf | 두 명령 | 필수 | **0.37.0** | `load` 이벤트·`pos()` 동작(커서 복원) 0.36.0, `focus` 이벤트(분할 화면) 0.37.0 | 실측: 0.27–0.46.1 바이너리로 실제 명령 파싱 + PTY 테스트. 0.36.0은 분할 화면만 실패 |
| ripgrep | `/calliopi-edit` 파일 목록 | 필수 | 0.2.1 | `--files --null` | changelog |
| Vim | `/calliopi-edit` 편집기 | 필수 | 제약 없음 | `vim -- <file>`만 사용 | — |
| git | `/calliopi-log` | 필수 | 1.8.2 (권장 2.15.0) | `GIT_LITERAL_PATHSPECS` 1.8.2. `GIT_OPTIONAL_LOCKS` 2.15.0은 낮은 버전에서 무시되어 lock 최적화만 빠집니다 | release notes, 태그별 소스 |
| less | `/calliopi-log` pager | 필수 | 346 | `-R` 346, `LESSSECURE` 321 | NEWS |
| delta | `/calliopi-log` pager | 선택 | 0.4.4 | `DELTA_PAGER`. 낮은 버전은 `BAT_PAGER`/`PAGER`를 써서 pager가 바뀔 수 있습니다 | 실측: 0.4.3 / 0.4.4 |
| bat | `/calliopi-edit` 미리보기 | 선택 | 0.5.0 | `--line-range`. 낮거나 없으면 색 없는 텍스트로 대체합니다 | 실측: 0.4.1 / 0.5.0 |

### 선택: `calliopi-fanout`

팬아웃을 쓰지 않으면 필요 없습니다.

| 항목 | 최소 | 근거·비고 |
|---|---|---|
| Cursor 계정과 API 키 | — | `CURSOR_API_KEY` 또는 `~/.cursor/sdk/auth.json` |
| `@cursor/sdk` | 1.3.1 | 브라우저 로그인 경로에서만 씁니다(선택 의존성) |
| gh (로그인 필요) | **2.18.0** | PR 상태·diff·merge·`@cursor` 댓글. `pr merge --match-head-commit` 2.13.0, `auth token` 2.17.0, `pr view --json headRefOid` 2.18.0. 실측: 1.14–2.40 바이너리 + release notes |
| git | 1.8.5 | 원격 작업 비교에 `git -C` 사용(release notes) |
| rex | 확인하지 않음 | 선택. 현황 pane 배치(`show`, `up`)와 외부 diff 리뷰(`r`)에만 씁니다 |
| delta | 0.0.17 | 선택. 외부 diff 리뷰(`r`)는 `delta --paging=always`만 씁니다(release notes) |

### 개발·테스트

- 테스트는 임시 저장소를 `git init -b`로 만들어서 **git 2.28.0** 이상이 필요합니다.
- 실제 fzf·Vim·pager 테스트는 도구가 없으면 건너뜁니다.
- smoke test(`npm run smoke -w @calliopi/calliopi-workflows`)는 설치된 `pi` 바이너리가 필요합니다(`PI_BINARY`로 경로 지정).

## 로컬 등록과 수정 반영

한 번 등록합니다. 이 스켈레톤 생성 과정에서는 아래 명령을 실행하지 않았습니다.

```bash
pi install ~/agent-labs/calliopi
```

이미 실행 중인 Pi에서는 설치 후 `/reload`를 입력합니다. Pi 입력창에서 설치하려면 `!pi install ~/agent-labs/calliopi`를 사용할 수 있습니다.

이후에는:

```text
하위 리소스 파일 수정 → /reload → 현재 세션에서 다시 로드
```

- 로컬 패키지는 복사하지 않고 원본 경로를 직접 참조합니다. symlink와 반복 설치가 필요 없습니다.
- 저장 즉시 자동 반영되는 HMR은 아닙니다. `/reload`는 확장 런타임을 다시 구성하며 메모리 상태 보존을 보장하지 않습니다.
- 리소스 경로를 추가하거나 바꾸면 루트 manifest도 수정한 뒤 `/reload`합니다.
- 향후 빌드 결과물(`dist/`)을 참조하게 되면 수정 후 재빌드가 필요합니다. 외부 의존성의 모든 캐시까지 무효화된다고 가정하지 않습니다.
- 의존성과 workspace 링크는 루트에서 `npm install`로 설치합니다. 별도 빌드 단계는 없습니다.

## 검사

루트에서 모든 패키지를 한 번에 검사합니다. 스크립트가 없는 패키지(`context`)는 건너뜁니다.

| 명령 | 내용 |
|---|---|
| `npm run check:imports` | import 규칙·계층 검사 |
| `npm run typecheck` | 각 패키지 `tsc -p .` |
| `npm test` | 각 패키지 `node --test` |
| `npm run check` | 위 세 가지를 순서대로, 첫 실패에서 중단 |

한 패키지만 돌리려면 `npm test -w @calliopi/ui`처럼 `-w`를 붙입니다.

## 확장 원칙

- **core**: 실행 메커니즘(fzf 선택, 워크플로우 엔진, 실행기 타입)과 공통 설정. 화면 구현(pi-tui·PTY)에 의존하지 않고 실행기를 주입받습니다. 다른 패키지의 편의 기능을 모두 모으는 장소로 사용하지 않습니다.
- **context**: 모델이 읽을 지침·자료의 구성. 단순한 절차는 TypeScript 대신 skill이나 prompt로 유지합니다.
- **ui**: 표시와 입력. 실행 정책이나 컨텍스트 선택을 결정하지 않고, 명령을 등록하지 않는 부품(overlay, 터미널, 표)을 `exports`로 제공합니다. 대화 기록 헤더처럼 표시 방식 자체인 설정 명령은 예외입니다.
- **app**: 사용자가 쓰는 기능. 명령·도구를 등록하고 아래 계층을 조합합니다. 팬아웃은 `calliopi-fanout`, fzf 워크플로우는 `calliopi-workflows`가 제공합니다.
- Pi가 제공하는 SDK 패키지는 필요해질 때 `peerDependencies`로 선언하고 번들에 포함하지 않습니다. 자동 reload는 현재 범위 밖입니다.
