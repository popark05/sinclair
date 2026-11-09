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
