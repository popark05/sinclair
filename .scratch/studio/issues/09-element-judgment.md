# 09: 요소 판정 — 고른 노드로 결정적 expect(모델 없이)

**What to build:** 판정을 문장(agent.assert)만이 아니라 Inspector·화면에서 고른 노드로도 더한다. 검사 종류: 보인다·안 보인다·글자가 같다·글자를 포함·값이 같다·체크됨·비활성(러너 expect 의 toBeVisible·toBeHidden·toHaveText·toContainText·toHaveValue·toBeChecked·toBeDisabled). 더하는 순간 작업 프로세스가 러너의 screen/expect 로 지금 화면에서 돌려 통과·실패와 사유를 보인다(모델 없음). 내보내기는 `await expect(locator).toX(...)` 로(실패한 것은 주석), 결정적 내보내기는 판정까지 모델 0회가 될 수 있다.

**Blocked by:** 08

**Status:** done

- [x] 공유 정의(검사 종류 ↔ 러너 메서드 ↔ 코드, 질의 → locator 코드, 질의 검사기)
- [x] IPC `expect-check`(닫힌 질의·검사 종류·값 길이), 작업 프로세스가 러너 expect 로 판정
- [x] 세션 패널 "선택한 노드로 판정" 줄, 판정 목록에 두 종류, 내보내기
- [x] verify-studio 에 요소 판정 검사

## 결과 (2026-11-14)

- `shared/expect-judge.ts`: 검사 종류 7개(보인다·안 보인다·글자가 같다·글자를 포함·값이 같다·체크됨·비활성) ↔ 러너 expect 메서드 ↔ 코드, 질의 → locator 코드, 렌더러 질의 검사기(아는 키·문자열 1~500자·찾을 근거 하나 이상).
- IPC `expect-check`(값은 값이 있는 검사에만), 작업 프로세스가 러너 `createScreen`·`expect` 로 지금 화면에서(기다림 1.5초, 모델 없음). 판정은 `Judgment` = 문장 | 요소.
- 세션 패널: 고른 노드가 하나로 정해지면 "선택한 노드: <locator>" + 검사 종류 + (값) + "요소 판정", 아니면 안내. 값 칸은 노드의 글자·값으로 채워 둔다. 목록에 `통과 · expect(...).toBeVisible()`.
- 내보내기: 통과한 요소 판정은 `await expect(locator).toX(...)`(fixture expect·screen), 실패는 주석. 요소 판정만이면 결정적 테스트는 모델 0회(왕복 테스트: 실행기 없이 통과).
- 발견: 공유 모듈이 locators(→ @sinclair/protocol 런타임)를 import 해 메인 프로세스에서 Electron 이 TS 소스를 못 읽어 앱이 뜨지 않음 → `shared/js-string.ts` 로 분리, `test/main-imports.test.ts` 가드(메인·preload 가 닿는 모듈에 워크스페이스 런타임 import 금지; 옛 import 로 되돌리면 실패함을 확인).
- verify-studio: fake 18/18, 실기 SM-N981N YouTube 16/16(검색창 노드 요소 판정 통과, 내보낸 결정적 테스트에 expect 포함 → 데몬 Cycle verified).
