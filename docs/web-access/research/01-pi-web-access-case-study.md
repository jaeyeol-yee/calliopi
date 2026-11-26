# pi 생태계는 웹 접근을 익스텐션으로 푼다

pi는 1.5.2 현재도 웹 검색·페치 도구를 내장하지 않으며, 생태계의 사실상 표준은 스킬도 MCP도 아닌 **익스텐션 `pi-web-access`(월 npm 다운로드 약 129만, 2위의 약 16배)** 다. 창시자가 처음 제시한 스킬+bash 방식(badlogic/pi-skills)은 유휴 컨텍스트 비용이 가장 낮지만 웹 스킬은 2025년 12월 이후 갱신이 없고, MCP는 pi 0.99.0(2026-09-29)에서 내장되어 기본 `codemode` 노출이면 도구 스키마를 프롬프트에 싣지 않는다. 딥 리서치는 "서브에이전트 계층 + 웹 익스텐션 + 프롬프트 템플릿"의 조합으로 구현되며, 대표 사례인 Feynman은 `pi-subagents`와 `pi-web-access`를 그대로 묶고 계획 → 연구자별 노트 → 초안 → 검증자 인용 → 리뷰로 이어지는 파일 체인을 얹었다. calliopi에는 (1) 검색·페치용으로 버전을 고정한 `pi-web-access`(또는 최소 구성으로 내장 MCP + Exa 호스티드 서버), (2) 브라우저 자동화용 온디맨드 스킬, (3) 로컬 `pi` 자식 프로세스 기반의 작은 리서치 러너와 프롬프트 템플릿을 권고한다. 단, 저장소를 확인한 결과 `calliopi-fanout`은 로컬 pi 서브에이전트가 아니라 **Cursor Cloud Agents**를 병렬 생성하는 익스텐션이고 `calliopi-workflows`는 fzf·Vim·git 플로팅 터미널 워크플로여서, 둘 다 리서치 오케스트레이션에 그대로 재사용되지는 않는다. 이 조사에서는 mariozechner.at, pi.dev, lucumr.pocoo.org, cdn.jsdelivr.net 등이 네트워크 정책으로 차단되어 일부 항목은 검색 스니펫에만 근거한다.

근거 등급은 본문에서 다음 표기로 구분한다. **【검증】** 은 저장소·README·npm 레지스트리 JSON·로컬 설치본(`/home/user/calliopi/node_modules/@earendil-works/pi-coding-agent`, 1.5.2)을 2026-11-26에 직접 읽은 내용, **【스니펫】** 은 검색 결과 요약이나 2차 자료로만 본 내용, **【추론】** 은 조사자의 해석이다. README의 수치는 직접 읽었더라도 관리자의 자기 보고이며, 독립 벤치마크는 어느 방식에서도 찾지 못했다.

## 스킬과 bash는 가장 싸지만 웹 스킬은 11개월째 멈춰 있다

