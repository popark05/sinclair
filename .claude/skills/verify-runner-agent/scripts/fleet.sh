#!/usr/bin/env bash
# Fleet 증명: 짧은 TTL 의 control-plane → fake 데몬 2개(실제 bin) → GET /fleet 에 노드 2개·가짜 기기 idle
# → 노드 b 의 타깃에 느린 Run 하나 → 도는 동안 그 기기 leased(runId) → 끝나면 idle(기기 lease, device-fleet 02)
# → 데몬 a 를 SIGKILL → TTL 뒤 그 노드의 기기가 offline. 사용: scripts/fleet.sh <RUN_DIR> [ttl-ms=2000]   증거: <RUN_DIR>/evidence/fleet.json
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
  SINCLAIR_E2E_SLOW_MS=3000 SINCLAIR_E2E_SLOW_COUNT=1 node apps/runner-agent/bin/sinclair-agent.mjs daemon --control-plane "$URL" --targets "fleet-$n" --tests apps/runner-agent/test/fixtures/only-login --engine fake --agent "fleet-node-$n" --spool "$RUN_DIR/spool-$n" --poll 500 >"$RUN_DIR/fleet-$n.out" 2>&1 &
  if [ $n = a ]; then A=$!; else B=$!; fi
done
fleet() { curl -s "$URL/fleet"; }
nodes_online() { fleet | node -p 'const v=JSON.parse(require("fs").readFileSync(0,"utf8"));v.nodes.filter(n=>n.online).length' 2>/dev/null; }
for _ in $(seq 1 60); do [ "$(nodes_online)" = "2" ] && break; sleep 0.25; done
BEFORE=$(fleet)
# 기기 lease: 느린 Run 하나를 노드 b 에 준다(타깃 fleet-b). 도는 동안 leased, 끝나면 idle
CYCLE="fleet-lease-$(date +%s)-$$"
curl -s -X POST "$URL/cycles" -H 'content-type: application/json' --data "{\"cycleId\":\"$CYCLE\",\"build\":\"verify\",\"targets\":[\"fleet-b\"],\"suite\":{\"tests\":\"apps/runner-agent/test/fixtures/retry-e2e\",\"retries\":1}}" >/dev/null
curl -s -X POST "$URL/cycles/$CYCLE/runs" -H 'content-type: application/json' --data '{"targetId":"fleet-b","runId":"fleet-lease-run"}' >/dev/null
b_state() { fleet | node -p 'const v=JSON.parse(require("fs").readFileSync(0,"utf8"));const d=v.nodes.find(n=>n.agentId==="fleet-node-b")?.devices[0];d?d.state+":"+(d.runId||""):""' 2>/dev/null; }
LEASED=""; for _ in $(seq 1 60); do s=$(b_state); [ "${s%%:*}" = "leased" ] && LEASED=$s && break; sleep 0.2; done
DURING=$(fleet)
for _ in $(seq 1 100); do [ "$(curl -s "$URL/cycles/$CYCLE" | node -p 'JSON.parse(require("fs").readFileSync(0,"utf8")).state' 2>/dev/null)" = "finished" ] && break; sleep 0.2; done
AFTER_RUN=$(fleet); CYCLE_VIEW=$(curl -s "$URL/cycles/$CYCLE")
# 조건 타깃(device-fleet 03): 선언 없이도 조건에 맞는 기기(FakeEngine 모델)가 받고, 맞는 기기가 없는 조건(OS 99 이상)은 대기
SEL="fleet-selector-$(date +%s)-$$"
curl -s -X POST "$URL/cycles" -H 'content-type: application/json' --data "{\"cycleId\":\"$SEL\",\"build\":\"verify\",\"targets\":[{\"id\":\"fake-model\",\"platform\":\"android\",\"model\":\"FakeEngine\"},{\"id\":\"os99\",\"platform\":\"android\",\"osVersion\":{\"min\":\"99\"}}],\"suite\":{\"tests\":\"apps/runner-agent/test/fixtures/only-login\"}}" >/dev/null
curl -s -X POST "$URL/cycles/$SEL/runs" -H 'content-type: application/json' --data '{"targetId":"os99","runId":"sel-os99"}' >/dev/null
curl -s -X POST "$URL/cycles/$SEL/runs" -H 'content-type: application/json' --data '{"targetId":"fake-model","runId":"sel-model"}' >/dev/null
sel_state() { curl -s "$URL/cycles/$SEL" | node -p 'const v=JSON.parse(require("fs").readFileSync(0,"utf8"));v.runs.find(r=>r.runId==="sel-model")?.state' 2>/dev/null; }
for _ in $(seq 1 100); do [ "$(sel_state)" = "finished" ] && break; sleep 0.2; done
sleep 1   # 맞지 않는 Run 이 잘못 클레임될 기회를 준다
SEL_VIEW=$(curl -s "$URL/cycles/$SEL")
kill -KILL $A; wait $A 2>/dev/null; A=""
sleep "$(node -p "($TTL+700)/1000")"   # 노드 TTL + 여유
AFTER=$(fleet)
kill -TERM $B; wait $B; CB=$?; B=""
node -e '
const [before,during,afterRun,cview,selview,after,cb,dest]=process.argv.slice(1);const fs=require("fs");
const s=(v)=>JSON.parse(v).nodes.map(n=>({agentId:n.agentId,online:n.online,devices:n.devices.map(d=>({id:d.id,model:d.model,state:d.state,reason:d.reason,runId:d.runId}))}));
const b=s(before),du=s(during),ar=s(afterRun),a=s(after),cv=JSON.parse(cview),sv=JSON.parse(selview);
const selModel=sv.runs.find(r=>r.runId==="sel-model"),sel99=sv.runs.find(r=>r.runId==="sel-os99");
const selOk=selModel?.state==="finished"&&/^fake-fleet-node-[ab]$/.test(selModel?.lease?.deviceId||"")&&sel99?.state==="queued"&&!sel99?.lease;
const devB=(x)=>x.find(n=>n.agentId==="fleet-node-b")?.devices[0];
const ok=b.length===2&&b.every(n=>n.online&&n.devices[0]?.state==="idle")
  &&devB(du)?.state==="leased"&&devB(du)?.runId==="fleet-lease-run"&&du.find(n=>n.agentId==="fleet-node-a")?.devices[0]?.state==="idle"
  &&devB(ar)?.state==="idle"&&cv.state==="finished"&&cv.runs[0]?.lease?.deviceId===devB(b)?.id&&!cv.warnings
  &&selOk&&a.find(n=>n.agentId==="fleet-node-a")?.devices[0]?.state==="offline"&&devB(a)?.state==="idle"&&Number(cb)===0;
