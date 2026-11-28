# 기여 안내

## 버전

Calliopi의 버전은 **`<Pi major>.<Pi minor>.<하네스 릴리스>`** 형식입니다.

| 버전 | 뜻 |
|---|---|
| `1.7.0` | Pi 1.7 계열용 첫 하네스 릴리스 |
| `1.7.3` | Pi 1.7 계열용 네 번째 하네스 릴리스 |
| `1.8.0` | Pi 1.8로 옮긴 뒤 첫 릴리스. patch는 0부터 다시 셉니다 |

### 규칙

- **한 버전으로 통일합니다.** 루트 `calliopi`와 `packages/*`의 모든 패키지는 항상 같은 버전입니다. 한 패키지만 바뀌어도 전체 버전을 올립니다.
- **Pi는 `pi update`로 올리고, 저장소는 설치된 Pi를 따라갑니다.** 루트와 `packages/*`의 `@earendil-works/pi-*` devDependencies는 모두 설치된 Pi와 같은 정확한 `x.y.z`로 고정합니다(범위 `^`, `~` 없이). peerDependencies의 `*`는 그대로 둡니다. 타입 검사와 테스트가 실제로 도는 Pi와 같은 버전에서 돌게 하기 위해서입니다.
- **major.minor는 Pi를 따릅니다.** 기준은 루트 `devDependencies`에 고정한 `@earendil-works/pi-coding-agent` 버전입니다.
- **patch는 하네스 릴리스 번호입니다.** Pi의 patch 버전과는 관계없습니다. Pi를 1.7.0에서 1.7.2로 올려도 하네스 버전 형식은 그대로 1.7.x입니다.
- **pre-release(`-x`)나 build metadata(`+x`)는 쓰지 않습니다.** semver에서 `+` 뒤는 순서 비교에 쓰이지 않아(`1.7.0+2`와 `1.7.0+3`은 같은 버전) npm과 Pi의 업데이트 판단에 반영되지 않습니다. `-x`는 정식 버전보다 낮은 pre-release로 취급되어 `^` 범위 설치에서 빠집니다.
- 버전은 `package.json`을 직접 고치지 말고 아래 스크립트로 바꿉니다. 각 `package.json`과 `package-lock.json`의 workspace 항목을 함께 고칩니다.

### 명령

| 명령 | 언제 | 결과 |
|---|---|---|
| `npm run version:bump` | 하네스 릴리스를 낼 때 | `1.7.2` → `1.7.3` |
| `npm run version:sync` | `pi update` 뒤 | Pi 고정 버전을 설치된 `pi --version`으로 바꾸고 `npm install`. minor가 바뀌면 `1.7.3` → `1.8.0`, patch만 바뀌면 버전은 그대로 |
| `npm run check:version` | `npm run check`에 포함 | 버전이나 Pi 고정 버전이 서로 어긋나면 실패. 설치된 `pi`가 고정 버전과 다르면 알림만 출력 |

`version:sync`는 버전을 직접 받을 수도 있습니다(`npm run version:sync -- 1.8.2`). `pi`가 없는 환경에서 씁니다. `--no-install`을 붙이면 `npm install`을 건너뜁니다.

### Pi를 올리는 순서

1. `pi update`로 Pi를 올립니다.
2. 저장소에서 `npm run version:sync`를 실행합니다.
3. `npm run check`를 통과시킵니다. Pi API가 바뀌어 생긴 수정은 같은 커밋에 넣습니다.
4. README "요구 사항"의 "Pi … 에서 검증" 표기를 새 버전으로 고칩니다.

세션에 기록되는 하네스 버전(`npm run signals`가 비교에 쓰는 값)은 이 버전 번호가 아니라 git commit입니다. 같은 릴리스 안의 변경도 구분하기 위해서입니다.
