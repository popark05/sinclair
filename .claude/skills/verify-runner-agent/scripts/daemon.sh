#!/usr/bin/env bash
# 데몬 증명: Cycle(타깃 2개, suite 지정) + Run 2개를 등록하고 데몬 2개(각 타깃)를 실제 bin 으로 띄운 뒤, Cycle 이 finished 가 될 때까지 조회한다.
# 끝나면 SIGTERM 으로 데몬을 멈춘다. 증거: evidence/daemon.json   사용: scripts/daemon.sh <RUN_DIR>
set -uo pipefail
RUN_DIR=${1:?RUN_DIR 필요}
PORT=$(node -p "JSON.parse(require('fs').readFileSync('$RUN_DIR/server.json','utf8')).port")
URL="http://127.0.0.1:$PORT"; CYCLE="daemon-$(date +%s)-$$"; SPOOL="$RUN_DIR/spool"
mkdir -p "$RUN_DIR/evidence"
curl -s -X POST "$URL/cycles" -H 'content-type: application/json' --data "{\"cycleId\":\"$CYCLE\",\"build\":\"verify\",\"targets\":[\"android\",\"ios\"],\"suite\":{\"tests\":\"apps/runner-agent/test/fixtures/only-login\"}}" >/dev/null
for t in android ios; do curl -s -X POST "$URL/cycles/$CYCLE/runs" -H 'content-type: application/json' --data "{\"targetId\":\"$t\"}" >/dev/null; done
node apps/runner-agent/bin/sinclair-agent.mjs daemon --control-plane "$URL" --targets android --tests apps/runner-agent/test/fixtures --engine fake --agent node-a --spool "$SPOOL" --poll 500 >"$RUN_DIR/daemon-a.out" 2>&1 & A=$!
node apps/runner-agent/bin/sinclair-agent.mjs daemon --control-plane "$URL" --targets ios --tests apps/runner-agent/test/fixtures --engine fake --agent node-b --spool "$SPOOL" --poll 500 >"$RUN_DIR/daemon-b.out" 2>&1 & B=$!
STATE=""
for _ in $(seq 1 120); do  # 0.25s × 120 = 30초: 셸 재실행 bin 2개 기동 + 폴링 0.5초 + run 2개
  STATE=$(curl -s "$URL/cycles/$CYCLE" | node -p 'try{JSON.parse(require("fs").readFileSync(0,"utf8")).state}catch{""}' 2>/dev/null)
  [ "$STATE" = "finished" ] && break
  sleep 0.25
done
kill -TERM $A $B 2>/dev/null; wait $A; CA=$?; wait $B; CB=$?
VIEW=$(curl -s "$URL/cycles/$CYCLE")
# 로그의 리포·홈 경로는 지운다(증거가 리포에 복사될 수 있다)
node -e 'const [view,ca,cb,oa,ob,dest]=process.argv.slice(1);const v=JSON.parse(view);const fs=require("fs");const m=(l)=>l.split(process.cwd()).join("<repo>").split(require("os").homedir()).join("<home>");const rd=(f)=>fs.readFileSync(f,"utf8").split("\n").filter(Boolean).map(m);fs.writeFileSync(dest,JSON.stringify({cycleId:v.cycleId,state:v.state,verdict:v.verdict,runs:v.runs,matrix:v.matrix,daemons:{a:{exit:Number(ca),log:rd(oa)},b:{exit:Number(cb),log:rd(ob)}}},null,2))' "$VIEW" "$CA" "$CB" "$RUN_DIR/daemon-a.out" "$RUN_DIR/daemon-b.out" "$RUN_DIR/evidence/daemon.json"
echo "DAEMON cycle=$CYCLE state=$STATE verdict=$(node -p "JSON.parse(process.argv[1]).verdict" "$VIEW") leases=$(node -p "JSON.parse(process.argv[1]).runs.map(r=>r.lease&&r.lease.agentId).join(',')" "$VIEW") exits=$CA,$CB"
[ "$STATE" = "finished" ] && [ "$CA" = "0" ] && [ "$CB" = "0" ]
