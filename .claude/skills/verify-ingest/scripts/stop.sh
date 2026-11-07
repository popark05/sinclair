#!/usr/bin/env bash
# 우리가 띄운 서버만 종료한다. 증거(evidence/)는 지우지 않는다.
set -uo pipefail
RUN_DIR=${1:?RUN_DIR 필요}
[ -f "$RUN_DIR/server.pid" ] || { echo "server.pid 없음, 종료할 것 없음"; exit 0; }
PID=$(cat "$RUN_DIR/server.pid")
if kill -0 "$PID" 2>/dev/null; then kill "$PID"; for _ in $(seq 1 30); do kill -0 "$PID" 2>/dev/null || break; sleep 0.1; done; fi
kill -0 "$PID" 2>/dev/null && { echo "pid $PID 가 아직 살아있음, SIGKILL"; kill -9 "$PID"; }
rm -f "$RUN_DIR/server.pid" "$RUN_DIR/server.json"
echo "STOPPED pid=$PID (증거는 $RUN_DIR 에 남아 있음)"
