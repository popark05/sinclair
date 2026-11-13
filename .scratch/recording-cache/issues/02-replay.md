# 02: 재생 — 녹화가 있으면 모델 없이 액션을 다시 한다

**What to build:** act 전에 키로 조회해 항목이 있으면 전제(foreground 앱) 확인 → 액션마다 정확히 하나 일치로 대상 찾기(0개면 백오프) → 실행 → 끝 anchor·화면 변화 확인. 모두 통과하면 `cache: 'replayed'`, 모델 호출 0.

**Blocked by:** 01

**Status:** done

- [x] 정확히-하나 매처(역할·이름(없으면 글자)·testId·placeholder 모두 같음), 0개 백오프 100·300·600·1000ms(상한 3초), 둘 이상 즉시 어긋남
- [x] `type` 자리표시를 이번 실행 비밀값으로, 비밀값 없으면 어긋남
- [x] 끝 확인: anchor 전부 존재(5초 폴링) + 재생 전과 화면이 달라짐
- [x] 스텝 instruction `act "…" → 재생 n/n`, modelCalls 0
- [x] 첫 액션 전 어긋남(항목 없음·전제 불일치·대상 없음)은 live 로(사유)
- [x] 테스트: 같은 테스트 두 번 — 두 번째는 실행기를 한 번도 부르지 않는다

## Comments

- 2026-11-14 구현. agent `replay.ts` `replayRecording(engine, entry, {goal, secrets, findTimeoutMs, endTimeoutMs})` → `replayed | missed(첫 액션 전) | diverged(하나 이상 한 뒤, done 요약)`. `exactMatches`: 녹화한 정체 필드가 모두 같고 녹화에 없는 필드는 현재 노드에도 없는 노드. 0개 백오프 100·300·600·1000ms(상한 3초), 둘 이상 즉시 멈춤. 액션은 action spec 의 `run` 그대로(엔진의 액션 뒤 대기 포함). 비밀값은 목표에 나온 이름만 이번 실행 값으로. 끝: anchor 모두 존재 + 재생 전 화면과 정체 서명이 다름(상한 5초). 기기 오류(device-unavailable·engine-closed)는 그대로 던짐. runner: 캐시 켜지면 act 전에 관찰로 앱을 알아 키 계산 → 첫 시도만 조회 → replayed 면 `act "…" → 재생 n/n`·modelCalls 0·cache replayed, missed 면 경고 + 라이브(새 녹화가 옛 항목을 덮어 고침), diverged 면 라이브로 `재생 k/n 뒤 이어받음(사유) → …`·cache handed-off(접두부 전달·합친 재녹화는 03). 저장소 읽기 오류는 미스(경고). `cache.findTimeoutMs`·`endTimeoutMs` 옵션.
