#!/usr/bin/env bash
# control-plane 가 떠 있는 RUN_DIR(verify-ingest start.sh 가 만든 server.json)에 Cycle 을 만들고 `sinclair-agent run --engine fake` 를 실행한다.
# 사용: scripts/run-fake.sh <RUN_DIR> [cycleId] [tests-dir]   증거: evidence/agent-run.json (종료 코드, 출력, Cycle 뷰)
set -uo pipefail
RUN_DIR=${1:?RUN_DIR 필요}; CYCLE=${2:-agent-fake-$(date +%s)-$$}; TESTS=${3:-apps/runner-agent/test/fixtures/only-login}
PORT=$(node -p "JSON.parse(require('fs').readFileSync('$RUN_DIR/server.json','utf8')).port")
URL="http://127.0.0.1:$PORT"
mkdir -p "$RUN_DIR/evidence"
curl -s -X POST "$URL/cycles" -H 'content-type: application/json' --data "{\"cycleId\":\"$CYCLE\",\"build\":\"verify\",\"targets\":[\"android\"]}" >/dev/null
OUT=$(node apps/runner-agent/bin/sinclair-agent.mjs run --control-plane "$URL" --cycle "$CYCLE" --target android --tests "$TESTS" --engine fake 2>&1); CODE=$?
VIEW=$(curl -s "$URL/cycles/$CYCLE")
node -e 'const [code,out,view,dest,cycle]=process.argv.slice(1);const v=JSON.parse(view);require("fs").writeFileSync(dest,JSON.stringify({cycleId:cycle,exitCode:Number(code),output:out.split("\n"),cycle:{state:v.state,verdict:v.verdict,matrix:v.matrix,runs:v.runs}},null,2))' "$CODE" "$OUT" "$VIEW" "$RUN_DIR/evidence/agent-run.json" "$CYCLE"
echo "$OUT" | tail -2
echo "AGENT exit=$CODE cycle=$CYCLE state=$(node -p "JSON.parse(process.argv[1]).state" "$VIEW") verdict=$(node -p "JSON.parse(process.argv[1]).verdict" "$VIEW")"
exit $CODE
