# 03: 이어받기 — 재생이 중간에 어긋나면 그 화면부터 에이전트가

**What to build:** 액션을 하나 이상 재생한 뒤 어긋나면 `runAct` 에 재생한 접두부(액션 요약·멈춘 곳·이유, "다시 하지 말고 현재 화면에서 이어서")를 넘겨 이어받는다. 성공하면 처음부터 다시 스테이징. 재생에 쓴 항목이 실패와 함께였으면 지운다.

**Blocked by:** 02

**Status:** done

- [x] `ActOptions.replayedPrefix`, 실행기 프롬프트(Ledger)에 접두부 블록
- [x] `cache: 'handed-off'`, instruction `→ 재생 2/3 뒤 이어받음(사유) → …`
- [x] 이어받아 성공 + 검증 통과면 새 항목으로 덮어씀, 실패면 원래 항목 지움
- [x] 테스트: 화면이 바뀐 FakeEngine(둘째 버튼 이름 변경)으로 재생 1 → 이어받기 → 새 녹화

## Comments

- 2026-11-14 구현. agent: `ActOptions.replayedPrefix {done, total, reason}` → 매 턴 요청의 `handOff`(가림 적용): "녹화 재생이 이 목표의 액션 k/n 을 이미 했다: 1) …. 멈춘 곳·이유: …. 다시 하지 말고 지금 화면에서 이어서 — 앞 액션의 결과가 반영됐는지 먼저 확인". Ledger 가 목표 아래 `↪` 줄로(상한 800자). runner: diverged 면 접두부를 넘겨 runAct, 성공 시 녹화 = 원래 녹화의 앞 k 액션 + 에이전트 액션(시작 전제는 원래 것, 50개 넘으면 기록 안 함), 검증 뒤 커밋으로 옛 항목을 덮음. 재생에 쓴 녹화(완전 재생·이어받음)는 시도가 실패했고 뒤 검증으로 확인되지 않았으면 지움 — ModelConfigError·SecretMissing·device-unavailable·engine-closed 실패는 지우지 않음. `TestResult.cache.evicted`.
