#!/usr/bin/env bash
# Cycle 흐름 증명: Cycle 생성 → 타깃별 Run 등록 → run 이벤트 Ingest(android: 통과, ios: 1회 실패 뒤 재시도 통과) → GET /cycles/:id.
# 사용: scripts/cycle.sh <RUN_DIR> [evidence-name]   증거: evidence/<name>-create.json, -view-mid.json, -view-final.json
set -euo pipefail
RUN_DIR=${1:?RUN_DIR 필요}; NAME=${2:-cycle}
PORT=$(node -p "JSON.parse(require('fs').readFileSync('$RUN_DIR/server.json','utf8')).port")
HERE=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$RUN_DIR/evidence" "$RUN_DIR/tmp"
req() { # method path body-json evidence-name
  local out="$RUN_DIR/tmp/$4.json"
  local code; code=$(curl -s -o "$out" -w '%{http_code}' -X "$1" "http://127.0.0.1:$PORT$2" -H 'content-type: application/json' --data-binary "$3")
  node -e 'const fs=require("fs");const [m,p,b,c,o,d]=process.argv.slice(1);fs.writeFileSync(d,JSON.stringify({request:{method:m,path:p,body:JSON.parse(b)},status:Number(c),response:JSON.parse(fs.readFileSync(o,"utf8"))},null,2))' "$1" "$2" "$3" "$code" "$out" "$RUN_DIR/evidence/$4.json"
  cat "$out"
}
CYCLE=$(req POST /cycles "{\"cycleId\":\"verify-cycle-$$\",\"build\":\"1.2.3-verify\",\"targets\":[\"android\",\"ios\"]}" "$NAME-create" | node -p 'JSON.parse(require("fs").readFileSync(0,"utf8")).cycleId')
ANDROID=$(req POST "/cycles/$CYCLE/runs" '{"targetId":"android"}' "$NAME-run-android" | node -p 'JSON.parse(require("fs").readFileSync(0,"utf8")).runId')
IOS=$(req POST "/cycles/$CYCLE/runs" '{"targetId":"ios"}' "$NAME-run-ios" | node -p 'JSON.parse(require("fs").readFileSync(0,"utf8")).runId')
node -e '
const [cycle,android,ios,dir]=process.argv.slice(1);const fs=require("fs");
const at=(s)=>`2026-11-07T00:00:${String(s).padStart(2,"0")}.000Z`;const T="로그인 > 아이디로 로그인한다";
const mk=(run,pre,target,attempts)=>{const ev=[{schema:1,eventId:`${pre}0`,runId:run,at:at(0),type:"run.started",cycleId:cycle,targetId:target}];let s=1;
 for(const [no,result] of attempts){ev.push({schema:1,eventId:`${pre}${s}`,runId:run,at:at(s++),type:"attempt.started",attemptId:`${pre}a${no}`,testId:T,attemptNo:no});
  ev.push({schema:1,eventId:`${pre}${s}`,runId:run,at:at(s++),type:"attempt.finished",attemptId:`${pre}a${no}`,result,...(result==="failed"?{errorCode:"not-found"}:{}),artifacts:[]});}
 ev.push({schema:1,eventId:`${pre}${s}`,runId:run,at:at(s),type:"run.finished",state:"finished"});return ev;};
fs.writeFileSync(`${dir}/android.json`,JSON.stringify(mk(android,"and-",'"'"'android'"'"',[[1,"passed"]])));
fs.writeFileSync(`${dir}/ios.json`,JSON.stringify(mk(ios,"ios-","ios",[[1,"failed"],[2,"passed"]])));' "$CYCLE" "$ANDROID" "$IOS" "$RUN_DIR/tmp"
"$HERE/ingest.sh" "$RUN_DIR" "$RUN_DIR/tmp/android.json" "$NAME-ingest-android" >/dev/null
"$HERE/get.sh" "$RUN_DIR" "/cycles/$CYCLE" "$NAME-view-mid" >/dev/null
"$HERE/ingest.sh" "$RUN_DIR" "$RUN_DIR/tmp/ios.json" "$NAME-ingest-ios" >/dev/null
"$HERE/get.sh" "$RUN_DIR" "/cycles/$CYCLE" "$NAME-view-final" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=JSON.parse(s);console.log(JSON.stringify({cycleId:v.cycleId,state:v.state,verdict:v.verdict,matrix:v.matrix}))})'
