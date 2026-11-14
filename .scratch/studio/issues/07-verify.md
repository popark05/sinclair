# 07: 검증 — verify-studio 스킬과 실기기 종단

**What to build:** Studio 를 실제로 띄워(Electron) 기기 화면·Inspector·세션·내보내기를 구동하고 증거를 남기는 `verify-studio` 스킬(Playwright `_electron` 또는 동등). 실기기에서 YouTube 검색 세션 → 내보내기 → 내보낸 테스트를 runner-agent 로 실행해 통과.

**Blocked by:** 06

**Status:** done

## 결과 (2026-11-14)

- `.claude/skills/verify-studio`(SKILL.md + `scripts/verify.ts`): 빌드된 Studio 를 Playwright `_electron`(`playwright-core` 1.64.1, Studio devDependency)으로 띄워 기기 화면 → 화면 클릭 탭·하이라이트·locator 후보 → 트리 검색 → 세션 → 판정 → 자연어/결정적 내보내기(클립보드)·녹화 캐시 저장 → 내보낸 테스트 실행까지.
- fake 모드(가짜 기기 서버 + 가짜 Claude API `ANTHROPIC_BASE_URL` + 메모리 control-plane): 14/14, 제품 코드에 검증용 분기 없음.
- 실기(SM-N981N, YouTube, 실제 모델): 12/12 — 세션 4턴·모델 4회, 데몬이 내보낸 두 테스트 Cycle verified, 자연어 act `cache=replayed calls=0`.
- 실기에서 찾은 것: 앞 테스트가 남긴 앱 상태 때문에 결정적 테스트 실패 → 실패 테스트 먼저 커밋(56afa29) 후 계약 `session.restart(target?)`·러너 `app.restart(앱)`·내보내기 `app.restart`. 같은 이름 두 테스트가 Cycle 셀에서 합쳐지는 것, 세션이 앱 처음 화면이 아닌 곳에서 시작하면 녹화가 재생되지 않는 것(스킬 함정에 기록).
- 후속 후보: 세션 시작 전에 "앱 처음부터" 옵션(세션 직전 restart)과, 처음 화면이 아닌 곳에서 시작한 세션을 내보낼 때 경고.
