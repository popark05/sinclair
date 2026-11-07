#!/usr/bin/env bash
# POST /ingest 에 이벤트 배치(JSON 배열 파일 또는 문자열)를 보낸다. 사용: scripts/ingest.sh <RUN_DIR> <events.json|'[...]'> [evidence-name]
set -euo pipefail
RUN_DIR=${1:?RUN_DIR 필요}; BATCH=${2:?배치 필요}; NAME=${3:-}
PORT=$(node -p "JSON.parse(require('fs').readFileSync('$RUN_DIR/server.json','utf8')).port")
if [ -f "$BATCH" ]; then BODY=$(cat "$BATCH"); else BODY=$BATCH; fi
RES=$(curl -s -w '\n%{http_code}' -X POST "http://127.0.0.1:$PORT/ingest" -H 'content-type: application/json' --data "$BODY")
CODE=$(echo "$RES" | tail -1); OUT=$(echo "$RES" | sed '$d')
echo "$OUT"
if [ -n "$NAME" ]; then
  mkdir -p "$RUN_DIR/evidence"
  node -e 'const [body,code,out]=process.argv.slice(1);process.stdout.write(JSON.stringify({request:{method:"POST",path:"/ingest",body:JSON.parse(body)},status:Number(code),response:JSON.parse(out)},null,2))' "$BODY" "$CODE" "$OUT" >"$RUN_DIR/evidence/$NAME.json"
fi
[ "$CODE" = "200" ]
