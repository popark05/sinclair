# 01: 리포 밖 테스트 폴더의 `@sinclair/runner` 해석

**What to build:** runner-agent 가 리포 체크아웃에서도 resolve 훅을 등록해 테스트 파일의 `@sinclair/runner` 를 에이전트가 쓰는 runner 로 넘긴다(번들은 지금처럼 runner.mjs). Studio 테스트 폴더(~/Sinclair/tests)가 리포 밖이라 필요. verify-studio 의 심볼릭 링크 우회를 없앤다.

**Status:** done

## 결과 (2026-11-14)

- `hooks.mjs` 가 `initialize(data.runner)` 를 받는다(없으면 번들의 runner.mjs). 리포 bin 이 `import.meta.resolve('@sinclair/runner')` 로 등록 — 워커(`__worker`)도 같은 bin 이라 함께. bin 테스트: 리포 밖 임시 폴더 테스트가 fake 엔진으로 통과. runner-agent 99 통과. verify-studio 의 심볼릭 링크 우회 제거.
