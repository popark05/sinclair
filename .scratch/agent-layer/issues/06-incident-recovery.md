# 06: Incident 복구 — 예상 밖 화면을 알아보고 정해진 방법으로 되돌린다

**What to build:** 목표를 하던 중 권한 요청·시스템 다이얼로그·키보드가 화면을 가리거나, 액션이 실패하거나, 앱이 엉뚱한 화면으로 가면 에이전트가 이를 Incident 로 분류하고 정해진 복구(닫기·뒤로·키보드 내리기·앱 다시 열기)를 정해진 횟수 안에서 시도한다. 복구가 안 되면 사유와 함께 act 를 실패시킨다. 모델이 매번 즉흥으로 헤매지 않게 하고, 어떤 Incident 가 얼마나 났는지 스텝에서 보인다.

**Blocked by:** 05 (액션 전 안전망)

**Status:** done

- [x] Incident 종류와 감지 규칙(트리 특징·엔진 오류 코드), 종류별 복구 순서와 시도 상한(이유 주석)
- [x] 복구는 결정적 동작 우선(엔진 조작), 그래도 안 되면 모델에게 "Incident 상황" 을 알리고 한 번 묻는다
- [x] 복구 시도와 결과가 스텝 instruction 에 남는다. 같은 Incident 가 반복되면 루프로 보고 멈춘다
- [x] 테스트: FakeEngine 에 다이얼로그·권한 요청·액션 실패를 끼워 넣어 복구 성공과 상한 초과 실패를 확인

## Comments

- 2026-11-09 구현(seam 3개 승인, 권한 기본 allow): (1) 규칙표 `detectIncident`·`packageOf`·`appPackageOf`(`packages/agent/src/incidents.ts`) (2) 루프: 모델 호출 전 감지·결정적 복구(턴·모델 호출 없음), 종류별 상한(permission 3·그 밖 2), 복구 뒤 같은 창이 두 번 그대로면 무효, 상한·무효·복구 없음이면 `StepRequest.incident` 로 한 번 알리고 그 뒤에도 그대로면 act 실패. keyboard(입력 바로 뒤 tap·scroll 오류 → 내리고 한 번 더)·action-failed(같은 호출 연속 2번 알림, 3번 실패)는 액션 결과로 (3) 러너 instruction `[Incident: 종류→동작 ×N]`, `RunOptions.agent.incidents`, `SINCLAIR_AGENT_ACT_PERMISSION`, Claude 프롬프트에 ⚠ Incident 줄.
- 승인안에서 바꾼 점: left-app 의 "act 시작 때와 다르면 다시 열기" 는 **런처일 때만** 다시 연다. 다른 앱(브라우저 로그인·공유 시트·결제 앱)은 목표의 일부일 수 있어 결정적 복구 없이 모델에게 알린다. 시작 패키지는 첫 관찰의 resource-id 다수결(권한 창·런처면 모름 — 그러면 left-app 감지 안 함).
- 권한 창은 문구까지 signature 에 넣어 카메라·마이크를 다른 창으로 센다. "이번만 허용" 은 다음 실행에 다시 물어 결과가 흔들리므로 고르지 않는다.
- 감지는 resource-id 에 기댄다(Android). iOS·웹은 다음에(문구는 언어·제조사마다 달라 보조로만).
- 검증: packages·control-plane 694 통과, runner-agent 88 통과(전과 달리 부하 실패 없음).
- 리뷰 반영(must-fix 2 + should-fix 6 + nit): (M1) 다른 앱으로의 이동(결정적 복구 없음)은 한 번 알리고 그 앱에 머무는 동안 다시 알리거나 실패시키지 않는다 — 브라우저 로그인 여러 턴 테스트. (M2) 키보드 복구는 엔진이 키보드가 떠 있다고 말할 때만(엔진 계약에 선택 `keyboard.shown()` 추가, 계약 스위트·FakeEngine 먼저), 비활성 대상은 키보드 탓이 아님, 내린 뒤 다시 관찰·재탐색한 ref 로 재시도. **engine-mobile 은 아직 shown 을 구현하지 않아 실기기에서는 키보드 복구가 꺼져 있다**(dumpsys input_method 경로는 디바이스 레이어 RPC 가 필요 — 08 실기기 티켓 또는 후속). (S1) 다시 열기는 act 시작 때의 앱 패키지로, 모르면 결정적으로 하지 않음. (S2) 복구 동작을 시간 한도와 경주, 내부 루프마다 abort 검사. (S3) 모델이 고른 뒤 실행 전에 끼어든 창은 실행하지 않고 다음 턴이 복구(모델이 본 화면에 이미 있던 창은 예외). (S4) 모델에게 알린 Incident 도 기록(`모델에 알림`). (S6) 권한 버튼은 시스템 권한 창 노드에서만, Android 14 `permission_allow_all_button`, `aerr_restart`. (T1) 러너 테스트를 정책 deny 로. nit: 알림은 덮어쓰지 않고 이어 붙임, 기록하는 동작 문구도 비밀값 가림, action-failed 상한 상수 정리, 키보드 조건 단순화, GLOSSARY Incident 정의, button1 만 쓰는 시스템 창은 감지하지 않는다는 주석.
