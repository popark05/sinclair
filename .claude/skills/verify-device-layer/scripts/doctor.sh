#!/usr/bin/env bash
# 읽기 전용 점검: 이 RUN_DIR 의 서버가 살아 있고, 우리가 띄운 것이며, 토큰이 유효한가.
set -uo pipefail
RUN_DIR=${1:?RUN_DIR 필요}
[ -f "$RUN_DIR/server.json" ] || { echo "DOCTOR FAIL: $RUN_DIR/server.json 없음 (start.sh 를 먼저)"; exit 1; }
PID=$(node -p "JSON.parse(require('fs').readFileSync('$RUN_DIR/server.json','utf8')).pid")
kill -0 "$PID" 2>/dev/null || { echo "DOCTOR FAIL: pid $PID 가 살아있지 않음"; exit 1; }
PORT=$(node -p "JSON.parse(require('fs').readFileSync('$RUN_DIR/server.json','utf8')).port")
OWNER=$(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null | head -1)
[ "$OWNER" = "$PID" ] || { echo "DOCTOR FAIL: 포트 $PORT 소유 pid=$OWNER, 기대 pid=$PID"; exit 1; }
NOAUTH=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$PORT/rpc" --data '{}')
[ "$NOAUTH" = "401" ] || { echo "DOCTOR FAIL: 토큰 없는 요청이 401 이 아님 ($NOAUTH)"; exit 1; }
HERE=$(cd "$(dirname "$0")" && pwd)
INFO=$("$HERE/rpc.sh" "$RUN_DIR" server.info) || { echo "DOCTOR FAIL: server.info 실패"; exit 1; }
echo "$INFO" | grep -q '"version":"0.0.0"' || { echo "DOCTOR FAIL: 예상 버전 아님: $INFO"; exit 1; }
echo "DOCTOR OK pid=$PID port=$PORT $INFO"
