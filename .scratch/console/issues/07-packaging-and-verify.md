# 07: 배포·검증 — 설치본에 Console 이 들어 있고 실제로 열린다

**What to build:** `pnpm dist` 설치본이 Console 정적 파일을 동봉하고 control-plane 런처가 기본으로 `/console` 을 서빙한다. `verify-console` 스킬이 실제 control-plane + 가짜 에이전트로 Cycle 을 채우고 헤드리스 브라우저로 목록·매트릭스·상세·플릿 화면을 확인해 증거를 남긴다.

**Blocked by:** 01, 02, 03, 04, 05, 06

**Status:** ready-for-agent

- [ ] 번들·설치본에 Console 동봉, 런처 기본 서빙, 기존 dist 테스트 갱신
- [ ] `verify-console` 스킬(Launch/Drive/Evidence), 스크린샷·DOM 증거(개인정보 없음)