fs.writeFileSync(dest,JSON.stringify({at:new Date().toISOString(),nodeTtlMs:JSON.parse(after).nodeTtlMs,before:b,duringRun:du,afterRun:ar,cycle:{state:cv.state,verdict:cv.verdict,runs:cv.runs.map(r=>({runId:r.runId,state:r.state,agent:r.lease?.agentId,deviceId:r.lease?.deviceId})),warnings:cv.warnings},selector:{targets:sv.targets,targetSelectors:sv.targetSelectors,runs:sv.runs.map(r=>({runId:r.runId,targetId:r.targetId,state:r.state,deviceId:r.lease?.deviceId}))},afterKillA:a,daemonBExit:Number(cb),result:ok?"FLEET OK":"FLEET FAIL"},null,2)+"\n");
const fmt=(x)=>x.map(n=>n.agentId+":"+n.devices.map(d=>d.state)).join(",");
console.log((ok?"FLEET OK":"FLEET FAIL")+" before="+fmt(b)+" during="+fmt(du)+" afterRun="+fmt(ar)+" selector="+(selModel?.state+"@"+(selModel?.lease?.deviceId||"-")+",os99:"+sel99?.state)+" afterKillA="+fmt(a));
process.exit(ok?0:1)' "$BEFORE" "$DURING" "$AFTER_RUN" "$CYCLE_VIEW" "$SEL_VIEW" "$AFTER" "$CB" "$RUN_DIR/evidence/fleet.json"
