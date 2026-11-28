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
- **major.minor는 Pi를 따릅니다.** 기준은 루트 `devDependencies`에 고정한 `@earendil-works/pi-coding-agent` 버전입니다. 이 값은 범위(`^`, `~`) 없이 정확한 `x.y.z`로 적습니다. 서브패키지의 Pi devDependencies도 같은 값으로 맞춥니다.
- **patch는 하네스 릴리스 번호입니다.** Pi의 patch 버전과는 관계없습니다. Pi를 1.7.0에서 1.7.2로 올려도 하네스 버전 형식은 그대로 1.7.x입니다.
- **pre-release(`-x`)나 build metadata(`+x`)는 쓰지 않습니다.** semver에서 `+` 뒤는 순서 비교에 쓰이지 않아(`1.7.0+2`와 `1.7.0+3`은 같은 버전) npm과 Pi의 업데이트 판단에 반영되지 않습니다. `-x`는 정식 버전보다 낮은 pre-release로 취급되어 `^` 범위 설치에서 빠집니다.
- 버전은 `package.json`을 직접 고치지 말고 아래 스크립트로 바꿉니다. 각 `package.json`과 `package-lock.json`의 workspace 항목을 함께 고칩니다.

### 명령

| 명령 | 언제 | 결과 |
|---|---|---|
| `npm run version:bump` | 하네스 릴리스를 낼 때 | `1.7.2` → `1.7.3` |
| `npm run version:sync` | Pi minor를 올린 뒤 | `1.7.3` → `1.8.0` |
| `npm run check:version` | `npm run check`에 포함 | 버전이 모두 같지 않거나 Pi와 어긋나면 실패 |

### Pi를 올리는 순서

1. 루트와 `packages/*`의 `@earendil-works/pi-*` devDependencies를 새 버전으로 바꾸고 `npm install`을 실행합니다.
2. minor가 바뀌었으면 `npm run version:sync`를 실행합니다.
3. `npm run check`를 통과시킵니다. Pi API가 바뀌어 생긴 수정은 같은 커밋에 넣습니다.
4. README "요구 사항"의 "Pi … 에서 검증" 표기를 새 버전으로 고칩니다.

세션에 기록되는 하네스 버전(`npm run signals`가 비교에 쓰는 값)은 이 버전 번호가 아니라 git commit입니다. 같은 릴리스 안의 변경도 구분하기 위해서입니다.
