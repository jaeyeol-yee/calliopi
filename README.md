# Calliopi

Pi 위에 얹는 모듈형 로컬 하네스. 브랜드는 Calliopi, 내부 패키지는 역할을 드러내는 이름을 사용합니다.

현재는 **구조만 있는 스켈레톤**입니다. 실행되는 확장, 컨텍스트 주입, 사용자 정의 UI, 서브에이전트는 아직 구현하지 않았습니다.

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
    │   └── extensions/       # 기본 명령·초기화·공통 설정
    ├── context/
    │   ├── package.json
    │   ├── extensions/       # 컨텍스트 구성 로직
    │   ├── skills/           # 필요할 때 읽는 작업 지침
    │   └── prompts/          # 반복 요청 템플릿
    └── ui/
        ├── package.json
        ├── extensions/       # 상태 표시·알림·TUI
        └── themes/           # Pi 테마 JSON
```

각 리소스 디렉터리는 `.gitkeep`만 포함합니다. 예시 지침이나 no-op 확장을 자동 로드하지 않습니다.

## 패키지 연결 구조

```text
Pi settings의 packages 항목
          │ 로컬 경로 등록
          ▼
calliopi/package.json 의 pi manifest
          ├── packages/core/extensions
          ├── packages/context/{extensions,skills,prompts}
          └── packages/ui/{extensions,themes}
```

- Pi는 루트 manifest에 명시된 리소스 경로를 읽습니다. 하위 `package.json`의 `pi` 선언을 재귀 탐색하는 구조가 아닙니다.
- `workspaces`는 개발용 패키지 경계입니다. Pi의 리소스 발견과는 별개입니다.
- 하위 패키지에도 자체 `pi` 선언을 두어 각 패키지의 리소스를 설명합니다. 전체 하네스를 쓸 때는 루트만 등록하세요. 루트와 하위 패키지를 중복 등록할 필요가 없습니다.
- 현재 패키지 사이의 코드 의존성은 없습니다. 향후 필요하면 `context → core`, `ui → core` 방향으로 추가하고, `core`가 다른 두 패키지를 참조하지 않도록 합니다.
- manifest는 리소스 목록이지 실행 순서나 의존성 주입 설정이 아닙니다. 패키지 로딩 순서에 의존하는 초기화는 피합니다.

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
- 현재는 의존성과 빌드 단계가 없어 `npm install`이 필요 없습니다. 나중에 로컬 패키지에 의존성을 추가하면 별도로 설치해야 합니다.

## 확장 원칙

- **core**: 공통 타입·설정·기본 명령. 다른 패키지의 편의 기능을 모두 모으는 장소로 사용하지 않습니다.
- **context**: 모델이 읽을 지침·자료의 구성. 단순한 절차는 TypeScript 대신 skill이나 prompt로 유지합니다.
- **ui**: 표시와 입력. 실행 정책이나 컨텍스트 선택을 결정하지 않습니다.
- Pi가 제공하는 SDK 패키지는 필요해질 때 `peerDependencies`로 선언하고 번들에 포함하지 않습니다.
- 실행 기능은 실제 요구가 생겼을 때 추가합니다. 자동 reload, 서브에이전트, 오케스트레이션은 현재 범위 밖입니다.
