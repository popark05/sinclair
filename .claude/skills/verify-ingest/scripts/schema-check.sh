#!/usr/bin/env bash
# 스키마 가드 증명: DB 의 user_version 을 더 새로운 값으로 올린 뒤 서버 기동이 "스키마 버전" 메시지로 거부되는지 본다.
# 사용: scripts/schema-check.sh <RUN_DIR>   (서버는 내려가 있어야 한다. 끝나면 버전을 되돌린다)
set -uo pipefail
RUN_DIR=${1:?RUN_DIR 필요}
[ -f "$RUN_DIR/server.pid" ] && { echo "SCHEMA-CHECK FAIL: 서버가 떠 있음. stop.sh 먼저"; exit 1; }
DB=${SINCLAIR_INGEST_DB:-$RUN_DIR/control-plane.db}
[ -f "$DB" ] || { echo "SCHEMA-CHECK FAIL: $DB 없음 (sqlite 모드로 한 번 띄운 뒤)"; exit 1; }
HERE=$(cd "$(dirname "$0")" && pwd)
CUR=$(node -e 'const {DatabaseSync}=require("node:sqlite");const d=new DatabaseSync(process.argv[1]);console.log(d.prepare("PRAGMA user_version").get().user_version)' "$DB" 2>/dev/null)
node -e 'const {DatabaseSync}=require("node:sqlite");const d=new DatabaseSync(process.argv[1]);d.exec(`PRAGMA user_version = ${Number(process.argv[2])+1}`)' "$DB" "$CUR" 2>/dev/null
OUT=$(SINCLAIR_INGEST_STORE=sqlite "$HERE/start.sh" "$RUN_DIR" 2>&1); CODE=$?
"$HERE/stop.sh" "$RUN_DIR" >/dev/null 2>&1
node -e 'const {DatabaseSync}=require("node:sqlite");const d=new DatabaseSync(process.argv[1]);d.exec(`PRAGMA user_version = ${Number(process.argv[2])}`)' "$DB" "$CUR" 2>/dev/null
mkdir -p "$RUN_DIR/evidence"
node -e 'const [code,out,dest]=process.argv.slice(1);require("fs").writeFileSync(dest,JSON.stringify({startExitCode:Number(code),refused:Number(code)!==0&&/스키마 버전/.test(out),output:out.split("\n").filter(l=>/스키마 버전|READY/.test(l))},null,2))' "$CODE" "$OUT" "$RUN_DIR/evidence/schema-guard.json"
if [ "$CODE" != "0" ] && echo "$OUT" | grep -q "스키마 버전"; then echo "SCHEMA-GUARD OK (version $CUR → $((CUR+1)) 거부됨, 되돌림)"; else echo "SCHEMA-CHECK FAIL: 기동이 거부되지 않음"; echo "$OUT" | tail -5; exit 1; fi
