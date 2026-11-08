# 04: Windows 배포본 교차 빌드와 검증

**What to build:** macOS 빌드 머신에서 `pnpm dist --targets win-x64,win-arm64` 가 Windows 배포본을 만들고, Windows QA 노드에서 zip 을 풀어 `bin\sinclair-control-plane.cmd` 와 `bin\sinclair-agent.cmd` 로 같은 흐름(서버 기동, `run --engine fake`, 실기기 run)이 동작한다. 신호 차이(SIGTERM 없음: 데몬 종료는 Ctrl-C 또는 프로세스 종료, 진행 중 run 의 스풀은 `resume` 으로), 경로 구분자, `%APPDATA%` 데이터 디렉터리, `node-usb` 의 WinUSB 드라이버 요구를 정리한다.

**Blocked by:** 02 (배포본)

**Status:** ready-for-human

- [x] mac 에서 win 타깃 조립이 성공하고(Node zip 추출, `usb-win32-*-msvc` 패키지 포함), 구성 목록 테스트가 Windows 전용 파일(`.cmd`, `node.exe`)을 확인한다
- [x] `.cmd` 런처가 인자·환경변수를 그대로 넘기고 종료 코드를 보존한다(mac 에서는 내용 검사로, Windows 에서는 실행으로)
- [ ] Windows 에서의 검증 체크리스트(사람이 수행, ready-for-human): 서버 기동·`run --engine fake`·실기기 run·Ctrl-C 종료·`resume`. 수행 결과를 `.scratch/packaging/evidence/` 에 남긴다
- [x] Windows 고유 사항 문서: WinUSB 드라이버(Zadig) 또는 adb 서버 fallback 선택, `%APPDATA%\sinclair`, 스풀 lock 의 pid 재사용 한계, 방화벽(127.0.0.1 바인딩이라 불필요)
- [x] bin 셸·데몬의 Windows 신호 한계가 코드 주석과 README 에 일치한다

## Comments

- 2026-11-08: mac 쪽 완료. 실제 교차 조립 `pnpm dist --targets win-x64,win-arm64`: Node 24.13.0 Windows zip 을 nodejs.org 에서 받아 SHASUMS256 검증·bsdtar 로 추출(캐시), `node.exe`+LICENSE, `.cmd` 런처 2개, `@node-usb/usb-win32-{x64,arm64}-msvc`, 번들 헬퍼 APK+sha256 포함 → 33.6 MB / 30.0 MB (`04-windows-cross-latest.json` 구성 확인). `fetchNode` 의 zip 추출 경로 단위 테스트(페이크 zip 릴리스 서버) 추가. `.cmd` 내용 테스트 강화(`@echo off`+CRLF, `set "DIR=%~dp0.."`, 플래그 하나·`%*`, `exit /b %ERRORLEVEL%`). 생성 README 에 `## Windows` 절(`.cmd` 실행, `%APPDATA%\sinclair`, WinUSB/Zadig·adb kill-server·adb 서버 모드 미노출(정직), SIGTERM 없음→Ctrl-C 로 진행 중 run 마침·강제 종료 시 스풀→resume, 스풀 lock pid 재사용 한계, 방화벽 불필요(127.0.0.1)·외부 바인딩 주의, 교차 빌드 안내)를 Windows 타깃에만 넣고 테스트. 체크리스트 `.scratch/packaging/windows-checklist.md`(준비·서버·FakeEngine·실기기·신호/스풀 + 결과 템플릿). bin 셸·데몬·스풀의 Windows 신호 주석과 README 가 일치.
- 남은 것(사람): Windows 10/11 머신에서 체크리스트 수행 → `.scratch/packaging/evidence/04-windows-run-latest.json`. adb 서버 경유 모드를 에이전트 옵션으로 노출할지는 결과를 보고 결정(device-layer 에는 `adbServerFallback` 옵션이 있음).
- 2026-11-08 리뷰 반영(Standards + Spec): (1) 구성 증거를 수기가 아니라 조립이 남기는 `release/sinclair-<version>-<target>.manifest.json`(target·version·node·helper·builtOn·zipMb·files) 복사로 바꿈 — 재생성 명령 `pnpm dist --targets win-x64,win-arm64`. (2) 설치본 README 의 Windows 절: 리포 내부 경로(.scratch) 제거, 종료 코드 보존을 "그렇게 돼 있다" 로(실행 미검증), 스풀 lock 에 Windows 타 사용자 EPERM 한계 추가(spool.ts 주석과 일치), 절을 문서 끝으로. 테스트가 `.scratch` 부재와 매니페스트를 확인. (3) fetchNode zip 테스트는 `zip` CLI 없으면 skip. (4) Status 줄의 괄호 부연은 Comments 로. 남은 것은 변함없이 Windows 머신에서의 체크리스트 수행(→ `04-windows-run-latest.json` → done) 과 adb 서버 경유 옵션 노출 결정.
