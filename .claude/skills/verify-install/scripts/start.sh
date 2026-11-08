#!/usr/bin/env bash
# 설치본 런처로 control-plane 을 띄운다(DB 는 $RUN_DIR/data/control-plane.db). 사용: scripts/start.sh <RUN_DIR>
set -euo pipefail
RUN_DIR=${1:?RUN_DIR 필요}
RUN_DIR=$(mkdir -p "$RUN_DIR" && cd "$RUN_DIR" && pwd)  # 런처는 /tmp 에서 실행하므로 절대 경로로
DIR=$(node -p "JSON.parse(require('fs').readFileSync('$RUN_DIR/install.json','utf8')).dir")
mkdir -p "$RUN_DIR/data" "$RUN_DIR/evidence"
# 호출자의 파이프를 물려받지 않도록 stdin/stdout/stderr 를 모두 떼어 낸다(그래야 `start.sh | tail` 같은 호출이 안 매달린다)
# exec 로 서브셸이 곧 런처(런처는 다시 node 를 exec)가 되어 $! 가 서버 pid 다(그렇지 않으면 stop.sh 가 껍데기만 죽이고 서버가 고아로 남는다)
(cd /tmp && exec env SINCLAIR_CP_DB="$RUN_DIR/data/control-plane.db" "$DIR/bin/sinclair-control-plane" --port 0) </dev/null >"$RUN_DIR/server.out" 2>&1 &
echo $! >"$RUN_DIR/server.pid"
for _ in $(seq 1 100); do  # 0.1s × 100 = 10초: 동봉 Node 로 번들 로드 + sqlite 열기
  if grep -q '^READY' "$RUN_DIR/server.out" 2>/dev/null; then
    PORT=$(sed -n 's/^READY .*port=\([0-9]*\).*/\1/p' "$RUN_DIR/server.out" | head -1)
    node -e 'const [dir,port,pid]=process.argv.slice(1);require("fs").writeFileSync(`${dir}/server.json`,JSON.stringify({port:Number(port),pid:Number(pid)}))' "$RUN_DIR" "$PORT" "$(cat "$RUN_DIR/server.pid")"
    cat "$RUN_DIR/server.out"; exit 0
  fi
  kill -0 "$(cat "$RUN_DIR/server.pid")" 2>/dev/null || { echo "서버가 READY 전에 종료됨" >&2; cat "$RUN_DIR/server.out" >&2; exit 1; }
  sleep 0.1
done
echo "서버가 10초 안에 READY 를 출력하지 않음" >&2; cat "$RUN_DIR/server.out" >&2; exit 1
