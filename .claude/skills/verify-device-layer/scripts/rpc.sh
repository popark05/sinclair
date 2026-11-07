#!/usr/bin/env bash
# JSON-RPC 호출. 사용: scripts/rpc.sh <RUN_DIR> <method> [params-json] [evidence-name]
# 응답은 stdout 으로, evidence-name 을 주면 <RUN_DIR>/evidence/<name>.json 에도 요청+응답을 저장한다.
set -euo pipefail
RUN_DIR=${1:?RUN_DIR 필요}; METHOD=${2:?method 필요}; PARAMS=${3:-{\}}; NAME=${4:-}
PORT=$(node -p "JSON.parse(require('fs').readFileSync('$RUN_DIR/server.json','utf8')).port")
TOKEN=$(node -p "JSON.parse(require('fs').readFileSync('$RUN_DIR/server.json','utf8')).token")
ID=$(( $(date +%s%N) / 1000000 ))
BODY="{\"jsonrpc\":\"2.0\",\"id\":$ID,\"method\":\"$METHOD\",\"params\":$PARAMS}"
RESP=$(curl -sS -X POST "http://127.0.0.1:$PORT/rpc" -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' --data "$BODY")
if [ -n "$NAME" ]; then
  mkdir -p "$RUN_DIR/evidence"
  printf '{"request":%s,"response":%s}\n' "$BODY" "$RESP" >"$RUN_DIR/evidence/$NAME.json"
fi
echo "$RESP"
