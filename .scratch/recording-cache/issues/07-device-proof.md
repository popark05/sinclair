# 07: 실기기 종단 — YouTube 검색 녹화 → 재생 → 이어받기

**What to build:** 실제 모델로 YouTube 검색 테스트를 한 번 돌려 녹화(control-plane 저장), 두 번째는 모델 호출 0 으로 재생 통과, 세 번째는 검색어를 바꾸지 않고 화면을 바꿔(예: 앱 상태) 이어받기를 보인다. 증거 `.scratch/recording-cache/evidence/07-device-latest.json`.

**Blocked by:** 03, 05

**Status:** done

## Comments

- 2026-11-14 실기기(SM-N981N, Sonnet 5.5, control-plane SQLite 공유 저장, 데몬 `--cache` 기본 read-write). 증거 `evidence/07-device-latest.json`.
  - rc-5 녹화(라이브): 모델 11회·입력 13.9k 토큰, verified. rc-6 재생: act 모델 0회(한국어 13.3→5.9초), Cycle 모델 2회(판정만)·2.9k 토큰, verified.
  - rc-7 이어받기: 저장된 녹화의 입력창 placeholder 를 바꿔 앱 변경을 흉내 → 재생 1/3 뒤 에이전트가 이어받아 통과, 녹화가 올바른 대상으로 갱신. rc-8 다시 완전 재생.
- 실기기에서 찾아 고친 결함(각각 실패 테스트 먼저): (1) 끝 anchor 에 자동재생 영상 버튼 같은 우연한 UI → 과반 규칙, (2) 이름 없는 검색 기록 줄이 `button` 만으로 녹화돼 15개 중 애매 → 자식 글자 라벨(`cacheLabelOf`) + 녹화 때 정확히-하나 확인, (3) 이어받은 act 의 anchor 가 이어받은 화면 기준이라 비는 문제 → `anchorsFrom`(재생 시작 화면), (4) 재생이 2초 만에 끝나 검색 결과가 비어 있는 채로 판정 실패 → 끝 뒤 1.5초 잠잠해질 때까지(상한 8초). 정책 `exact/2`.
- 남은 것: 결과 화면의 자동재생 영상처럼 계속 바뀌는 화면은 잠잠해지지 않아 상한(8초)까지 기다린다(영어 검색 재생 10.2초) — 비교 서명에서 영상 플레이어 하위를 빼거나 녹화 당시의 끝 대기 시간을 기록하는 개선 후보.
