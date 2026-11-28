# Claude Code 클라우드 환경

Claude Code 클라우드 세션(claude.ai/code)에서 calliopi를 개발·테스트하기 위한 설정입니다. 기본 이미지를
Dockerfile로 바꿀 수는 없으므로([공식 문서](https://code.claude.com/docs/en/cloud-environments)), 두 가지로 나눕니다.

| | 환경 setup script | 저장소 SessionStart hook |
|---|---|---|
| 파일 | [`scripts/cloud-setup.sh`](../scripts/cloud-setup.sh) | [`.claude/settings.json`](../.claude/settings.json) → [`scripts/cloud-install.sh`](../scripts/cloud-install.sh) |
| 설정 위치 | claude.ai/code 환경 설정의 **Setup script** (붙여넣기 또는 Choose file) | 저장소에 커밋됨. 따로 할 일 없음 |
| 하는 일 | 시스템 도구: fzf, less, 빌드 도구, Node ≥ 22.18, 데모 녹화(VHS) | `npm ci` (입력 파일이 바뀌었을 때만) |
| 실행 | Claude Code 시작 전, root, Ubuntu 24.04. 5분 안에 끝나면 **스냅샷으로 캐시** | 매 세션 시작·재개. 로컬에서는 아무것도 하지 않음(`CLAUDE_CODE_REMOTE`) |

## 1. 환경 만들기

claude.ai/code → 메시지 입력창 아래 환경 선택기 → 환경 추가.

| 항목 | 값 |
|---|---|
| 이름 | `calliopi` |
| Network access | **Limited** + **Allow package managers** (기본값) |
| Setup script | `scripts/cloud-setup.sh` 내용 |
| Environment variables | (선택) `BASH_DEFAULT_TIMEOUT_MS=600000` — 명령 기본 제한 2분을 10분으로 |

환경변수는 환경을 쓰는 사람 모두가 읽을 수 있으므로 비밀값을 넣지 마세요.

## 2. 확인 (첫 세션에서 Claude에게 요청)

1. `node -v` → 22.18 이상
2. `cat node_modules/.cloud-install.sha256` → 파일이 있으면 `npm ci` 성공. 없으면 `npm ci`를 직접 실행해 오류 확인
3. `npm run check` → 실패 0, **skip 0**. `rg/fzf/vim required` 같은 skip은 setup script가 덜 설치한 것

## 3. 무엇이 필요하고 왜

| 필요 | 이유 | 기본 이미지 | 처리 |
|---|---|---|---|
| Node ≥ 22.18 | `.ts` 소스를 바로 실행 (`engines`) | Node 22 (세부 버전 미공개) | 낮으면 npm 레지스트리의 `node-linux-<arch>@22`로 `bin/node`와 헤더를 교체 (`nodejs.org`는 허용 목록 밖) |
| 빌드 도구 (make, g++, python3) | node-pty 1.1.0에 Linux prebuilt가 없어 소스 빌드 | GCC, Python 있음 | `build-essential`, `python3` 보장 |
| Node 헤더 | node-gyp가 기본으로 `nodejs.org`에서 받음 → 차단됨 | Node 설치에 포함 | hook이 `npm_config_nodedir`로 설치된 헤더를 가리킴 |
| fzf, less | PTY 테스트(`editor-pty`, `git-log`, `preview-*`) | 없음 | apt 설치 |
| git, ripgrep, vim | 같은 테스트 | 있음 | — |
| VHS, ttyd, ffmpeg, fd, CJK 폰트 | `npm run demo` 녹화 | 없음 | apt 설치, VHS는 버전을 고정해 GitHub release `.deb`로 설치 (`api.github.com`은 차단, release 다운로드는 허용). `DEMO_FONT_FAMILY`는 `/etc/profile.d/calliopi-demo.sh` |
| `gh` 로그인, API 키 | 불필요 | — | 테스트는 가짜 실행기와 faux 모델 사용 |

`npm ci`는 루트와 workspace의 의존성(Pi 1.7.0, `@cursor/sdk`, `node-pty`, `@xterm/headless`, TypeScript 등 144개)을
lock 그대로 설치하고, `node-pty` 빌드와 `@calliopi/ui`의 `postinstall`(spawn-helper 실행 권한)을 실행합니다.

## 4. 운영

| 상황 | 동작 |
|---|---|
| `package-lock.json`, workspace `package.json`, `prepare-pty.ts` 변경 | 다음 세션에서 hook이 `npm ci` 다시 실행 |
| 시스템 도구 추가 | `scripts/cloud-setup.sh` 수정 → 환경의 Setup script에 다시 붙여넣기 → 캐시 재생성 |
| 약 7일 경과 | 캐시 만료, setup script 재실행 |
| idle 후 복원된 세션 | setup script는 다시 돌지 않음. 바로 적용하려면 새 세션 |
| 데모 GIF | 클라우드 세션에서 `npm run demo -- <시나리오>`로 바로 녹화. 저장소 GIF를 갱신할 때는 GitHub Actions `demo` workflow 사용 |

## 5. 문제 해결

| 증상 | 원인·조치 |
|---|---|
| `npm ci`가 `gyp ERR! ... nodejs.org ... ECONNREFUSED`로 실패 | 헤더를 찾지 못함. `ls "$(dirname "$(dirname "$(readlink -f "$(command -v node)")")")"/include/node/node.h` 확인. 없으면 setup script 로그 확인, 또는 환경 허용 도메인에 `nodejs.org` 추가 |
| `npm warn EBADENGINE ... required: { node: '>=22.18' }` | Node 교체 실패. setup script의 `cloud-setup: Node … is older than 22.18` 메시지 확인 |
| 매 세션 setup script가 다시 돎 | 5분 초과로 캐시되지 않음. VHS 블록(CJK 폰트가 가장 큼)을 빼거나 설치를 병렬화 |
| hook이 실행되지 않음 | 저장소 여러 개를 연 세션, project 스레드에서는 저장소 hook이 실행되지 않음. 그 경우 `npm ci`를 setup script로 옮김 |

## 검증 기록

Ubuntu 24.04 컨테이너에서 클라우드 조건을 흉내 내 확인했습니다(arm64): `/opt/node22`에 Node 22.12, fzf·less 없음,
`nodejs.org` 차단(`--add-host nodejs.org:127.0.0.1`).

- setup script 27초, exit 0: Node 22.12 → 22.23.5, fzf·less·make·g++·python3 설치
- hook 7초: node-pty 소스 빌드 성공(`nodejs.org` 없이), 두 번째 실행은 0초(건너뜀)
- `npm run check`: 실패 0, skip 0

실제 클라우드 세션(x64, 실제 기본 이미지·프록시)에서는 아직 확인하지 않았습니다. 첫 세션에서 2번 확인 절차를 따라 주세요.
