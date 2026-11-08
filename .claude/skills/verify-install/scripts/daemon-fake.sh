#!/usr/bin/env bash
# 설치본 데몬이 run 을 워커 프로세스(__worker)로 돌리는지(device-fleet 04): FakeEngine Cycle → 설치본 `sinclair-agent daemon` → verified,
# 데몬 로그에 워커 모드 표시("[run …")가 있고 끝난 뒤 워커가 남지 않는다. 사용: scripts/daemon-fake.sh <RUN_DIR>   증거: evidence/install-daemon.json
set -uo pipefail
RUN_DIR=${1:?RUN_DIR 필요}
. "$(dirname "$0")/lib.sh"; RUN_DIR=$(resolve_run_dir "$RUN_DIR")
DIR=$(install_dir "$RUN_DIR"); PORT=$(server_port "$RUN_DIR")
URL="http://127.0.0.1:$PORT"; CYCLE="install-daemon-$(date +%s)"
mkdir -p "$RUN_DIR/tests-daemon" "$RUN_DIR/evidence"
printf "import { test } from '@sinclair/runner';\ntest('로그인', async ({ screen, expect }) => { await screen.getByRole('button', { name: '로그인' }).tap(); await expect(screen.getByText('환영합니다')).toBeVisible(); });\n" >"$RUN_DIR/tests-daemon/login.sinclair.ts"
curl -s -X POST "$URL/cycles" -d "{\"cycleId\":\"$CYCLE\",\"build\":\"verify\",\"targets\":[\"android\"],\"suite\":{\"tests\":\"$RUN_DIR/tests-daemon\"}}" >/dev/null
curl -s -X POST "$URL/cycles/$CYCLE/runs" -d '{"targetId":"android"}' >/dev/null
(cd /tmp && exec "$DIR/bin/sinclair-agent" daemon --control-plane "$URL" --targets android --tests "$RUN_DIR/tests-daemon" --engine fake --agent install-node --spool "$RUN_DIR/spool-daemon" --poll 300 </dev/null >"$RUN_DIR/daemon.out" 2>&1) & PID=$!
STATE=""
for _ in $(seq 1 120); do
  STATE=$(curl -s "$URL/cycles/$CYCLE" | node -p 'try{JSON.parse(require("fs").readFileSync(0,"utf8")).state}catch{""}' 2>/dev/null)
  [ "$STATE" = "finished" ] && break
  sleep 0.25
done
kill -TERM $PID 2>/dev/null; wait $PID; CODE=$?
sleep 1
LEFT=$(pgrep -f "__worker" | wc -l | tr -d ' ')
VIEW=$(curl -s "$URL/cycles/$CYCLE")
node -e "$mask_js"'const [code,out,view,left,dest,home]=process.argv.slice(1);const v=JSON.parse(view);const log=require("fs").readFileSync(out,"utf8").split("\n").filter(Boolean);require("fs").writeFileSync(dest,JSON.stringify({exitCode:Number(code),workerMode:log.some(l=>/^\[run …/.test(l)),workersLeft:Number(left),cycle:{state:v.state,verdict:v.verdict},log:log.map((l)=>mask(l,home))},null,2))' "$CODE" "$RUN_DIR/daemon.out" "$VIEW" "$LEFT" "$RUN_DIR/evidence/install-daemon.json" "$HOME"
WM=$(grep -c '^\[run …' "$RUN_DIR/daemon.out")
echo "DAEMON exit=$CODE $(node -p "const v=JSON.parse(process.argv[1]);v.state+'/'+v.verdict" "$VIEW") workerLines=$WM workersLeft=$LEFT"
[ "$CODE" = "0" ] && [ "$STATE" = "finished" ] && [ "$WM" -gt 0 ] && [ "$LEFT" = "0" ]
