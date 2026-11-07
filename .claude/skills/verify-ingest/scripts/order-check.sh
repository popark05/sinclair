#!/usr/bin/env bash
# 순서 무관 증명: 배치를 역순으로 둘로 나눠 보낸 run 의 투영이, 정순으로 보낸 run 의 투영과 같은지(runId 만 다름) 본다.
# 사용: scripts/order-check.sh <RUN_DIR> <events.json> [evidence-name]   (파일의 runId 는 'verify-run' 이어야 한다)
set -euo pipefail
RUN_DIR=${1:?RUN_DIR 필요}; FILE=${2:?events.json 필요}; NAME=${3:-order}
HERE=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$RUN_DIR/tmp"
# 정순 run (verify-run-ordered), 역순·분할 run (verify-run-shuffled)
node -e '
const fs=require("fs");const [src,dir]=process.argv.slice(1);const ev=JSON.parse(fs.readFileSync(src,"utf8"));
const re=(id,suffix)=>ev.map(e=>({...e,eventId:`${e.eventId}-${suffix}`,runId:id}));
fs.writeFileSync(`${dir}/ordered.json`,JSON.stringify(re("verify-run-ordered","o")));
const sh=re("verify-run-shuffled","s").reverse();const mid=Math.ceil(sh.length/2);
fs.writeFileSync(`${dir}/shuffled-1.json`,JSON.stringify(sh.slice(0,mid)));fs.writeFileSync(`${dir}/shuffled-2.json`,JSON.stringify(sh.slice(mid)));' "$FILE" "$RUN_DIR/tmp"
"$HERE/ingest.sh" "$RUN_DIR" "$RUN_DIR/tmp/ordered.json" "$NAME-ordered" >/dev/null
"$HERE/ingest.sh" "$RUN_DIR" "$RUN_DIR/tmp/shuffled-1.json" "$NAME-shuffled-1" >/dev/null
"$HERE/ingest.sh" "$RUN_DIR" "$RUN_DIR/tmp/shuffled-2.json" "$NAME-shuffled-2" >/dev/null
A=$("$HERE/get.sh" "$RUN_DIR" /runs/verify-run-ordered "$NAME-view-ordered" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=JSON.parse(s);delete v.runId;process.stdout.write(JSON.stringify(v))})')
B=$("$HERE/get.sh" "$RUN_DIR" /runs/verify-run-shuffled "$NAME-view-shuffled" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=JSON.parse(s);delete v.runId;process.stdout.write(JSON.stringify(v))})')
if [ "$A" = "$B" ]; then echo "ORDER-INDEPENDENT"; else echo "ORDER-DEPENDENT"; echo "ordered:  $A"; echo "shuffled: $B"; exit 1; fi
