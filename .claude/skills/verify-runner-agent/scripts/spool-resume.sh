#!/usr/bin/env bash
# 스풀·resume 증명: Cycle/Run 을 등록한 뒤 control-plane 을 내리고 `sinclair-agent run --run` 을 돌려 스풀만 남게 한 다음,
# 같은 포트로 다시 띄워 `sinclair-agent resume` 이 이어 보내는지 본다. 증거: evidence/spool-resume.json
# 사용: scripts/spool-resume.sh <RUN_DIR>   (verify-ingest start.sh 로 서버가 떠 있어야 한다. 끝나면 서버는 다시 떠 있는 상태)
set -uo pipefail
RUN_DIR=${1:?RUN_DIR 필요}
I=$(cd "$(dirname "$0")/../../verify-ingest/scripts" && pwd)
PORT=$(node -p "JSON.parse(require('fs').readFileSync('$RUN_DIR/server.json','utf8')).port")
URL="http://127.0.0.1:$PORT"; CYCLE="spool-$(date +%s)-$$"; RUNID="run-$CYCLE"; SPOOL="$RUN_DIR/spool"
mkdir -p "$RUN_DIR/evidence"
curl -s -X POST "$URL/cycles" -H 'content-type: application/json' --data "{\"cycleId\":\"$CYCLE\",\"build\":\"verify\",\"targets\":[\"android\"]}" >/dev/null
curl -s -X POST "$URL/cycles/$CYCLE/runs" -H 'content-type: application/json' --data "{\"targetId\":\"android\",\"runId\":\"$RUNID\"}" >/dev/null
"$I/stop.sh" "$RUN_DIR" >/dev/null   # 서버 다운
RUN_OUT=$(SINCLAIR_AGENT_SPOOL="$SPOOL" node apps/runner-agent/bin/sinclair-agent.mjs run --control-plane "$URL" --cycle "$CYCLE" --target android --run "$RUNID" --tests apps/runner-agent/test/fixtures/only-login --engine fake 2>&1); RUN_CODE=$?
FILES_AFTER_RUN=$(ls "$SPOOL" 2>/dev/null | tr '\n' ' ')
# 같은 포트로 재기동 (memory 저장소라 Cycle/Run 등록은 사라지지만 Ingest 는 runId 를 검사하지 않는다; sqlite 모드면 등록도 남는다)
KIND=$(node -p "JSON.parse(require('fs').readFileSync('$RUN_DIR/server.json.last','utf8')).store" 2>/dev/null || echo "${SINCLAIR_INGEST_STORE:-memory}")
node apps/control-plane/bin/sinclair-control-plane.mjs --port "$PORT" --store "$KIND" --db "$RUN_DIR/control-plane.db" >"$RUN_DIR/server.out" 2>&1 &
echo $! >"$RUN_DIR/server.pid"
for _ in $(seq 1 50); do grep -q '^READY' "$RUN_DIR/server.out" 2>/dev/null && break; sleep 0.1; done
node -e 'const [dir,port,pid,kind]=process.argv.slice(1);require("fs").writeFileSync(`${dir}/server.json`,JSON.stringify({port:Number(port),pid:Number(pid),store:kind}))' "$RUN_DIR" "$PORT" "$(cat "$RUN_DIR/server.pid")" "$KIND"
RESUME_OUT=$(node apps/runner-agent/bin/sinclair-agent.mjs resume --spool "$SPOOL" 2>&1); RESUME_CODE=$?
FILES_AFTER_RESUME=$(ls "$SPOOL" 2>/dev/null | tr '\n' ' ')
VIEW=$(curl -s "$URL/runs/$RUNID")
node -e 'const [rc,ro,fa,rsc,rso,fr,view,dest]=process.argv.slice(1);const v=JSON.parse(view);require("fs").writeFileSync(dest,JSON.stringify({run:{exitCode:Number(rc),output:ro.split("\n"),spoolFiles:fa.trim().split(" ").filter(Boolean)},resume:{exitCode:Number(rsc),output:rso.split("\n"),spoolFiles:fr.trim().split(" ").filter(Boolean)},runView:{state:v.state,attempts:(v.attempts||[]).map(a=>[a.testId,a.result])}},null,2))' "$RUN_CODE" "$RUN_OUT" "$FILES_AFTER_RUN" "$RESUME_CODE" "$RESUME_OUT" "$FILES_AFTER_RESUME" "$VIEW" "$RUN_DIR/evidence/spool-resume.json"
echo "RUN exit=$RUN_CODE spool=[$FILES_AFTER_RUN]"
echo "$RESUME_OUT" | tail -2
echo "RESUME exit=$RESUME_CODE spool=[$FILES_AFTER_RESUME] run.state=$(node -p "JSON.parse(process.argv[1]).state" "$VIEW")"
[ "$RUN_CODE" = "0" ] && [ -n "$FILES_AFTER_RUN" ] && [ "$RESUME_CODE" = "0" ] && [ -z "$FILES_AFTER_RESUME" ] && [ "$(node -p "JSON.parse(process.argv[1]).state" "$VIEW")" = "finished" ]
