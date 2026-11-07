#!/usr/bin/env bash
# POST /ingest 에 이벤트 배치(JSON 배열 파일 또는 문자열)를 보낸다. 사용: scripts/ingest.sh <RUN_DIR> <events.json|'[...]'> [evidence-name]
# 본문은 파일로 넘긴다(argv 길이 제한 회피). 문자열이면 RUN_DIR/tmp 에 먼저 쓴다.
set -euo pipefail
RUN_DIR=${1:?RUN_DIR 필요}; BATCH=${2:?배치 필요}; NAME=${3:-}
PORT=$(node -p "JSON.parse(require('fs').readFileSync('$RUN_DIR/server.json','utf8')).port")
mkdir -p "$RUN_DIR/tmp" "$RUN_DIR/evidence"
if [ -f "$BATCH" ]; then FILE=$BATCH; else FILE=$RUN_DIR/tmp/batch-$$.json; printf '%s' "$BATCH" >"$FILE"; fi
OUTF=$RUN_DIR/tmp/out-$$.json
CODE=$(curl -s -o "$OUTF" -w '%{http_code}' -X POST "http://127.0.0.1:$PORT/ingest" -H 'content-type: application/json' --data-binary "@$FILE")
cat "$OUTF"; echo
if [ -n "$NAME" ]; then
  node -e 'const fs=require("fs");const [file,code,outf,dest]=process.argv.slice(1);fs.writeFileSync(dest,JSON.stringify({request:{method:"POST",path:"/ingest",body:JSON.parse(fs.readFileSync(file,"utf8"))},status:Number(code),response:JSON.parse(fs.readFileSync(outf,"utf8"))},null,2))' "$FILE" "$CODE" "$OUTF" "$RUN_DIR/evidence/$NAME.json"
fi
[ "$CODE" = "200" ]