pi의 원래 답은 "도구를 늘리지 말고 CLI 스크립트와 README를 쓰라"였다. v0.68.0 README의 철학 절은 "No MCP. Build CLI tools with READMEs (see Skills), or build an extension that adds MCP support."라고 적었고 웹 검색·페치는 언급조차 하지 않았다【검증】([pi-mono README v0.68.0](https://raw.githubusercontent.com/badlogic/pi-mono/v0.68.0/packages/coding-agent/README.md)). 1.5.2의 내장 도구는 `read`, `bash`, `edit`, `write`(기본)와 `grep`, `find`, `ls`, `powershell`, 그리고 내장 익스텐션의 `codemode`, `tool_search`뿐이다【검증: 로컬 `docs/settings.md`, `docs/cli.md`】([earendil-works/pi](https://github.com/earendil-works/pi)). 스킬이 싼 이유는 점진적 공개다. pi는 스킬의 이름과 설명만 광고하고 본문은 작업이 요구할 때만 읽는다【검증: 로컬 `docs/skills.md`】([Agent Skills 명세](https://agentskills.io/specification)). Zechner의 2025-11-02 글은 Playwright MCP 21개 도구 약 13.7k 토큰, Chrome DevTools MCP 26개 도구 약 18.0k 토큰을 README 약 225토큰짜리 Puppeteer 스크립트와 대비했다고 전해지지만, 원문 호스트가 차단되어 수치와 인용은 확인하지 못했다【스니펫】([mariozechner.at](https://mariozechner.at/posts/2025-11-02-what-if-you-dont-need-mcp/)).

| 사례 | 구현 방식 | 백엔드·키 | 유지보수 상태 | 등급 |
|---|---|---|---|---|
| [badlogic/pi-skills](https://github.com/badlogic/pi-skills) `brave-search` | Node 스크립트 `search.js`(기본 5건, 최대 20건, `--content`)와 `content.js`. Readability+Turndown, 결과당 5,000자 절단, 타임아웃 10초, JS 렌더링 없음 ([search.js](https://raw.githubusercontent.com/badlogic/pi-skills/main/brave-search/search.js)) | Brave Search 공식 API, `BRAVE_API_KEY` | 별 약 2.7k, 커밋 27개. 웹 스킬 최종 변경 2025-12-23, 2026년 커밋은 transcribe 등 다른 스킬 ([커밋 이력](https://github.com/badlogic/pi-skills/commits/main/)) | 검증 |
| 같은 저장소 `browser-tools` | 9222 포트의 Chrome에 CDP로 붙는 Puppeteer 스크립트(시작·이동·JS 평가·스크린샷·요소 선택·쿠키·본문 추출). 본문 추출은 **절단 없음** ([SKILL.md](https://raw.githubusercontent.com/badlogic/pi-skills/main/browser-tools/SKILL.md), [browser-content.js](https://raw.githubusercontent.com/badlogic/pi-skills/main/browser-tools/browser-content.js)) | 로컬 Chrome, 키 불필요, stealth 플러그인 | 위와 동일 | 검증 |
| [mitsuhiko/agent-stuff](https://github.com/mitsuhiko/agent-stuff) `web-browser` 외 | pi-skills 설계를 확장한 CDP 툴킷(기본 헤드리스, 모바일 에뮬레이션, 쿠키 배너 제거, 콘솔·네트워크 로그 JSONL). `/summarize`는 `uvx markitdown` ([SKILL.md](https://raw.githubusercontent.com/mitsuhiko/agent-stuff/main/skills/web-browser/SKILL.md)) | 로컬 Chromium, 키 불필요 | 별 약 3.2k, 커밋 256개, npm `mitsupi`. 최종 커밋일 미확인 | 검증 |
| [brave/brave-search-skills](https://github.com/brave/brave-search-skills) | 벤더 공식 Agent Skills 12종(`bx` CLI, `llm-context` 등), curl 예시 | Brave API, `BRAVE_SEARCH_API_KEY`(pi-skills와 변수명이 다름) | 별 198, 커밋 17개. 지원 목록에 pi 없음 | 검증(pi 호환은 추론) |
| [vercel-labs/agent-browser](https://github.com/vercel-labs/agent-browser) | Rust CLI와 상주 데몬, 접근성 트리 스냅샷과 `@e1` 형태의 참조로 조작. 스킬과 MCP 모드 모두 제공 | 로컬 브라우저 | 별 약 54.0k, 커밋 900개. pi 언급 없음 | 검증(pi 호환은 추론) |

이 방식의 한계는 코드와 커밋 이력에 그대로 남아 있다. pi-skills의 brave-search는 2025-12-12에 "429를 피하려고 완전한 브라우저 헤더 사용" 커밋을 넣었다가 엿새 뒤 공식 API로 갈아탔다. 키 없는 스크레이핑이 차단에 취약하다는 뜻이다【검증】([커밋 이력](https://github.com/badlogic/pi-skills/commits/main/)). 단순 HTTP 페치는 JS 렌더링 페이지를 읽지 못해 Chrome과 Puppeteer가 필요한 별도 스킬로 넘어가야 하고, 스킬마다 `npm install`과 환경변수 설정이 따른다. 모델이 한 줄 설명만 보고 스킬을 로드해야 하므로 항상 보이는 도구보다 호출 신뢰성이 낮을 것이라는 점은 구조에서 나온 추론이며 측정치는 없다【추론】. Tavily·Exa·Jina를 스킬로 쓰는 pi 사례나, 스킬 없이 `curl`만 쓰는 이름 있는 사용자 사례는 찾지 못했다.

## 익스텐션에서는 pi-web-access가 2위를 16배 앞선다

2026년 pi 생태계의 무게중심은 익스텐션이다. npm에는 `pi-package` 키워드 패키지가 14,393개 있고, 웹 접근 익스텐션의 월 다운로드는 `pi-web-access` 1,293,371, `pi-web-search` 80,155, `@agntn/web` 16,844 순이다【검증】([npm 레지스트리 검색](https://registry.npmjs.org/-/v1/search?text=keywords:pi-package%20web&size=40)). 다운로드 수는 CI와 봇을 포함하므로 상대 순위로만 읽어야 한다. 경쟁 패키지는 거의 모두 "pi-web-access보다 좁다"는 점으로 자신을 정당화한다. 추가 키 없는 프로바이더 네이티브 검색, 도구별 단일 프로바이더 라우팅, 더 작은 컨텍스트가 그 세 축이다【추론】.

| 사례 | 등록 도구 | 기본 백엔드 | 유지보수 상태 (npm 기준) |
|---|---|---|---|
| [pi-web-access](https://github.com/nicobailon/pi-web-access) (nicobailon) | `web_search`, `fetch_content`, `get_search_content`, `source_check` | `auto`: SearXNG 설정 시 우선, ChatGPT 구독 로그인 시 OpenAI 검색, 그 외 Exa(키 없으면 공개 MCP) 다음 Brave 등 40여 개 | 0.48.0 (2026-11-15), 57개 버전, 최근 한 달 8회 릴리스, 별 약 1.9k ([레지스트리](https://registry.npmjs.org/pi-web-access)) |
| [pi-web-search](https://www.npmjs.com/package/pi-web-search) (ttttmr) | `web_search`, `url_context` | 현재 선택한 모델의 네이티브 검색(Gemini 그라운딩, OpenAI·xAI Responses, Anthropic Messages 등). 미지원 모델은 폴백 없이 오류 | 1.7.0 (2026-10-08), 런타임 의존성 0개 ([레지스트리](https://registry.npmjs.org/pi-web-search)) |
| [pi-web-providers](https://github.com/mavam/pi-web-providers) (mavam) | `web_search`, `web_contents`, `web_answer`, `web_research` | 도구마다 프로바이더 하나를 지정. Claude Code·Codex CLI의 로컬 인증 재사용 가능 | 3.5.1 (2026-07-20), 이후 4개월 릴리스 없음 ([레지스트리](https://registry.npmjs.org/pi-web-providers)) |
| [@juicesharp/rpiv-web-tools](https://www.npmjs.com/package/@juicesharp/rpiv-web-tools) | `web_search`, `web_fetch` | Brave(키 필요). `web_fetch`는 키 불필요, SearXNG·Ollama 로컬 지원 | 2.15.0 (2026-10-24), 140개 버전 ([레지스트리](https://registry.npmjs.org/@juicesharp/rpiv-web-tools)) |
| [@ollama/pi-web-search](https://www.npmjs.com/package/@ollama/pi-web-search) | `ollama_web_search`, `ollama_web_fetch` | 로컬 Ollama | 0.0.5 (2026-03-28) 이후 릴리스 없음 |
| [@ssk_dev/pi-web-access-lean](https://www.npmjs.com/package/@ssk_dev/pi-web-access-lean) | `web_access` 하나(`op`로 분기) | 상류 pi-web-access 0.48.0 엔진 | 0.48.0 (2026-11-21), Pi 0.84.1 이상 |
| [pi-agent-browser-native](https://registry.npmjs.org/pi-agent-browser-native) | agent-browser를 네이티브 도구로 노출 | 로컬 브라우저 | 0.9.46 (2026-11-25), 148개 버전, 월 41,889 ([검색](https://registry.npmjs.org/-/v1/search?text=keywords:pi-package%20browser&size=25)) |

pi-web-access가 표준이 된 이유는 스킬이 할 수 없는 일을 하기 때문이다. 페치한 본문 전체를 세션 JSONL이 아닌 별도 캐시 디렉터리에 저장하고 인라인 반환은 `maxInlineContentChars`(기본 30,000자)에서 자르며, `get_search_content`로 오프셋과 텍스트 검색 기반 페이징을 제공한다. GitHub URL은 스크레이핑하지 않고 로컬 클론이나 `gh`로 처리하고, SSRF 검증·리다이렉트 검사·5MB 응답 한도를 코드로 강제한다. 0.46에서는 브라우저형 연결을 도입해 "68개 페이지 중 읽은 수가 18개에서 31개로 늘었다"고 관리자가 보고했다【검증, 자기 보고】([README](https://github.com/nicobailon/pi-web-access)). 대가는 상시 컨텍스트다. 린 포크 작성자는 상류의 상시 비용을 **1,165토큰**, 자신의 단일 도구 래퍼를 **153토큰**으로 측정했는데【검증, 자기 보고】([pi-web-access-lean](https://www.npmjs.com/package/@ssk_dev/pi-web-access-lean)), 같은 프로젝트의 pi.dev 페이지 스니펫은 1,180 대 302로 다른 수치를 싣고 있어 방법론은 불확실하다【스니펫】. `pi-web-access-lazy`처럼 로더 도구로 지연 등록하는 방식은 도구 목록이 바뀌는 순간 프롬프트 캐시를 놓칠 수 있다고 스스로 경고한다【검증】([pi-web-access-lazy](https://www.npmjs.com/package/pi-web-access-lazy)).

프로바이더 네이티브 서버사이드 검색은 pi-ai가 직접 지원하지 않는다. 로컬 `@earendil-works/pi-ai` 1.5.2의 `dist`에서 `server_tool_use`, `web_search_20`, `web_search_preview`, `googleSearch`를 검색했지만 일치하는 파일이 없었다【검증: 로컬 grep】([npm @earendil-works/pi-ai](https://www.npmjs.com/package/@earendil-works/pi-ai)). 따라서 pi-web-search 같은 익스텐션은 커스텀 도구 안에서 검색 도구를 켠 별도 모델 요청을 보내고 그 답과 인용을 도구 결과로 돌려주는 구조로 보이며, 검색 한 번마다 모델 호출이 한 번 더 든다. pi-web-search의 소스는 읽지 않았으므로 이는 추론이다【추론】. 익스텐션끼리의 충돌도 실제 제약이다. 여러 패키지가 `web_search`라는 같은 이름을 등록하고, pi-web-search와 린·레이지 포크의 README가 각각 중복 설치를 금지한다【검증】([pi-web-search](https://www.npmjs.com/package/pi-web-search)).

포크는 반대 방향으로 갔다. [oh-my-pi](https://github.com/can1357/oh-my-pi)(별 약 39.9k, npm 19.2.1이 2026-11-25 게시)는 웹 검색이 "built in, not bolted on"이라며 25개 프로바이더 `auto` 체인을 내장하고, URL 읽기를 `read` 도구에 합쳐 GitHub·npm·arXiv·Stack Overflow용 사이트별 추출기를 붙였으며, Puppeteer 기반 `browser` 도구를 함께 싣는다【검증: README만, 소스와 전용 문서는 미확인】. 다만 `@oh-my-pi/*`라는 독자 패키지군을 가진 완전한 포크라서 `@earendil-works/*` 위에 얹은 calliopi에는 설계 참고 자료일 뿐 가져다 쓸 부품이 아니다. [senpi](https://www.npmjs.com/package/@code-yeongyu/senpi)는 OpenAI·Anthropic 네이티브 검색을 모델 요청에 직접 연결한다고 하지만, 이 주장은 자매 저장소 [pi-websearch](https://github.com/code-yeongyu/pi-websearch)의 README에만 있고 senpi 자체 문서에서는 확인하지 못했다【검증: 자매 README의 주장】.

## MCP는 pi 0.99.0에서 내장됐고 기본값은 스키마를 숨긴다

"pi에는 MCP가 없다"는 2026년 중반까지의 블로그 서술은 이제 낡았다. 로컬 CHANGELOG에 따르면 0.99.0(2026-09-29)이 codemode, tool search, MCP를 내장 익스텐션으로 추가했고 1.0.0은 이틀 뒤인 2026-10-01에 나왔다. 1.5.0부터 1.5.2까지의 변경도 대부분 MCP 안정화(스트리머블 HTTP 메시지 크기 제한, stdio 서브프로세스 정리, OAuth 갱신 경합 수정)다【검증: 로컬 `CHANGELOG.md`】([pi.dev 변경 로그 0.99.0](https://pi.dev/changelog/releases/0.99.0), 이 URL 자체는 미접속). 도입 동기를 설명하는 Ronacher의 글과 The New Stack 기사는 호스트 차단으로 읽지 못했고, "codemode가 MCP와 pi의 미니멀리즘을 화해시켰다"는 해석은 2차 자료에만 근거한다【스니펫】([The New Stack](https://thenewstack.io/pi-agent-mcp-codemode/)).

컨텍스트 비용은 서버별 `exposure` 설정으로 결정된다【검증: 로컬 `docs/mcp.md`】. 기본값 `codemode`는 도구를 모델에 선언하지 않으며, 모델이 QuickJS 샌드박스의 JavaScript에서 `searchTools()`와 `describeTool()`로 찾아 호출하고 스크립트의 출력만 컨텍스트로 돌아온다. `deferred`는 `tool_search`가 찾을 때까지 선언을 미루고, `direct`는 내장 도구처럼 스키마를 선언하며, `hidden`은 도달 불가다. 20KB를 넘는 텍스트 결과는 가운데를 잘라 전체를 임시 파일에 저장한다. 전송 방식은 stdio와 스트리머블 HTTP만 지원하고 레거시 SSE는 거부한다. 설정 파일 `~/.pi/agent/mcp.json`과 `.pi/mcp.json`은 Claude Code·Cursor와 같은 `mcpServers` 형식이다. 1.0.0 변경 로그는 기본 도구와 codemode를 켠 GPT-5.6 요청이 약 5,300토큰에서 약 3,300토큰으로 줄었다고 적었다. 이 고정 비용은 연결한 서버 수와 무관하게 한 번만 든다.

| 서버 | 전송·엔드포인트 | 도구 수 | 키 | 등급 |
|---|---|---|---|---|
| [Exa MCP](https://github.com/exa-labs/exa-mcp-server) | 호스티드 스트리머블 HTTP `https://mcp.exa.ai/mcp` | 기본 2개(`web_search_exa`, `web_fetch_exa`) | 익명 사용 가능(속도 제한) | 검증 |
| [Tavily MCP](https://docs.tavily.com/documentation/keyless) | 호스티드 `https://mcp.tavily.com/mcp/`, stdio도 제공 | 4개 | 키 없는 원격 접근은 검색·추출만 | 스니펫 |
| [Jina MCP](https://github.com/jina-ai/MCP) | 호스티드 `https://mcp.jina.ai/v1`, URL 파라미터로 도구 필터 | 12개 | `read_url`은 키 선택, `search_web`은 키 필요 | 검증 |
| [Brave Search MCP](https://github.com/brave/brave-search-mcp-server) | stdio 또는 자가 호스팅 HTTP, 호스티드 URL 없음 | 9개 | `BRAVE_API_KEY` 필수 | 검증 |
| [Playwright MCP](https://github.com/microsoft/playwright-mcp) | stdio, 로컬 | 기본 25개, 전체 72개 | 불필요 | 검증 |
| [Chrome DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp) | stdio, 로컬, `--slim` 축소 모드 | 현재 개수 미확인 | 불필요 | 검증 |

벤더 가격 페이지는 하나도 직접 열지 못했고 2차 자료끼리도 Brave·Exa·Context7의 무료 한도가 엇갈리므로 이 보고서는 가격을 인용하지 않는다. 브라우저 쪽에서는 벤더 스스로 MCP에서 물러서고 있다. Playwright MCP README는 CLI 호출이 큰 도구 스키마와 장황한 접근성 트리를 컨텍스트에 싣지 않아 토큰 효율이 높다며 코딩 에이전트에 CLI를 권하고, Chrome DevTools MCP는 `chrome-devtools` CLI와 스킬 7종을 함께 배포한다【검증】([microsoft/playwright-mcp](https://github.com/microsoft/playwright-mcp), [ChromeDevTools/chrome-devtools-mcp](https://github.com/ChromeDevTools/chrome-devtools-mcp)). 내장 MCP 이전의 우회로였던 [pi-mcp-adapter](https://github.com/nicobailon/pi-mcp-adapter)(별 약 1.7k)는 약 200토큰짜리 프록시 도구 하나와 지연 시작·유휴 종료를 제공하며 지금도 유지되지만, 설치하면 내장 MCP를 대체한다【검증: README와 로컬 `docs/mcp.md`】. 원격 HTTP 검색 서버만 쓴다면 로컬 프로세스가 없으므로 어댑터의 지연 수명주기 이점은 대부분 사라진다【추론】. 특정 사용자가 검색 MCP 서버를 pi 내장 MCP에 붙여 결과를 보고한 문서화된 사례는 찾지 못했다.

## 세 방식의 차이는 토큰을 언제, 얼마나 내느냐다

| 기준 | 스킬 + bash | 익스텐션 | 내장 MCP |
|---|---|---|---|
| 유휴 컨텍스트 비용 | 스킬당 이름과 설명 한 줄【검증】 | pi-web-access 계열 약 150~1,200토큰이 매 요청에 실림【자기 보고】 | `codemode` 노출은 서버당 시스템 프롬프트 한 줄과 codemode 고정 비용, `direct`는 도구별 스키마【검증·추론】 |
| 결과 크기 제어 | 스크립트 몫(brave-search 5,000자 절단, browser-content는 무제한) | 세션 밖 캐시와 페이징, 30,000자 인라인 한도, 임시 파일 스필 | 20KB 중간 절단과 스필 파일, codemode 스크립트에서 사전 필터 |
| 호출 신뢰성 | 모델이 스킬을 로드해야 함【추론】 | 항상 보이는 타입 지정 도구 | `direct`는 도구와 동일, `codemode`는 모델이 스크립트를 써야 함【추론】 |
| 인증·키 | 셸 환경변수 | pi 로그인·모델 레지스트리 재사용 가능(구독 검색) | OAuth·베어러 내장, 익명 호스티드 엔드포인트 존재 |
| 유지보수 위험 | 사용자가 스크립트를 직접 고침, 1차 스킬은 휴면 | pi 내부 API 피어 의존(pi-web-access는 2026년에 피어 구성을 세 번 변경), 제3자 코드가 프로세스 안에서 전체 권한으로 실행 | 벤더가 도구·요금을 일방 변경(Jina v1.10.0 도구 제거, Brave `brave_summarizer` 폐기) |
| 이식성 | Agent Skills 표준이라 Claude Code·Codex 등과 공유 | pi 전용 | `mcpServers` 설정을 다른 에이전트와 공유 |
| 권한 통제 | bash 전체 권한에 묻힘 | 코드로 SSRF·도메인 정책 강제 | pi 도구 파이프라인을 통과하므로 `tool_call` 게이트와 `readOnlyHint` 적용【검증】 |

숫자를 읽을 때 주의할 점이 두 가지 있다. 첫째, 널리 인용되는 "MCP는 13.7k~18k 토큰"은 2025년 11월의 브라우저 서버 측정이고 원문을 확인하지 못했다. 2026년 자료 중에는 Playwright MCP 약 26개 도구를 약 3,600토큰으로 추정한 글도 있어 차이가 크고 해소되지 않았다【스니펫】([morphllm](https://www.morphllm.com/playwright-mcp)). 둘째, 검색(브라우저가 아닌)에 대해 스킬·익스텐션·MCP를 직접 비교한 벤치마크는 존재하지 않는다. 그래도 방향은 분명하다. 도구가 한두 개인 검색 서버를 `direct`로 붙인 MCP와 두 개짜리 익스텐션은 비용이 비슷한 수준이고, 차이는 스키마가 아니라 결과 처리(캐시, 페이징, 절단)와 인증 재사용에서 난다. 브라우저 자동화는 도구 수가 많고 사용 빈도가 낮으므로 스킬이나 CLI가 맞다【추론】.

## 딥 리서치는 서브에이전트, 웹 익스텐션, 프롬프트의 조합이다

pi 생태계의 서브에이전트 계층은 웹 도구를 싣지 않는다. 연구자 에이전트가 웹에 접근하는 것은 자식 세션에 `pi-web-access`가 로드되어 있고 에이전트 정의의 `tools:` 프런트매터가 그 도구 이름을 허용하기 때문이다.

| 사례 | 오케스트레이션 | 연구자의 웹 접근 | 상태 |
|---|---|---|---|
| 공식 `subagent` 예제 (로컬 `examples/extensions/subagent/`, 상류 [pi 모노레포](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent/examples/extensions/subagent)) | 자식 `pi --mode json -p --no-session` 프로세스. 단일·병렬(최대 8개, 동시 4개)·체인. 결과는 작업당 50KB 한도의 메시지 | 없음. 샘플 에이전트는 코드용(scout는 Haiku, 나머지는 Sonnet) | pi 1.5.2 패키지에 포함【검증】 |
| [nicobailon/pi-subagents](https://github.com/nicobailon/pi-subagents) | 부모 프로세스 내 자식 세션 또는 분리 러너. JS 워크플로 스크립트(`runs.all`, `runs.lanes`). `subagent` 도구 비용은 위임 전 약 300토큰, 후 약 1,500토큰 | 내장 `researcher`와 `evidence-auditor`가 자식의 pi-web-access를 요구 | 별 약 4.3k, 커밋 2,361개, Pi 1.2.0 이상【검증】 |
| [tintinweb/pi-subagents](https://github.com/tintinweb/pi-subagents) | Claude Code식 격리 세션, 백그라운드 기본, `node:vm` 워크플로 도구 | 없음 | 별 약 1.5k, Pi 1.1.0 이상【검증】 |
| [Lincoln504/pi-research](https://github.com/Lincoln504/pi-research) | 단일 도구 안의 라운드형 엔진(코디네이터, 병렬 연구자, 리서치 리드) | 스텔스 브라우저로 DuckDuckGo 로컬 질의, 키 없음. 연구자는 읽기 전용 | 별 65, 커밋 1,646개, 100k 이상 컨텍스트 필요【검증】 |
| [mikefreno/deepi-research](https://github.com/mikefreno/deepi-research) | `deep_research` 도구, depth 1~3과 breadth 1~5 | Firecrawl(기본 자가 호스팅 `localhost:3002`) | 별 1, 커밋 14개, 취미 규모【검증】 |
| [Feynman](https://github.com/companion-inc/feynman) (`@companion-ai/feynman`) | 순정 pi 위의 리서치 CLI. `pi-subagents` 0.90.0 + `pi-web-access` 0.48.0 + 자체 논문 검색 익스텐션, 프롬프트 템플릿 `/deepresearch` | pi-web-access와 학술 데이터베이스 | 별 약 10.2k, 0.5.74, pi 1.6.1에 고정 ([package.json](https://raw.githubusercontent.com/companion-inc/feynman/main/package.json))【검증】 |

Feynman의 `/deepresearch` 프롬프트는 이식 가능한 설계를 가장 구체적으로 보여 준다【검증】([prompts/deepresearch.md](https://raw.githubusercontent.com/companion-inc/feynman/main/prompts/deepresearch.md)). 먼저 계획 파일을 디스크에 쓰고, 규모를 판정한다. 도구 호출 3~10회로 끝날 좁은 질문은 서브에이전트 없이 직접 검색하고, 2~3개 항목 비교는 연구자 2명, 넓은 조사는 3~4명, 복합 다영역은 4~6명이다. 연구자별 브리프 파일과 워크플로 스크립트를 쓴 뒤 `globalConcurrencyLimit: 4`로 실행하고, 각 자식의 출력 파일이 실제로 존재하는지 확인한다. 종합은 "리드 에이전트가 직접 쓰고 위임하지 않는다". 그 뒤 검증자가 모든 URL을 다시 페치해 주장된 내용이 실제로 있는지 확인하며 인용을 붙이고, 리뷰어가 FATAL·MAJOR·MINOR로 판정하며, 최종본과 함께 출처 수락·거부 내역과 검증 상태를 담은 provenance 파일을 남긴다. 연구자 규칙은 읽지 않은 내용을 서술하지 말 것, 각 주장을 직접 읽음·추론·미해결로 표시할 것, 페이지 본문을 컨텍스트에 쥐지 말고 파일에 누적 기록한 뒤 부모에게는 한 줄 요약만 돌려줄 것이다([researcher.md](https://raw.githubusercontent.com/companion-inc/feynman/main/.feynman/agents/researcher.md), [verifier.md](https://raw.githubusercontent.com/companion-inc/feynman/main/.feynman/agents/verifier.md)).

이 구조의 원형은 Anthropic의 2025년 6월 글이다. 리드 에이전트와 병렬 서브에이전트, 별도의 CitationAgent로 이뤄진 구성이 단일 에이전트보다 내부 평가에서 90.2% 높았지만, 멀티에이전트는 채팅의 약 15배 토큰을 쓰고 BrowseComp 성능 분산의 약 80%를 토큰 사용량이 설명했다【검증】([Anthropic 엔지니어링](https://www.anthropic.com/engineering/multi-agent-research-system)). 비용의 실제 크기는 LangChain open_deep_research가 보여 준다. 리포트 100건 기준으로 기본 모델 구성은 45.98달러에 RACE 0.4309였고 Claude Sonnet 4로 바꾸면 187.09달러에 0.4401이었다. 비용이 4배가 되고 점수는 약 0.01 오른 셈이다. 이 저장소는 2026-08-21에 아카이브되었다【검증】([langchain-ai/open_deep_research](https://github.com/langchain-ai/open_deep_research)). Feynman의 규모 규칙이 Anthropic의 것(1명, 2~4명, 10명 초과)을 축소한 형태라는 점, 동시성 4가 공식 예제와 Feynman에 똑같이 나타난다는 점은 구조와 숫자의 일치에서 나온 추론이며 "Anthropic 설계를 pi로 옮겼다"고 밝힌 출처는 없다【추론】.

위험 요소 가운데 근거가 가장 약한 것은 프롬프트 인젝션이다. 심어 둔 문서 하나가 거짓 결론 채택률을 0%에서 54.7%로 올렸다는 수치는 2차 요약의 스니펫에서 왔고 원 논문을 특정하지 못했으므로 방향성으로만 받아들여야 한다【스니펫】([dev.to 요약](https://dev.to/breachprotocol/one-planted-document-flipped-more-than-half-of-deep-research-reports-to-a-false-conclusion-3b98)). pi 리서치 에이전트를 겨냥한 실제 사고 보고는 찾지 못했다. 이 표본에서 모델의 주의력에 기대지 않는 완화책은 권한 제한 하나뿐이다. pi-research는 연구자를 읽기 전용으로 두어 주입된 지시가 "작용할 대상이 없게" 만들고, pi-subagents의 `researcher`는 도구를 `read, write, web_search, fetch_content, get_search_content, source_check`로 제한한다【검증】([agents/researcher.md](https://raw.githubusercontent.com/nicobailon/pi-subagents/main/agents/researcher.md)). 반면 Feynman의 연구자와 검증자는 웹 도구와 함께 `bash`, `write`, `edit`를 갖고 있고, 읽은 파일에서 인젝션 규칙은 발견하지 못했다. 병렬 팬아웃에서의 검색 API 속도 제한을 측정한 자료는 없고, 관찰되는 대응은 동시성 4 고정, 여러 질의를 `web_search` 한 번의 `queries` 목록으로 묶기, API 키로 공유 한도 벗어나기 정도다.

## calliopi에는 얇은 3층 구성이 맞는다

권고에 앞서 전제를 하나 바로잡는다. 저장소 README를 확인한 결과 `calliopi-fanout`은 "Cursor Cloud Agents를 N개 병렬로 생성"하고 PR과 실행 상태를 추적하는 익스텐션이며, `calliopi-workflows`는 `/cl-edit`, `/cl-log`, `/cl-run`, `/cl-jobs` 같은 플로팅 터미널 워크플로 모음이다【검증: `/home/user/calliopi/packages/calliopi-fanout/README.md`, `/home/user/calliopi/packages/calliopi-workflows/README.md`】. 클라우드 에이전트는 로컬 pi 세션에 설치한 웹 도구를 쓰지 못하고 결과도 파일이 아닌 PR·요약으로 돌아오므로, Feynman처럼 "기존 팬아웃 + 워크플로에 웹 익스텐션만 더하면 딥 리서치"라는 등식은 calliopi에서 성립하지 않는다【추론】. 아래 권고는 모두 조사 결과에서 도출한 추론이며, 명령과 호환성은 이 세션에서 실행해 보지 않았다.

**1층, 검색과 페치: 버전을 고정한 `pi-web-access`를 기본으로 한다.** 근거는 세 가지다. 생태계의 리서치 자산(pi-subagents의 `researcher`·`evidence-auditor`, Feynman의 에이전트 정의)이 이 패키지의 도구 이름을 계약으로 삼고 있어 2층·3층의 선택지가 넓어진다. 본문을 세션 밖에 캐시하고 페이징하는 설계가 긴 리서치에서 컨텍스트를 지킨다. 그리고 `auto` 라우팅이 자가 호스팅 SearXNG를 최우선으로 삼고 추출이 로컬 Readability로 이뤄지므로 로컬 우선 원칙과 어긋나지 않게 구성할 수 있다. README가 요구하는 Pi v0.37.3 이상은 1.5.2가 충족하지만, 0.48.0이 1.5.2에서 실제로 로드되는지는 시험하지 않았다. Feynman과 `@adeildo/pi-web`처럼 시험한 버전에 고정하고, `webSearch.allowedProviders`로 프로바이더를 좁히며, 큐레이터 워크플로는 `none`으로 두고, 익스텐션이 스스로 부르는 요약 모델은 꺼 두는 편이 낫다. 상시 약 1.2k 토큰이 부담되는 로컬 소형 모델 환경이라면 린 포크(153토큰)가 있지만, 상류 릴리스마다 재배포되어야 하는 의존 사슬이 하나 늘어난다.

제3자 코드를 프로세스 안에 들이고 싶지 않거나 가장 작게 시작하려면 **내장 MCP에 Exa 호스티드 서버를 `direct` 노출로 붙이는 구성**이 대안이다. 로컬 `docs/mcp.md`의 문법대로라면 `pi mcp add exa --url https://mcp.exa.ai/mcp` 뒤에 `mcp.json`에서 `"exposure": "direct"`를 지정하면 되고, 도구 2개라 스키마 비용은 익스텐션과 비슷하다. 코드와 키가 필요 없다는 것이 장점이고, 검색이 익명 한도에 묶인 외부 서비스에 의존한다는 점과 세션 밖 캐시·페이징이 없다는 점이 단점이다. 두 구성을 함께 켜면 검색 도구가 중복되므로 하나만 고른다. `pi-web-search` 같은 네이티브 검색 익스텐션은 추가 키가 없어 매력적이지만 검색마다 모델 호출이 한 번 더 들고 선택한 모델에 종속되므로 보조 수단 이상으로는 권하지 않는다.

**2층, 브라우저 자동화: 익스텐션이나 MCP가 아니라 온디맨드 스킬로 둔다.** 사용 빈도가 낮고 도구 표면이 넓은 기능에 상시 스키마를 낼 이유가 없고, Playwright와 Chrome DevTools 팀도 코딩 에이전트에는 CLI를 권한다. calliopi의 루트 `package.json`은 이미 `./packages/context/skills`를 pi 스킬 경로로 등록하고 있고 `context` 패키지는 아직 스켈레톤이므로, mitsuhiko의 `web-browser` 스킬이나 agent-browser CLI용 스킬을 그 자리에 벤더링하는 것이 구조에 맞는다. badlogic/pi-skills의 원본은 11개월간 갱신이 없으므로 출발점으로는 더 활발히 손본 agent-stuff 쪽이 낫다. 본문 추출 스크립트가 출력을 자르지 않는 원본 설계는 가져올 때 절단이나 파일 리다이렉트를 추가해 고쳐야 한다.

**3층, 딥 리서치: 프롬프트 템플릿으로 먼저 시작하고, 팬아웃은 로컬 `pi` 자식 프로세스로 따로 만든다.** 첫 단계는 서브에이전트 없이 `packages/context/prompts`에 Feynman식 직접 모드 템플릿(계획 파일 선작성, 주장별 출처와 직접 읽음·추론·미해결 표시, 결과물과 provenance 파일 저장)을 두는 것이다. Feynman과 Anthropic 모두 도구 호출 3~10회 수준의 질문은 팬아웃 없이 처리하라고 규정하므로 이것만으로 상당 부분이 해결된다. 팬아웃이 필요해지면 선택지는 둘이다. `pi-subagents`를 설치하면(Pi 1.2.0 이상 요구, 1.5.2 충족) 연구자·검증 에이전트와 워크플로 스크립트를 즉시 얻지만 요청당 300~1,500토큰과 커밋 2,361개 규모의 큰 의존성이 따라온다. calliopi의 모듈형 원칙에는 공식 예제 방식, 즉 `pi --mode json -p --no-session`에 `--tools` 허용 목록과 `--append-system-prompt`를 주는 작은 러너를 새 패키지로 두는 쪽이 더 맞는다. 자식이 별도 `pi` 프로세스이면 설치된 웹 익스텐션과 `mcp.json`을 정상적으로 로드하지만, SDK 세션으로 띄우면 내장 익스텐션(MCP·codemode·tool search)이 자동 로드되지 않으므로 리소스 로더에 명시해야 한다【검증: 로컬 `docs/mcp.md`】. `calliopi-workflows`의 `/cl-run`·`/cl-jobs` 잡 러너를 이 자식 실행에 재사용할 수 있는지는 확인하지 않았다.

러너를 만든다면 사례들이 수렴한 규칙을 스크립트에 고정해 두는 것이 좋다. 동시 실행은 4, 연구자는 2~6명으로 제한한다. 연구자의 도구는 `read`, `write`와 웹 도구로 한정하고 `bash`는 주지 않는다. 결과는 메시지가 아니라 노트 파일로 받고 부모에게는 경로와 한 줄 요약만 돌려준다. 종합은 리드가 직접 쓰고, 인용 검증은 URL을 다시 페치하는 별도 패스로 리뷰보다 먼저 돌린다. 공식 예제에서는 자식의 토큰 사용량이 부모 세션 합계에 더해지지 않으므로, 이미 `/cl-usage`를 가진 calliopi는 자식 사용량을 직접 집계해야 리서치 한 번의 실제 비용을 볼 수 있다.

## Conclusion

이 조사가 바꿔 놓는 인식은 "pi는 스킬 중심의 미니멀 하네스"라는 통념이다. 2026년 11월의 pi에서 스킬 방식은 설계 철학으로는 살아 있지만 웹 접근의 실사용 경로로는 주변부에 가깝고, 실제 사용량은 익스텐션 하나에 집중되어 있으며, MCP는 codemode 덕분에 "컨텍스트를 낭비한다"는 원래의 반대 논거를 대부분 잃었다. 방식 선택의 기준은 이제 스키마 토큰이 아니라 결과 본문을 어디에 두느냐(세션 안인가 밖인가), 누구의 인증을 재사용하느냐, 누가 깨진 부분을 고치느냐다.

calliopi에 대한 함의는 순서에 있다. 웹 도구 한 층을 먼저 고정하고, 리서치 로직은 코드가 아닌 프롬프트와 파일 규약으로 `context` 패키지에 쌓고, 로컬 자식 러너는 직접 모드의 한계가 실제로 드러난 뒤에 만드는 편이 4배 비용에 0.01점을 얻는 식의 과잉 설계를 피하는 길이다. 권고를 확정하기 전에 닫아야 할 공백은 세 가지다. 차단된 1차 자료(Zechner와 Ronacher의 글, pi.dev 패키지 페이지)의 원문 확인, `pi-web-access` 0.48.0과 pi 1.5.2의 실제 로드 시험, 그리고 pi-ai 1.6.1에서 서버사이드 검색 지원 여부가 달라졌는지의 점검이다.
