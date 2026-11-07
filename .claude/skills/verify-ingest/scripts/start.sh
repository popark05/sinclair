#!/usr/bin/env bash
# control-plane 를 제품 엔트리(apps/control-plane/bin)로 백그라운드 기동하고 READY 를 기다린다. 사용: scripts/start.sh <RUN_DIR>
# 저장소: SINCLAIR_INGEST_STORE=memory(기본) | sqlite (파일은 <RUN_DIR>/control-plane.db, SINCLAIR_INGEST_DB 로 바꿀 수 있다)
# 포트: 기본 0(OS 배정). 같은 포트로 재기동하려면 SINCLAIR_INGEST_PORT=<n>
set -euo pipefail
RUN_DIR=${1:?RUN_DIR 필요}
HERE=$(cd "$(dirname "$0")" && pwd)
BIN="$HERE/../../../../apps/control-plane/bin/sinclair-control-plane.mjs"
mkdir -p "$RUN_DIR/evidence"
KIND=${SINCLAIR_INGEST_STORE:-memory}
DB=${SINCLAIR_INGEST_DB:-$RUN_DIR/control-plane.db}
node "$BIN" --port "${SINCLAIR_INGEST_PORT:-0}" --store "$KIND" --db "$DB" >"$RUN_DIR/server.out" 2>&1 &
echo $! >"$RUN_DIR/server.pid"
for _ in $(seq 1 50); do  # 0.1s × 50 = 5초: 셸 재실행 + TS 변환 로드에 보통 1초 미만
  if grep -q '^READY' "$RUN_DIR/server.out" 2>/dev/null; then
    PORT=$(sed -n 's/^READY .*port=\([0-9]*\).*/\1/p' "$RUN_DIR/server.out" | head -1)
    node -e 'const [dir,port,pid,kind,db]=process.argv.slice(1);require("fs").writeFileSync(`${dir}/server.json`,JSON.stringify({port:Number(port),pid:Number(pid),store:kind,...(kind==="sqlite"?{db}:{})}))' "$RUN_DIR" "$PORT" "$(cat "$RUN_DIR/server.pid")" "$KIND" "$DB"
    cat "$RUN_DIR/server.out"; exit 0
  fi
  if ! kill -0 "$(cat "$RUN_DIR/server.pid")" 2>/dev/null; then echo "서버가 READY 전에 종료됨" >&2; cat "$RUN_DIR/server.out" >&2; exit 1; fi
  sleep 0.1
done
echo "서버가 5초 안에 READY 를 출력하지 않음" >&2; cat "$RUN_DIR/server.out" >&2; exit 1
