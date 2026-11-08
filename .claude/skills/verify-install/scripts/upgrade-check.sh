#!/usr/bin/env bash
# 업그레이드 흉내: 서버에 run 을 넣고 내린 뒤, zip 을 다른 디렉터리에 다시 풀어 같은 DB 로 띄워 run 이 남아 있는지. 사용: scripts/upgrade-check.sh <RUN_DIR>   증거: evidence/install-upgrade.json
set -uo pipefail
RUN_DIR=${1:?RUN_DIR 필요}
RUN_DIR=$(mkdir -p "$RUN_DIR" && cd "$RUN_DIR" && pwd)  # 런처는 /tmp 에서 실행하므로 절대 경로로
HERE=$(cd "$(dirname "$0")" && pwd)
ZIP=$(node -p "JSON.parse(require('fs').readFileSync('$RUN_DIR/install.json','utf8')).zip"); PORT=$(node -p "JSON.parse(require('fs').readFileSync('$RUN_DIR/server.json','utf8')).port")
curl -s -X POST "http://127.0.0.1:$PORT/ingest" -d '[{"schema":1,"eventId":"up-1","runId":"upgrade-run","at":"2026-11-08T00:00:00.000Z","type":"run.started","targetId":"android"},{"schema":1,"eventId":"up-2","runId":"upgrade-run","at":"2026-11-08T00:00:01.000Z","type":"run.finished","state":"finished"}]' >/dev/null
BEFORE=$(curl -s "http://127.0.0.1:$PORT/runs/upgrade-run")
"$HERE/stop.sh" "$RUN_DIR" >/dev/null
rm -rf "$RUN_DIR/install-next"; mkdir -p "$RUN_DIR/install-next"; unzip -q "$ZIP" -d "$RUN_DIR/install-next"
NEXT=$(ls -d "$RUN_DIR"/install-next/sinclair-*)
(cd /tmp && exec env SINCLAIR_CP_DB="$RUN_DIR/data/control-plane.db" "$NEXT/bin/sinclair-control-plane" --port 0) </dev/null >"$RUN_DIR/server-next.out" 2>&1 &
echo $! >"$RUN_DIR/server.pid"
for _ in $(seq 1 100); do grep -q '^READY' "$RUN_DIR/server-next.out" 2>/dev/null && break; sleep 0.1; done
PORT2=$(sed -n 's/^READY .*port=\([0-9]*\).*/\1/p' "$RUN_DIR/server-next.out" | head -1)
node -e 'const [dir,port,pid]=process.argv.slice(1);require("fs").writeFileSync(`${dir}/server.json`,JSON.stringify({port:Number(port),pid:Number(pid)}))' "$RUN_DIR" "$PORT2" "$(cat "$RUN_DIR/server.pid")"
AFTER=$(curl -s "http://127.0.0.1:$PORT2/runs/upgrade-run")
node -e 'const [b,a,dest]=process.argv.slice(1);require("fs").writeFileSync(dest,JSON.stringify({same:b===a,before:JSON.parse(b),after:JSON.parse(a)},null,2))' "$BEFORE" "$AFTER" "$RUN_DIR/evidence/install-upgrade.json"
if [ -n "$BEFORE" ] && echo "$BEFORE" | grep -q '"runId":"upgrade-run"' && [ "$BEFORE" = "$AFTER" ]; then echo "UPGRADE OK (새 설치 디렉터리가 같은 DB 의 run 을 돌려줌)"; else echo "UPGRADE FAIL before=[$BEFORE] after=[$AFTER]"; exit 1; fi
