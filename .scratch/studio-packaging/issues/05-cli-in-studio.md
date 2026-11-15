# 05-cli-in-studio

**What to build:** Studio 설치본 하나로 CLI(control-plane·runner-agent)까지 쓰게 한다. 데스크탑 QA 사용자가 Studio dmg 와 CLI zip 을 따로 받지 않도록.

**Blocked by:** 02

**결정 (2026-11-15):** Studio 안에 CLI 를 넣는다. 반대(CLI zip 안에 Studio)나 둘을 한 폴더에 나란히 두는 묶음은 하지 않는다. Node·헬퍼 APK 는 Studio 동봉분을 같이 쓰고, CLI 번들은 zip 설치본과 같은 `build-bundles.mjs` 산출물이다. CLI zip(`pnpm dist`)은 그대로 둔다(Windows·기기 노드 서버처럼 Studio 가 없는 머신용).

- `Contents/Resources/cli/bin/sinclair-{agent,control-plane}`: sh 런처. 심링크를 따라가 Resources 를 찾고, `Resources/node/node` 로 `cli/dist/<app>.mjs` 를 실행한다. `SINCLAIR_RESOURCES_DIR=Resources` 를 주며, 사용자가 준 값이 이긴다.
- `cli/dist/*.mjs`, `cli/node_modules/usb`(+ 플랫폼 패키지, 약 2MB 중복): 작업 프로세스의 worker/node_modules 와 공유하지 않는다. Resources 최상위 node_modules 는 electron-builder 처리 위험이 있어 피했다.
- `Resources/console/`: control-plane 이 자산 위치 규칙으로 /console 에서 서빙한다. `Resources/helper/` 는 에이전트가 그대로 쓴다.

**Status:** done. 런처 단위 테스트(`apps/studio/test/dist-cli-launcher.test.ts`)는 직접·절대 링크·상대 링크로 부를 때 인자·종료 코드·자산 위치가 맞는지, 사용자 값이 이기는지 본다. `verify-install.ts` 는 11/11(CLI 3개 추가)이다. PATH 의 심링크로 `--help`, control-plane 의 동봉 Console 200, 리포 밖 테스트 폴더 FakeEngine run 의 Cycle verified 를 확인했고, 시스템 node 는 쓰지 않는다. 증거는 `evidence/05-cli-in-studio.json`.
