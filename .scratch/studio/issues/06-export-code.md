# 06: 코드로 내보내기 — 자연어 또는 결정적 locator

**What to build:** 세션을 `*.sinclair.ts` 테스트 코드로 내보낸다. (a) 자연어: `agent.act` + `agent.assert`(녹화 캐시는 저장소에), (b) 결정적: 녹화한 액션을 locator 코드로 풀고 판정은 자연어 또는 `expect(...).toBeVisible()`. 클립보드·파일 저장.

**Blocked by:** 05

**Status:** done

- [x] 결정적 변환: 녹화 기술자 → `getByTestId`/`getByRole(name)`/`getByText` 우선순위, 비밀값은 `secret('이름')`
- [x] 내보낸 코드가 FakeEngine 에서 그대로 통과하는지 테스트(왕복)

## 결과 (2026-11-14)

- `apps/studio/src/shared/export.ts` `exportTest`: 자연어(`app.open` + `agent.act` + 참이었던 판정만 `agent.assert`, 거짓은 주석)와 결정적(ok 턴과 녹화 액션을 짝지어 그 화면에서 하나로 정해진 locator 로 `tap`/`type`/`press('Enter')`/`app.back`, 스크롤은 주석, locator 없으면 TODO). 비밀값 자리표시는 `secret('이름')`.
- 세션 턴마다 그 화면의 유일 locator(`TurnView.locator`, agent `onTurn` 이 관찰을 넘긴다), 결과에 시작 앱 `startApp`.
- ExportPanel: 방식 전환·이름·미리보기·복사·파일 저장(메인 저장 대화상자, 크기 제한)·녹화 캐시에 저장(`save-recording` → control-plane `PUT /cache/:key`, 첫 실행부터 모델 없이 재생).
- 왕복 테스트 `apps/studio/test/export-roundtrip.test.ts`: 내보낸 코드를 그대로 러너에 넣어 FakeEngine 에서 통과(결정적은 act 모델 0회).
- 실기(SM-N981N, YouTube): 결정적 내보내기를 데몬이 locator 만으로 통과(`studio-export-1`). 자연어 + 녹화 저장은 처음에 재생이 입력 단계에서 어긋남 — 검색창에 직전 검색어가 남아 라벨이 달랐다. 입력 역할은 이름만 라벨(정책 `exact/3`)로 고친 뒤 `studio-export-natural-2` verified, act `cache=replayed calls=0` 5.6초.
- 알려진 한계: `app.open` 은 앱 상태를 초기화하지 않는다(직전 검색어·화면이 남음). → 07 에서 내보내기 첫 줄을 `app.restart(앱)` 으로 바꿔 해결.
