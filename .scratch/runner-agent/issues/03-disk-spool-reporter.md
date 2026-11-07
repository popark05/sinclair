# 03: 디스크 스풀 Reporter — 프로세스·서버가 죽어도 이벤트를 잃지 않는다

**What to build:** 에이전트가 이벤트를 먼저 run 별 로컬 스풀 파일에 쓰고 거기서 control-plane 으로 보낸다. 에이전트 프로세스가 중간에 죽거나 control-plane 이 오래 내려가 있어도, `sinclair-agent resume` 이 스풀에 남은 이벤트를 같은 eventId 로 이어 보내 `GET /runs/:id` 가 완전해진다. 메모리 큐는 스풀이 대신하므로 상한 문제가 사라지고, 재시도는 상한(횟수·시간) 뒤 "스풀에 남김" 으로 끝난다. control-plane-ingest 03 에서 미룬 항목을 닫는다.

**Blocked by:** 02 (run 실행 CLI)

**Status:** ready-for-agent

- [ ] 스풀 형식: run 마다 append-only JSONL 파일 + 전송 진행 표시(마지막으로 ack 된 위치). 쓰기는 이벤트 발생 즉시 동기 append(러너를 막지 않을 만큼 작게), 전송은 파일에서 읽어 배치
- [ ] 스풀 Reporter 는 러너 `Reporter` 계약을 그대로 만족하고(onEvent/flush/close/warnings) 기존 HTTP Reporter 를 전송 계층으로 재사용한다
- [ ] 재시도 상한(횟수 또는 총 시간, 이유 주석)을 넘기면 flush 가 경고와 함께 돌아오고 스풀에 미전송분이 남는다. `sinclair-agent resume [--spool <dir>]` 이 남은 run 들을 이어 보내고 비면 파일을 정리한다
- [ ] 테스트: (a) 서버 없이 run → 스풀만 남음 → 서버 띄우고 resume → 투영이 단일 전송과 바이트 동일, (b) 전송 중 프로세스 강제 종료 흉내(ack 위치 뒤에서 중단) → resume 이 중복 전송하지만 Ingest 가 duplicate 로 흡수, (c) 손상된 마지막 줄(부분 쓰기)은 건너뛰고 경고
- [ ] `sinclair-agent run` 의 기본 Reporter 가 스풀 Reporter 가 되고, 스풀 디렉터리는 설정값(기본 OS 데이터 디렉터리)
- [ ] `verify-runner-agent` 에 "서버 내려간 채 run → resume" feature
