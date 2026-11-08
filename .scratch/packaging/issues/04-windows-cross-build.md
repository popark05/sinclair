# 04: Windows 배포본 교차 빌드와 검증

**What to build:** macOS 빌드 머신에서 `pnpm dist --targets win-x64,win-arm64` 가 Windows 배포본을 만들고, Windows QA 노드에서 zip 을 풀어 `bin\sinclair-control-plane.cmd` 와 `bin\sinclair-agent.cmd` 로 같은 흐름(서버 기동, `run --engine fake`, 실기기 run)이 동작한다. 신호 차이(SIGTERM 없음: 데몬 종료는 Ctrl-C 또는 프로세스 종료, 진행 중 run 의 스풀은 `resume` 으로), 경로 구분자, `%APPDATA%` 데이터 디렉터리, `node-usb` 의 WinUSB 드라이버 요구를 정리한다.

**Blocked by:** 02 (배포본)

**Status:** ready-for-agent

- [ ] mac 에서 win 타깃 조립이 성공하고(Node zip 추출, `usb-win32-*-msvc` 패키지 포함), 구성 목록 테스트가 Windows 전용 파일(`.cmd`, `node.exe`)을 확인한다
- [ ] `.cmd` 런처가 인자·환경변수를 그대로 넘기고 종료 코드를 보존한다(mac 에서는 내용 검사로, Windows 에서는 실행으로)
- [ ] Windows 에서의 검증 체크리스트(사람이 수행, ready-for-human): 서버 기동·`run --engine fake`·실기기 run·Ctrl-C 종료·`resume`. 수행 결과를 `.scratch/packaging/evidence/` 에 남긴다
- [ ] Windows 고유 사항 문서: WinUSB 드라이버(Zadig) 또는 adb 서버 fallback 선택, `%APPDATA%\sinclair`, 스풀 lock 의 pid 재사용 한계, 방화벽(127.0.0.1 바인딩이라 불필요)
- [ ] bin 셸·데몬의 Windows 신호 한계가 코드 주석과 README 에 일치한다
