# 03: 디스크 스풀 Reporter — 프로세스·서버가 죽어도 이벤트를 잃지 않는다

**What to build:** 에이전트가 이벤트를 먼저 run 별 로컬 스풀 파일에 쓰고 거기서 control-plane 으로 보낸다. 에이전트 프로세스가 중간에 죽거나 control-plane 이 오래 내려가 있어도, `sinclair-agent resume` 이 스풀에 남은 이벤트를 같은 eventId 로 이어 보내 `GET /runs/:id` 가 완전해진다. 메모리 큐는 스풀이 대신하므로 상한 문제가 사라지고, 재시도는 상한(횟수·시간) 뒤 "스풀에 남김" 으로 끝난다. control-plane-ingest 03 에서 미룬 항목을 닫는다.

**Blocked by:** 02 (run 실행 CLI)

**Status:** done

- [x] 스풀 형식: run 마다 append-only JSONL 파일 + 전송 진행 표시(마지막으로 ack 된 위치). 쓰기는 이벤트 발생 즉시 동기 append(러너를 막지 않을 만큼 작게), 전송은 파일에서 읽어 배치
- [x] 스풀 Reporter 는 러너 `Reporter` 계약을 그대로 만족하고(onEvent/flush/close/warnings) 기존 HTTP Reporter 를 전송 계층으로 재사용한다
- [x] 재시도 상한(횟수 또는 총 시간, 이유 주석)을 넘기면 flush 가 경고와 함께 돌아오고 스풀에 미전송분이 남는다. `sinclair-agent resume [--spool <dir>]` 이 남은 run 들을 이어 보내고 비면 파일을 정리한다
- [x] 테스트: (a) 서버 없이 run → 스풀만 남음 → 서버 띄우고 resume → 투영이 단일 전송과 바이트 동일, (b) 전송 중 프로세스 강제 종료 흉내(ack 위치 뒤에서 중단) → resume 이 중복 전송하지만 Ingest 가 duplicate 로 흡수, (c) 손상된 마지막 줄(부분 쓰기)은 건너뛰고 경고
- [x] `sinclair-agent run` 의 기본 Reporter 가 스풀 Reporter 가 되고, 스풀 디렉터리는 설정값(기본 OS 데이터 디렉터리)
- [x] `verify-runner-agent` 에 "서버 내려간 채 run → resume" feature

## Comments

- 2026-11-08: 완료. 프리팩터: 러너 HTTP Reporter 에서 배치 한 번 보내기를 `postIngestBatch`(`packages/runner/src/ingest-client.ts`: done{ok}/retry/split 판정)로 끌어내 공유. `apps/runner-agent/src/spool.ts`: `createSpoolReporter({ dir, runId, controlPlane, cycleId, targetId, batchSize, flushIntervalMs, backoffMs, maxBackoffMs, maxRetryMs 60초, fetch })` — onEvent 는 `<runId>.jsonl` 에 동기 append, `<runId>.ack` 는 임시 파일 + rename, `<runId>.meta.json` 에 주소; `drainSpool` 이 미ack 줄을 배치로 보내며 ack 전진(413 분할, 깨진 줄 건너뛰고 경고), 예산 초과면 flush 가 경고("미전송 N건 … resume")로 돌아옴; close 는 다 보낸 스풀을 치움. `resumeSpool({ dir, controlPlane?, … })` 이 `*.jsonl` 을 순회해 이어 보내고 완료 run 의 파일 삭제. CLI: `run` 의 기본 Reporter 가 스풀(`--spool`/`SINCLAIR_AGENT_SPOOL`, 기본 OS 데이터 디렉터리/sinclair/spool), `--run` 이 있고 서버에 닿지 않으면 등록 없이 진행(이벤트는 스풀), `sinclair-agent resume [--spool] [--control-plane]`(종료 0 완료/1 미완/3 설정). 테스트: 스풀 6(즉시 디스크·ack·직접 전송과 바이트 동일·치움, 서버 없음→예산 경고→resume 동일·삭제, ack 뒤처짐→duplicate 흡수·meta 주소, 깨진 마지막 줄, 같은 포트 재기동 이어 보냄, meta), args 2, runOnce 2(executeRun 서버 다운→스풀→`main(['resume'])`, --run 오프라인 진행). `verify-runner-agent` 에 `spool-resume.sh` + `features/spool-resume.md`; 구동 증거 `03-spool-resume-latest.json`: run exit 0 + 스풀 2파일 + 경고, resume "완료 (ack 0 → 6)" exit 0, 스풀 비움, run finished.
- 결정: 재시도 예산은 총 시간(60초)이지 횟수가 아니다. 예산 뒤에는 run 을 끝내고(종료 코드는 테스트 결과대로) 전송은 resume 에 맡긴다. 간격 테스트의 고정 대기를 폴링으로 바꿔 전체 스위트 병렬 실행에서의 흔들림 제거.
- 2026-11-08 리뷰 반영(Standards + Spec): (1) **버그** — 같은 runId 로 스풀을 다시 열면(크래시 후 `--run` 재실행) `written` 이 0 에서 시작해 `close()` 가 옛 미ack 줄이 남은 파일을 지울 수 있었다. `written` 을 파일 줄 수로 초기화하고 삭제 판정을 파일 기준(ack ≥ 줄 수)으로 + 재개 회귀 테스트. (2) **버그** — 러너 flush 기한(10초)이 스풀 재시도 예산(60초)보다 짧아 예산이 무의미했다. 스풀 Reporter 가 `flushBudgetMs`(예산 + 5초)를 노출하고 `executeRun` 이 `reporterFlushTimeoutMs` 로 넘긴다. (3) 재시도 옵션을 `IngestRetryOptions` 로 묶고 값마다 이유 주석, `DEFAULT_MAX_RETRY_MS`. (4) 깨진 줄 경고를 구조화(정규식 되파싱 제거), `readSpoolLines` 비공개. (5) `run-once.ts` 의 도달 불가 경고 병합 블록 삭제. (6) `resume` 미완은 종료 코드 4(`EXIT.incomplete`), 도움말 갱신. (7) `spool-resume.sh` 가 서버 재기동을 `start.sh`(`SINCLAIR_INGEST_PORT` 로 같은 포트)로 위임, 죽은 `server.json.last` 제거. (8) 내구성 범위(fsync 없음, 프로세스 크래시까지)를 헤더 주석에. 미반영: 바이트 기준 배치 분할은 413 분할로 대신(control-plane-ingest 03 이월 항목 중 메모리 큐 상한은 닫힘, 바이트 배치는 미반영으로 기록). 04 메모: 데몬 시작 시 `resumeSpool` 호출, SIGTERM 은 스풀 close 만으로 안전.
