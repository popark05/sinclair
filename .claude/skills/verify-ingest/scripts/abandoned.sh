#!/usr/bin/env bash
# 버려진 Run 정리·대체 Run 증명: Cycle(retryLimit 1) → Run 등록 → 클레임(lease) → run.started 만 Ingest → lease TTL + 유예(= TTL) 대기
#  → GET /cycles/:id 에서 infra-failed + replacedBy/대체 Run → 대체 Run 클레임·완료 → verified. 두 번 조회해 합성 이벤트·대체 Run 이 하나뿐임을 보인다.
# 서버는 SINCLAIR_INGEST_LEASE_TTL_MS=1000 처럼 짧은 TTL 로 띄워야 한다(start.sh). 사용: scripts/abandoned.sh <RUN_DIR> [evidence-name]
set -euo pipefail
RUN_DIR=${1:?RUN_DIR 필요}; NAME=${2:-abandoned}
PORT=$(node -p "JSON.parse(require('fs').readFileSync('$RUN_DIR/server.json','utf8')).port")
TTL=${SINCLAIR_INGEST_LEASE_TTL_MS:?SINCLAIR_INGEST_LEASE_TTL_MS 로 서버를 띄운 값을 함께 넘길 것}
HERE=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$RUN_DIR/evidence" "$RUN_DIR/tmp"
req() { # method path body-json evidence-name
  local out="$RUN_DIR/tmp/$4.json"
  local code; code=$(curl -s -o "$out" -w '%{http_code}' -X "$1" "http://127.0.0.1:$PORT$2" -H 'content-type: application/json' --data-binary "$3")
  [ -s "$out" ] || echo 'null' >"$out"
  node -e 'const fs=require("fs");const [m,p,b,c,o,d]=process.argv.slice(1);fs.writeFileSync(d,JSON.stringify({request:{method:m,path:p,body:JSON.parse(b)},status:Number(c),response:JSON.parse(fs.readFileSync(o,"utf8"))},null,2))' "$1" "$2" "$3" "$code" "$out" "$RUN_DIR/evidence/$4.json"
  cat "$out"
}
field() { node -p "JSON.parse(require('fs').readFileSync(0,'utf8'))$1"; }
CYCLE=$(req POST /cycles "{\"cycleId\":\"verify-abandoned-$(date +%s)-$$\",\"build\":\"1.2.3-verify\",\"targets\":[\"android\"],\"retryLimit\":1}" "$NAME-create" | field .cycleId)
RUN1=$(req POST "/cycles/$CYCLE/runs" '{"targetId":"android"}' "$NAME-run1" | field .runId)
CLAIMED=$(req POST /runs/claim '{"targetId":"android","agentId":"verify-agent-1"}' "$NAME-claim1" | field .run.runId)
[ "$CLAIMED" = "$RUN1" ] || { echo "ABANDONED FAIL: 첫 클레임이 $RUN1 이 아님($CLAIMED)" >&2; exit 1; }
NOW=$(node -p 'new Date().toISOString()')
"$HERE/ingest.sh" "$RUN_DIR" "[{\"schema\":1,\"eventId\":\"$RUN1-0\",\"runId\":\"$RUN1\",\"at\":\"$NOW\",\"type\":\"run.started\",\"cycleId\":\"$CYCLE\",\"targetId\":\"android\"},{\"schema\":1,\"eventId\":\"$RUN1-1\",\"runId\":\"$RUN1\",\"at\":\"$NOW\",\"type\":\"attempt.started\",\"attemptId\":\"$RUN1-a1\",\"testId\":\"로그인\",\"attemptNo\":1}]" "$NAME-ingest-partial" >/dev/null
"$HERE/get.sh" "$RUN_DIR" "/cycles/$CYCLE" "$NAME-view-before" | field '.runs.length' | grep -qx 1 || { echo "ABANDONED FAIL: 유예 전에 run 이 늘었음" >&2; exit 1; }
sleep "$(node -p "($TTL*2+300)/1000")"   # lease 만료 + 유예 + 여유
VIEW=$("$HERE/get.sh" "$RUN_DIR" "/cycles/$CYCLE" "$NAME-view-abandoned")
REP=$(echo "$VIEW" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=JSON.parse(s);const r1=v.runs[0],rep=v.runs[1];if(!(r1.state==="infra-failed"&&rep&&r1.replacedBy===rep.runId&&rep.replaces===r1.runId&&v.retriesUsed.android===1)){console.error("ABANDONED FAIL: "+JSON.stringify(v.runs));process.exit(1)}console.log(rep.runId)})')
"$HERE/get.sh" "$RUN_DIR" "/cycles/$CYCLE" "$NAME-view-abandoned-again" | field '.runs.length' | grep -qx 2 || { echo "ABANDONED FAIL: 두 번째 조회에서 대체 Run 이 또 생김" >&2; exit 1; }
"$HERE/get.sh" "$RUN_DIR" "/runs/$RUN1" "$NAME-run1-view" >/dev/null
CLAIMED2=$(req POST /runs/claim '{"targetId":"android","agentId":"verify-agent-2"}' "$NAME-claim2" | field .run.runId)
[ "$CLAIMED2" = "$REP" ] || { echo "ABANDONED FAIL: 대체 Run 이 클레임되지 않음($CLAIMED2 != $REP)" >&2; exit 1; }
NOW=$(node -p 'new Date().toISOString()')
"$HERE/ingest.sh" "$RUN_DIR" "[{\"schema\":1,\"eventId\":\"$REP-0\",\"runId\":\"$REP\",\"at\":\"$NOW\",\"type\":\"run.started\",\"cycleId\":\"$CYCLE\",\"targetId\":\"android\"},{\"schema\":1,\"eventId\":\"$REP-1\",\"runId\":\"$REP\",\"at\":\"$NOW\",\"type\":\"attempt.started\",\"attemptId\":\"$REP-a1\",\"testId\":\"로그인\",\"attemptNo\":1},{\"schema\":1,\"eventId\":\"$REP-2\",\"runId\":\"$REP\",\"at\":\"$NOW\",\"type\":\"attempt.finished\",\"attemptId\":\"$REP-a1\",\"result\":\"passed\",\"artifacts\":[]},{\"schema\":1,\"eventId\":\"$REP-3\",\"runId\":\"$REP\",\"at\":\"$NOW\",\"type\":\"run.finished\",\"state\":\"finished\"}]" "$NAME-ingest-replacement" >/dev/null
"$HERE/get.sh" "$RUN_DIR" "/cycles/$CYCLE" "$NAME-view-final" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=JSON.parse(s);if(v.state!=="finished"||v.verdict!=="verified"){console.error("ABANDONED FAIL: "+v.state+"/"+v.verdict);process.exit(1)}console.log("ABANDONED OK "+JSON.stringify({cycleId:v.cycleId,verdict:v.verdict,retriesUsed:v.retriesUsed,runs:v.runs.map(r=>({runId:r.runId,state:r.state,replaces:r.replaces,replacedBy:r.replacedBy}))}))})'
