#!/usr/bin/env bash
# 우리가 띄운 서버만 종료한다(SIGTERM → 3초 후 SIGKILL). 증거는 남긴다.
set -uo pipefail
RUN_DIR=${1:?RUN_DIR 필요}
. "$(dirname "$0")/lib.sh"; RUN_DIR=$(resolve_run_dir "$RUN_DIR")
[ -f "$RUN_DIR/server.pid" ] || { echo "server.pid 없음"; exit 0; }
PID=$(cat "$RUN_DIR/server.pid")
if kill -0 "$PID" 2>/dev/null; then kill "$PID"; for _ in $(seq 1 30); do kill -0 "$PID" 2>/dev/null || break; sleep 0.1; done; fi
kill -0 "$PID" 2>/dev/null && kill -9 "$PID"
rm -f "$RUN_DIR/server.pid" "$RUN_DIR/server.json"
echo "STOPPED pid=$PID"
