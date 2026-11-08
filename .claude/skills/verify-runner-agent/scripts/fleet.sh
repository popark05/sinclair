#!/usr/bin/env bash
# Fleet 인벤토리 증명: 짧은 TTL 의 control-plane → fake 데몬 2개(실제 bin) → GET /fleet 에 노드 2개·가짜 기기 idle
# → 데몬 하나를 SIGKILL → TTL 뒤 그 노드의 기기가 offline. 사용: scripts/fleet.sh <RUN_DIR> [ttl-ms=2000]   증거: <RUN_DIR>/evidence/fleet.json
set -uo pipefail
RUN_DIR=${1:?RUN_DIR 필요}; TTL=${2:-2000}
HERE=$(cd "$(dirname "$0")" && pwd)
cd "$(git -C "$HERE" rev-parse --show-toplevel)" || exit 1
case "$RUN_DIR" in /*) ;; *) RUN_DIR="$PWD/$RUN_DIR" ;; esac
I="$HERE/../../verify-ingest/scripts"
A=""; B=""
trap '[ -n "$A" ] && kill -KILL $A 2>/dev/null; [ -n "$B" ] && kill -KILL $B 2>/dev/null; "$I/stop.sh" "$RUN_DIR" >/dev/null 2>&1' EXIT
SINCLAIR_INGEST_LEASE_TTL_MS=$TTL "$I/start.sh" "$RUN_DIR" | tail -1 || exit 1
PORT=$(node -p "JSON.parse(require('fs').readFileSync('$RUN_DIR/server.json','utf8')).port"); URL="http://127.0.0.1:$PORT"
mkdir -p "$RUN_DIR/evidence"
for n in a b; do
  node apps/runner-agent/bin/sinclair-agent.mjs daemon --control-plane "$URL" --targets "fleet-$n" --tests apps/runner-agent/test/fixtures/only-login --engine fake --agent "fleet-node-$n" --spool "$RUN_DIR/spool-$n" --poll 500 >"$RUN_DIR/fleet-$n.out" 2>&1 &
  if [ $n = a ]; then A=$!; else B=$!; fi
done
fleet() { curl -s "$URL/fleet"; }
nodes_online() { fleet | node -p 'const v=JSON.parse(require("fs").readFileSync(0,"utf8"));v.nodes.filter(n=>n.online).length' 2>/dev/null; }
for _ in $(seq 1 60); do [ "$(nodes_online)" = "2" ] && break; sleep 0.25; done
BEFORE=$(fleet)
kill -KILL $A; wait $A 2>/dev/null; A=""
sleep "$(node -p "($TTL+700)/1000")"   # 노드 TTL + 여유
AFTER=$(fleet)
kill -TERM $B; wait $B; CB=$?; B=""
node -e '
const [before,after,cb,dest]=process.argv.slice(1);const fs=require("fs");
const s=(v)=>JSON.parse(v).nodes.map(n=>({agentId:n.agentId,online:n.online,devices:n.devices.map(d=>({id:d.id,model:d.model,state:d.state,reason:d.reason}))}));
const b=s(before),a=s(after);
const ok=b.length===2&&b.every(n=>n.online&&n.devices[0]?.state==="idle")&&a.find(n=>n.agentId==="fleet-node-a")?.devices[0]?.state==="offline"&&a.find(n=>n.agentId==="fleet-node-b")?.devices[0]?.state==="idle"&&Number(cb)===0;
fs.writeFileSync(dest,JSON.stringify({at:new Date().toISOString(),nodeTtlMs:JSON.parse(after).nodeTtlMs,before:b,afterKillA:a,daemonBExit:Number(cb),result:ok?"FLEET OK":"FLEET FAIL"},null,2)+"\n");
console.log((ok?"FLEET OK":"FLEET FAIL")+" before="+b.map(n=>n.agentId+":"+n.devices.map(d=>d.state)).join(",")+" after="+a.map(n=>n.agentId+":"+n.devices.map(d=>d.state)).join(","));
process.exit(ok?0:1)' "$BEFORE" "$AFTER" "$CB" "$RUN_DIR/evidence/fleet.json"
