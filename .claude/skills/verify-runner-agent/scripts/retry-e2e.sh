#!/usr/bin/env bash
# 재시도 정책 종단 증명(control-plane 기동부터 정리까지). 사용: scripts/retry-e2e.sh <RUN_DIR> [lease-ttl-ms=2000]
# 증거: <RUN_DIR>/evidence/retry-e2e.json, 그리고 리포에 남는 .scratch/retry-policy/evidence/04-e2e-latest.json
set -uo pipefail
RUN_DIR=${1:?RUN_DIR 필요}; TTL=${2:-2000}
HERE=$(cd "$(dirname "$0")" && pwd)
cd "$(git -C "$HERE" rev-parse --show-toplevel)" || exit 1   # 상대 경로(.scratch, 픽스처)가 리포 루트 기준이다
case "$RUN_DIR" in /*) ;; *) RUN_DIR="$PWD/$RUN_DIR" ;; esac
I="$HERE/../../verify-ingest/scripts"
trap '"$I/stop.sh" "$RUN_DIR" >/dev/null 2>&1' EXIT   # 중간에 끊겨도 control-plane 을 남기지 않는다
SINCLAIR_INGEST_LEASE_TTL_MS=$TTL "$I/start.sh" "$RUN_DIR" | tail -1 || exit 1
node "$HERE/retry-e2e.mjs" "$RUN_DIR" "$TTL"; RC=$?
# 리포에 남는 증거는 통과했을 때만 갱신한다(실패 증거는 $RUN_DIR 에 남는다)
if [ $RC -eq 0 ]; then
  mkdir -p .scratch/retry-policy/evidence
  cp "$RUN_DIR/evidence/retry-e2e.json" .scratch/retry-policy/evidence/04-e2e-latest.json
fi
exit $RC
