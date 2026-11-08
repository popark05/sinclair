#!/usr/bin/env bash
# 재시도 정책 종단 증명(control-plane 기동부터 정리까지). 사용: scripts/retry-e2e.sh <RUN_DIR> [lease-ttl-ms=2000]
# 증거: <RUN_DIR>/evidence/retry-e2e.json, 그리고 리포에 남는 .scratch/retry-policy/evidence/04-e2e-latest.json
set -uo pipefail
RUN_DIR=${1:?RUN_DIR 필요}; TTL=${2:-2000}
HERE=$(cd "$(dirname "$0")" && pwd)
I="$HERE/../../verify-ingest/scripts"
SINCLAIR_INGEST_LEASE_TTL_MS=$TTL "$I/start.sh" "$RUN_DIR" | tail -1 || exit 1
node "$HERE/retry-e2e.mjs" "$RUN_DIR" "$TTL"; RC=$?
"$I/stop.sh" "$RUN_DIR" >/dev/null
mkdir -p .scratch/retry-policy/evidence
cp "$RUN_DIR/evidence/retry-e2e.json" .scratch/retry-policy/evidence/04-e2e-latest.json
exit $RC
