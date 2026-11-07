#!/usr/bin/env bash
# control-plane 를 백그라운드로 띄우고 READY 를 기다린다. 사용: scripts/start.sh <RUN_DIR>
set -euo pipefail
RUN_DIR=${1:?RUN_DIR 필요}
HERE=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$RUN_DIR"
node --experimental-transform-types "$HERE/serve.ts" "$RUN_DIR" >"$RUN_DIR/server.out" 2>&1 &
echo $! >"$RUN_DIR/server.pid"
for _ in $(seq 1 50); do
  if grep -q '^READY' "$RUN_DIR/server.out" 2>/dev/null; then cat "$RUN_DIR/server.out"; exit 0; fi
  sleep 0.1
done
echo "서버가 5초 안에 READY 를 출력하지 않음" >&2; cat "$RUN_DIR/server.out" >&2; exit 1
