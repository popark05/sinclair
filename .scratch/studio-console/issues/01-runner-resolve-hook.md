# 01: 리포 밖 테스트 폴더의 `@sinclair/runner` 해석

**What to build:** runner-agent 가 리포 체크아웃에서도 resolve 훅을 등록해 테스트 파일의 `@sinclair/runner` 를 에이전트가 쓰는 runner 로 넘긴다(번들은 지금처럼 runner.mjs). Studio 테스트 폴더(~/Sinclair/tests)가 리포 밖이라 필요. verify-studio 의 심볼릭 링크 우회를 없앤다.

**Status:** in-progress
