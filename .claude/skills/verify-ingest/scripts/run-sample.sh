#!/usr/bin/env bash
# 러너 샘플을 HTTP Reporter 로 흘려보내고 runId 를 마지막 줄에 출력한다. 사용: scripts/run-sample.sh <RUN_DIR> [batchSize]
set -euo pipefail
RUN_DIR=${1:?RUN_DIR 필요}; BATCH=${2:-3}
HERE=$(cd "$(dirname "$0")" && pwd)
node --experimental-transform-types "$HERE/run-sample.ts" "$RUN_DIR" "$BATCH" 2>/dev/null
