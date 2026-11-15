# 06: iOS 앱 상태 복원 — app.restart 가 처음 화면이 아니다

**Status:** done

## 증상

실기 iPhone(iOS 17.6.1)에서 설정 앱을 `app.restart` 해도 마지막 화면(디스플레이 및 밝기·키보드)이 열려, 에이전트가 1턴에 끝나고 녹화는 시작 화면이 어긋나 재생 대신 라이브로 돌았다.

## 원인 (실기·시뮬레이터 실험)

| 시나리오 | iOS 26 시뮬레이터 | iOS 17 실기 |
|---|---|---|
| 앞 화면에서 terminate → activate | 첫 화면 | 첫 화면 |
| terminate → 3초 → activate | 첫 화면 | 첫 화면 |
| `XCUIApplication.launch()` | 첫 화면 | 첫 화면 |
| 홈(백그라운드) → terminate → activate | 첫 화면 | **복원됨** |

앱은 백그라운드로 갈 때 화면 상태를 저장하고 다음 실행에 복원한다. 데몬 정리(cleanup)가 Run 끝에 홈을 눌러 앱이 백그라운드로 가며 저장 → 다음 Run 의 restart(terminate → launch)가 복원.

## 고침

러너 `terminate`: 앞 화면이 아니면 먼저 activate(저장된 상태를 여기서 써 버림) 뒤 앞 화면인 채로 종료. 실기 확인: 홈 → (새) terminate → activate 첫 화면, 옛 방식으로 이미 종료된 상태에서도 (새) terminate 한 번으로 첫 화면.

## 확인

- 실기 러너 확인 스크립트 11/11(빌드 직후 첫 실행은 9/11, 다시 돌려 11/11 — 첫 실패 항목은 남기지 못함).
- 데몬 Cycle 두 번: 첫 번째 첫 화면에서 3턴(일반·키보드) 녹화, 두 번째 **재생 2/2·act 모델 0회** verified.
