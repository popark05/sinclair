#!/usr/bin/env bash
# Fleet 종단 증명(control-plane 기동부터 정리까지). 사용: scripts/fleet-e2e.sh <RUN_DIR> [lease-ttl-ms=2000]
# 증거: <RUN_DIR>/evidence/fleet-e2e.json, 통과하면 리포에 남는 .scratch/device-fleet/evidence/06-e2e-latest.json
set -uo pipefail
RUN_DIR=${1:?RUN_DIR 필요}; TTL=${2:-2000}
HERE=$(cd "$(dirname "$0")" && pwd)
cd "$(git -C "$HERE" rev-parse --show-toplevel)" || exit 1
case "$RUN_DIR" in /*) ;; *) RUN_DIR="$PWD/$RUN_DIR" ;; esac
I="$HERE/../../verify-ingest/scripts"
mkdir -p "$RUN_DIR"
trap '"$I/stop.sh" "$RUN_DIR" >/dev/null 2>&1' EXIT
SINCLAIR_INGEST_LEASE_TTL_MS=$TTL "$I/start.sh" "$RUN_DIR" | tail -1 || exit 1
node "$HERE/fleet-e2e.mjs" "$RUN_DIR" "$TTL"; RC=$?
if [ $RC -eq 0 ]; then
  mkdir -p .scratch/device-fleet/evidence
  cp "$RUN_DIR/evidence/fleet-e2e.json" .scratch/device-fleet/evidence/06-e2e-latest.json
fi
exit $RC
