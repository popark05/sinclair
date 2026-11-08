#!/usr/bin/env bash
# 읽기 전용: 서버 pid 생존, /health 200, 동봉 Node 버전이 VERSION 파일과 같은지.
set -uo pipefail
RUN_DIR=${1:?RUN_DIR 필요}
RUN_DIR=$(mkdir -p "$RUN_DIR" && cd "$RUN_DIR" && pwd)  # 런처는 /tmp 에서 실행하므로 절대 경로로
[ -f "$RUN_DIR/server.json" ] || { echo "DOCTOR FAIL: server.json 없음(start.sh 먼저)"; exit 1; }
PID=$(node -p "JSON.parse(require('fs').readFileSync('$RUN_DIR/server.json','utf8')).pid"); PORT=$(node -p "JSON.parse(require('fs').readFileSync('$RUN_DIR/server.json','utf8')).port")
DIR=$(node -p "JSON.parse(require('fs').readFileSync('$RUN_DIR/install.json','utf8')).dir")
kill -0 "$PID" 2>/dev/null || { echo "DOCTOR FAIL: pid $PID 죽음"; exit 1; }
[ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/health")" = "200" ] || { echo "DOCTOR FAIL: /health 가 200 이 아님"; exit 1; }
WANT="v$(sed -n 's/^node //p' "$DIR/VERSION")"; GOT=$("$DIR/node/node" --version)
[ "$WANT" = "$GOT" ] || { echo "DOCTOR FAIL: 동봉 Node $GOT ≠ VERSION $WANT"; exit 1; }
echo "DOCTOR OK pid=$PID port=$PORT node=$GOT"
