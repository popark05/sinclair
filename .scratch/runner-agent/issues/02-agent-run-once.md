# 02: runner-agent CLI 로 run 하나를 끝까지 실행한다

**What to build:** 기기 노드에서 `sinclair-agent run --control-plane <url> --cycle <id> --target <id> --tests <dir> [--device <serial> | --engine fake]` 를 치면, 에이전트가 Cycle 에 Run 을 등록하고(또는 `--run <id>` 로 지정된 Run 을 쓰고), 테스트 파일을 모아 엔진(실기기면 engine-mobile + Android 백엔드, 아니면 FakeEngine)으로 `runTests` 를 돌리며, 이벤트를 HTTP Reporter 로 control-plane 에 흘려보낸다. 끝나면 요약(통과/실패/blocked/skipped, Reporter 통계, 경고)을 출력하고 실패가 있으면 0 이 아닌 코드로 끝난다. Console 없이 `GET /cycles/:id` 에서 결과가 보인다.

**Blocked by:** 01 (서버 엔트리)

**Status:** done

- [x] CLI 파싱과 설정(플래그 > 환경변수 > 기본값), 한국어 도움말. 테스트 파일은 `--tests` 디렉터리의 `*.sinclair.ts` 를 정렬된 순서로
- [x] Run 등록: `--run` 이 없으면 `POST /cycles/:id/runs` 로 발급. 등록 실패(모르는 Cycle, 끝난 Cycle 409)는 명확한 메시지로 종료
- [x] 엔진 선택: `--engine fake` 는 FakeEngine(로그인 시나리오), 기본은 디바이스 레이어의 Android 백엔드 위 engine-mobile(`--device` 필수, 헬퍼 온보딩 대기). 엔진 생성·dispose 가 run 수명과 같다
- [x] HTTP Reporter 로 전송, run 끝에 flush·close. 종료 코드: 전부 통과 0, 실패 1, blocked(기기 불가) 2, 설정 오류 3
- [x] 테스트: 인프로세스 control-plane 서버 + FakeEngine 으로 CLI 모듈을 호출해 `GET /cycles/:id` 가 finished 와 매트릭스를 돌려준다. 자식 프로세스로 실제 bin 을 한 번 실행하는 스모크
- [x] 실기기 opt-in 테스트(`SINCLAIR_TEST_USB=1`)로 설정 앱 샘플이 실기기 → control-plane 까지 흐른 증거를 `.scratch/runner-agent/evidence/` 에 남긴다(시리얼 마스킹)
- [x] `verify-runner-agent` 검증 스킬 시드: control-plane 띄우기 → `sinclair-agent run --engine fake` → Cycle 조회 증거

## Comments

- 2026-11-08: 구현 완료, 실기기 증거만 남음. `apps/runner-agent/src`: `args.ts`(`parseRunArgs`, 옵션 표 → 파서·도움말·`SINCLAIR_AGENT_*`, `--timeout` 추가), `control-plane-client.ts`(`registerRun`: 201 발급, `--run` 지정 시 409 는 기존 Run 재사용, 그 외 오류), `engines.ts`(`createEngine`: fake 는 FakeEngine 로그인 시나리오, mobile 은 Android 백엔드 → 헬퍼 pending 대기 → engine-mobile; dispose 가 앱 종료·홈·백엔드 close), `run-once.ts`(`collectTestFiles` 이름순 `*.sinclair.ts`, `runOnce` → EXIT 0/1/2/3, 요약 로그), `main.ts` + `bin/sinclair-agent.mjs`(control-plane 과 같은 재실행 셸), 루트 `pnpm agent`. `@sinclair/protocol` 에 `./testing/fake-engine`, `./testing/login-scenario` export 추가(testing/index 는 vitest 를 끌어와 제품 코드에서 못 씀). 테스트: args 9, runOnce 5(verified, 실패→1·이름순, --run·409·404→3, device-unavailable→2·infra-failed, 빈 디렉터리→3·등록 없음), bin 스모크 1(control-plane bin + agent bin). `verify-runner-agent` 스킬(run-fake.sh, features/run-once.md) 구동: exit 0, finished/verified, evidence `02-run-once-fake-latest.json`.
- 남은 것: 실기기 opt-in `adb kill-server && SINCLAIR_TEST_USB=1 npx vitest run apps/runner-agent/test/run-once.device.test.ts` → `02-run-once-device-latest.json`. 그 뒤 두 축 리뷰.
- 2026-11-08: 실기기 통과(SM-N981N, 3.3s): exit 0, Cycle finished/verified, evidence `02-run-once-device-latest.json`.
- 2026-11-08 리뷰 반영(Standards + Spec): (1) **버그** — 409 가 "끝난 Cycle" 과 "이미 있는 Run" 둘 다라 `--run` + 끝난 Cycle 에서 에이전트가 재사용으로 오인해 이벤트를 쏟을 수 있었다. control-plane 이 404/409 응답에 `code`(`cycle-not-found`, `cycle-finished`, `run-exists`, `cycle-exists`)를 주고 클라이언트는 `run-exists` 일 때만 재사용 + 테스트. (2) `deviceId` 는 라벨이 아니라 시리얼(증거 파일에서만 마스킹), `run.started.agentId`(protocol 선택 필드 + 검증기 + 계약 테스트, 러너 옵션, 투영) 추가, `--agent` 기본 호스트명. (3) 엔진을 못 만들면 run.started + run.finished(infra-failed) 를 보고해 Cycle 에 blocked 가 드러난다 + 테스트; 그 과정에서 발견한 **Verdict 결함** — 케이스를 하나도 모르는 infra-failed run 이 verified 로 집계되던 것을 "모든 run 이 finished 여야 verified" 로 고치고 spec·테스트 반영. (4) `runOnce` 를 등록(`registerRun`)과 실행(`executeRun(args, run, files, deps)`)으로 분리(04 데몬이 클레임한 Run 으로 직접 실행), `deps.createReporter` 주입(03 스풀). (5) `collectTestFiles` 는 `AgentConfigError`; 빈 환경변수는 두 CLI 모두 미설정으로; `withDeviceUnavailable` 헬퍼를 protocol testing 으로 올려 러너·에이전트 테스트가 공유; 테스트 타임아웃 상수 근거 주석; CLAUDE.md 에 "apps 끼리 런타임 import 금지, 테스트 devDependency 만 허용" 명시. (6) 실기기 재실행 중 화면이 꺼져 트리가 비어 실패한 것을 보고 엔진 준비에 `KEYCODE_MENU`(비보안 잠금 해제) 추가 → 재실행 통과(2.7s). 미반영: bin 셸·parseArgs 오류 매핑의 두 앱 중복은 패키징 티켓(번들)에서 해소; 기기 준비/정리 헬퍼를 device-layer 로 올리는 것은 05 에서.
