#!/usr/bin/env bash
# 읽기 전용 점검: 이 RUN_DIR 의 서버가 살아 있고 우리가 띄운 것이며 /health 가 200 인가.
set -uo pipefail
RUN_DIR=${1:?RUN_DIR 필요}
[ -f "$RUN_DIR/server.json" ] || { echo "DOCTOR FAIL: $RUN_DIR/server.json 없음 (start.sh 를 먼저)"; exit 1; }
PID=$(node -p "JSON.parse(require('fs').readFileSync('$RUN_DIR/server.json','utf8')).pid")
kill -0 "$PID" 2>/dev/null || { echo "DOCTOR FAIL: pid $PID 가 살아있지 않음"; exit 1; }
PORT=$(node -p "JSON.parse(require('fs').readFileSync('$RUN_DIR/server.json','utf8')).port")
OWNER=$(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null | head -1)
# bin 셸(server.pid)이 --experimental-transform-types 로 자식을 띄우므로 포트 소유자는 pid 자신이거나 그 자식이다
OWNER_PARENT=$(ps -o ppid= -p "$OWNER" 2>/dev/null | tr -d ' ')
[ "$OWNER" = "$PID" ] || [ "$OWNER_PARENT" = "$PID" ] || { echo "DOCTOR FAIL: 포트 $PORT 소유 pid=$OWNER(부모 $OWNER_PARENT), 기대 pid=$PID"; exit 1; }
CODE=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/health")
[ "$CODE" = "200" ] || { echo "DOCTOR FAIL: /health 가 200 이 아님 ($CODE)"; exit 1; }
BAD=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$PORT/ingest" --data '{}')
[ "$BAD" = "400" ] || { echo "DOCTOR FAIL: 배열 아닌 본문이 400 이 아님 ($BAD)"; exit 1; }
echo "DOCTOR OK pid=$PID port=$PORT"
