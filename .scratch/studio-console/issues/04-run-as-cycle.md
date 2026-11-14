# 04: 내보내기 "Cycle 로 실행" + Console 링크

**What to build:** 내보내기 패널에서 지금 방식(자연어·결정적)의 코드를 테스트 폴더/<이름>/ 에 쓰고(메인이 경로를 정한다 — 렌더러는 이름·코드만), 자연어면 녹화 캐시에 저장, Cycle(타깃 = 고른 기기 deviceId) 등록 + Run. 진행(대기·실행 중·끝)과 Verdict, "Console 에서 보기"(기본 브라우저로 /console/cycles/:id). verify-studio·실기.

**Blocked by:** 01, 02, 03

**Status:** done

## 결과 (2026-11-14)

- 내보내기 패널 "Cycle 로 실행": 자연어면 녹화 먼저 저장 → 작업 프로세스가 테스트 폴더/<이름>/<이름>.sinclair.ts 에 쓰고(이름은 안전한 파일 이름, 폴더 밖 금지) Cycle(타깃 = 기기 표시 이름 열, deviceId 조건)·Run 등록. 3초마다 상태(대기 중·실행 중·끝 · Verdict). "Console 에서 보기" — 메인이 설정의 control-plane 아래 /console/ 만 기본 브라우저로.
- IPC: 렌더러는 이름·코드·기기만, control-plane·테스트 폴더는 메인이 설정에서 넣는다.
- 검증 훅 `SINCLAIR_STUDIO_USER_DATA`(verify-studio 가 사용자 설정을 건드리지 않게).
- verify-studio: fake 24/24(설정 대화상자·Cycle 등록·deviceId·Console 200·대기 중), 실기 22/22 — 데몬이 Studio 의 Cycle 을 돌려 끝 · verified, 자연어 act 재생 calls=0 6초.
