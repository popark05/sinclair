#!/usr/bin/env bash
# 읽기 전용: 서버 pid 생존, /health 200, 동봉 Node 버전이 VERSION 파일과 같은지.
set -uo pipefail
RUN_DIR=${1:?RUN_DIR 필요}
. "$(dirname "$0")/lib.sh"; RUN_DIR=$(resolve_run_dir "$RUN_DIR")
[ -f "$RUN_DIR/server.json" ] || { echo "DOCTOR FAIL: server.json 없음(start.sh 먼저)"; exit 1; }
PID=$(node -p "JSON.parse(require('fs').readFileSync('$RUN_DIR/server.json','utf8')).pid"); PORT=$(server_port "$RUN_DIR")
DIR=$(install_dir "$RUN_DIR")
kill -0 "$PID" 2>/dev/null || { echo "DOCTOR FAIL: pid $PID 죽음"; exit 1; }
[ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/health")" = "200" ] || { echo "DOCTOR FAIL: /health 가 200 이 아님"; exit 1; }
WANT="v$(sed -n 's/^node //p' "$DIR/VERSION")"; GOT=$("$DIR/node/node" --version)
[ "$WANT" = "$GOT" ] || { echo "DOCTOR FAIL: 동봉 Node $GOT ≠ VERSION $WANT"; exit 1; }
echo "DOCTOR OK pid=$PID port=$PORT node=$GOT"
