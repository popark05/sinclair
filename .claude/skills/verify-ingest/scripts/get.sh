#!/usr/bin/env bash
# GET <path> (예: /runs, /runs/<id>). 사용: scripts/get.sh <RUN_DIR> <path> [evidence-name]
set -euo pipefail
RUN_DIR=${1:?RUN_DIR 필요}; P=${2:?경로 필요}; NAME=${3:-}
PORT=$(node -p "JSON.parse(require('fs').readFileSync('$RUN_DIR/server.json','utf8')).port")
RES=$(curl -s -w '\n%{http_code}' "http://127.0.0.1:$PORT$P")
CODE=$(echo "$RES" | tail -1); OUT=$(echo "$RES" | sed '$d')
echo "$OUT"
if [ -n "$NAME" ]; then
  mkdir -p "$RUN_DIR/evidence"
  node -e 'const [p,code,out]=process.argv.slice(1);process.stdout.write(JSON.stringify({request:{method:"GET",path:p},status:Number(code),response:JSON.parse(out)},null,2))' "$P" "$CODE" "$OUT" >"$RUN_DIR/evidence/$NAME.json"
fi
