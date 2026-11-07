# 02: runner-agent CLI 로 run 하나를 끝까지 실행한다

**What to build:** 기기 노드에서 `sinclair-agent run --control-plane <url> --cycle <id> --target <id> --tests <dir> [--device <serial> | --engine fake]` 를 치면, 에이전트가 Cycle 에 Run 을 등록하고(또는 `--run <id>` 로 지정된 Run 을 쓰고), 테스트 파일을 모아 엔진(실기기면 engine-mobile + Android 백엔드, 아니면 FakeEngine)으로 `runTests` 를 돌리며, 이벤트를 HTTP Reporter 로 control-plane 에 흘려보낸다. 끝나면 요약(통과/실패/blocked/skipped, Reporter 통계, 경고)을 출력하고 실패가 있으면 0 이 아닌 코드로 끝난다. Console 없이 `GET /cycles/:id` 에서 결과가 보인다.

**Blocked by:** 01 (서버 엔트리)

**Status:** ready-for-agent

- [ ] CLI 파싱과 설정(플래그 > 환경변수 > 기본값), 한국어 도움말. 테스트 파일은 `--tests` 디렉터리의 `*.sinclair.ts` 를 정렬된 순서로
- [ ] Run 등록: `--run` 이 없으면 `POST /cycles/:id/runs` 로 발급. 등록 실패(모르는 Cycle, 끝난 Cycle 409)는 명확한 메시지로 종료
- [ ] 엔진 선택: `--engine fake` 는 FakeEngine(로그인 시나리오), 기본은 디바이스 레이어의 Android 백엔드 위 engine-mobile(`--device` 필수, 헬퍼 온보딩 대기). 엔진 생성·dispose 가 run 수명과 같다
- [ ] HTTP Reporter 로 전송, run 끝에 flush·close. 종료 코드: 전부 통과 0, 실패 1, blocked(기기 불가) 2, 설정 오류 3
- [ ] 테스트: 인프로세스 control-plane 서버 + FakeEngine 으로 CLI 모듈을 호출해 `GET /cycles/:id` 가 finished 와 매트릭스를 돌려준다. 자식 프로세스로 실제 bin 을 한 번 실행하는 스모크
- [ ] 실기기 opt-in 테스트(`SINCLAIR_TEST_USB=1`)로 설정 앱 샘플이 실기기 → control-plane 까지 흐른 증거를 `.scratch/runner-agent/evidence/` 에 남긴다(시리얼 마스킹)
- [ ] `verify-runner-agent` 검증 스킬 시드: control-plane 띄우기 → `sinclair-agent run --engine fake` → Cycle 조회 증거
