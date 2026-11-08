# Windows 배포본 실행 체크리스트 (사람이 수행, ready-for-human)

대상: `release/sinclair-<version>-win-x64.zip`(또는 `win-arm64`). macOS 에서 교차 빌드한 산출물이라 실행은 Windows 10/11 머신에서 확인한다. 결과는 `.scratch/packaging/evidence/04-windows-run-latest.json` 에 아래 템플릿으로 남긴다(기기 시리얼은 끝 4자만).

## 준비
- [ ] zip 을 `C:\sinclair\<version>\` 에 푼다(경로에 공백·한글 없이 먼저 시도, 그다음 공백 있는 경로로 한 번 더).
- [ ] `bin\sinclair-control-plane.cmd --help`, `bin\sinclair-agent.cmd run --help` 가 한국어 도움말을 내고 `echo %ERRORLEVEL%` 가 0.
- [ ] `node\node.exe --version` 이 `v24.13.0`(VERSION 파일과 같다).

## 서버
- [ ] `bin\sinclair-control-plane.cmd --port 4780` → `READY http://127.0.0.1:4780 … store=sqlite db=%APPDATA%\sinclair\control-plane.db schema=2`.
- [ ] 다른 창에서 `curl http://127.0.0.1:4780/health` → `{"ok":true}`.
- [ ] Ctrl-C → `SIGINT 수신, 종료 중` → `종료 완료` → `%ERRORLEVEL%` 0.
- [ ] 잘못된 설정(`--store postgres`) → 한국어 오류 + `%ERRORLEVEL%` 2.

## 에이전트(FakeEngine)
- [ ] 서버 띄운 뒤 `curl -X POST http://127.0.0.1:4780/cycles -d "{\"cycleId\":\"w\",\"build\":\"b\",\"targets\":[\"android\"]}"`.
- [ ] `tests\login.sinclair.ts` 에 샘플(README 의 fake 예시) 저장 후 `bin\sinclair-agent.cmd run --control-plane http://127.0.0.1:4780 --cycle w --target android --tests tests --engine fake` → `passed 1`, `%ERRORLEVEL%` 0.
- [ ] `curl http://127.0.0.1:4780/cycles/w` 의 `verdict` 가 `verified`.
- [ ] 스풀 디렉터리 `%APPDATA%\sinclair\spool` 이 비어 있다(다 보냈으면 치운다).

## 에이전트(실기기)
- [ ] 기기 드라이버: 장치 관리자에서 Android 기기가 WinUSB(또는 Zadig 로 교체)인지. `adb kill-server` 실행.
- [ ] `bin\sinclair-agent.cmd run --control-plane … --cycle d --target android --tests tests --device <serial> --app com.android.settings` → 헬퍼 APK `(bundled)` 로그 → `헬퍼 ready` → `passed 1`.
- [ ] 기기가 잠겨 있으면 `기기 화면이 잠겨 있음` 메시지와 `%ERRORLEVEL%` 2.

## 신호·스풀
- [ ] `bin\sinclair-agent.cmd daemon --control-plane … --targets android --tests tests --engine fake` 를 띄우고 Cycle 에 Run 을 등록 → 클레임·실행 로그 → Ctrl-C → `SIGINT 수신, 진행 중 run 을 마치고 멈춤` → `데몬 종료`.
- [ ] 서버를 내린 채 `run --run <id>` → `미전송 N건 … resume` 경고와 `%APPDATA%\sinclair\spool\<runId>.jsonl` → 서버 올리고 `bin\sinclair-agent.cmd resume` → `완료` 와 스풀 비움.

## 결과 템플릿 (`04-windows-run-latest.json`)
```json
{ "at": "YYYY-MM-DD", "windows": "11 23H2", "arch": "x64", "zip": "sinclair-0.1.0-win-x64.zip",
  "help": true, "nodeVersion": "v24.13.0", "server": {"ready": true, "ctrlC_exit": 0, "badConfig_exit": 2},
  "fake": {"exit": 0, "verdict": "verified"}, "device": {"serial": "…XXXX", "driver": "WinUSB", "apk": "bundled", "exit": 0},
  "daemon": {"ctrlC": "진행 중 run 마침"}, "spool": {"resume": "완료"}, "notes": "" }
```
