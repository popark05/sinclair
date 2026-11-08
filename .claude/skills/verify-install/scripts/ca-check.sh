#!/usr/bin/env bash
# 사내망 흉내: openssl 자체 CA + 127.0.0.1 서버 인증서 → 동봉 Node 로 HTTPS 릴리스 서버 → 설치본 에이전트가
# (번들을 SINCLAIR_RESOURCES_DIR 빈 디렉터리로 끈 채) NODE_EXTRA_CA_CERTS 없이는 실패, 있으면 (download) 로 APK 를 받는지 본다. 기기는 필요 없다.
# 사용: scripts/ca-check.sh <RUN_DIR>   증거: evidence/install-ca.json
set -uo pipefail
RUN_DIR=${1:?RUN_DIR 필요}
RUN_DIR=$(mkdir -p "$RUN_DIR" && cd "$RUN_DIR" && pwd)  # 런처는 /tmp 에서 실행하므로 절대 경로로
DIR=$(node -p "JSON.parse(require('fs').readFileSync('$RUN_DIR/install.json','utf8')).dir"); PORT=$(node -p "JSON.parse(require('fs').readFileSync('$RUN_DIR/server.json','utf8')).port")
URL="http://127.0.0.1:$PORT"; CA="$RUN_DIR/ca"; mkdir -p "$CA" "$RUN_DIR/evidence" "$RUN_DIR/empty-resources" "$RUN_DIR/tests"
HERE=$(cd "$(dirname "$0")" && pwd)
openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj "/CN=Sinclair Verify CA" -keyout "$CA/ca.key" -out "$CA/ca.pem" >/dev/null 2>&1
openssl req -newkey rsa:2048 -nodes -subj "/CN=127.0.0.1" -keyout "$CA/srv.key" -out "$CA/srv.csr" >/dev/null 2>&1
printf "subjectAltName=IP:127.0.0.1\n" >"$CA/ext.cnf"
openssl x509 -req -in "$CA/srv.csr" -CA "$CA/ca.pem" -CAkey "$CA/ca.key" -CAcreateserial -days 2 -extfile "$CA/ext.cnf" -out "$CA/srv.pem" >/dev/null 2>&1
"$DIR/node/node" "$HERE/release-server.mjs" "$CA/srv.pem" "$CA/srv.key" "$DIR/resources/helper" </dev/null >"$RUN_DIR/release.out" 2>&1 & RPID=$!
for _ in $(seq 1 50); do grep -q READY "$RUN_DIR/release.out" 2>/dev/null && break; sleep 0.1; done
RPORT=$(sed -n 's/^READY port=\([0-9]*\).*/\1/p' "$RUN_DIR/release.out")
[ -f "$RUN_DIR/tests/login.sinclair.ts" ] || printf "import { test } from '@sinclair/runner';\ntest('x', async () => {});\n" >"$RUN_DIR/tests/login.sinclair.ts"
run_agent() { # $1 = 이름, 나머지 env
  local name=$1; shift
  curl -s -X POST "$URL/cycles" -d "{\"cycleId\":\"ca-$name-$$\",\"build\":\"verify\",\"targets\":[\"android\"]}" >/dev/null
  (cd /tmp && env "$@" SINCLAIR_RESOURCES_DIR="$RUN_DIR/empty-resources" SINCLAIR_AGENT_HELPER_URL="https://127.0.0.1:$RPORT" SINCLAIR_AGENT_HELPER_APK= \
    "$DIR/bin/sinclair-agent" run --control-plane "$URL" --cycle "ca-$name-$$" --target android --device NO-SUCH-DEVICE --tests "$RUN_DIR/tests" --engine mobile --spool "$RUN_DIR/spool" --helper-cache "$RUN_DIR/ca-cache-$name" 2>&1)
}
WITHOUT=$(run_agent without); CODE_WITHOUT=$?
WITH=$(run_agent with NODE_EXTRA_CA_CERTS="$CA/ca.pem"); CODE_WITH=$?
kill $RPID 2>/dev/null
node -e 'const [cw,ow,cx,ox,dest,home]=process.argv.slice(1);const m=(s)=>s.replaceAll(home,"<home>");const fs=require("fs");
const without={exitCode:Number(cw),reason:ow.split("\n").filter(l=>/download:|헬퍼 APK/.test(l)).map(m)};const withCa={exitCode:Number(cx),apkLine:ox.split("\n").find(l=>/헬퍼 APK: /.test(l))||"",deviceLine:ox.split("\n").find(l=>/기기|불가/.test(l))||""};
fs.writeFileSync(dest,JSON.stringify({without,withCa:{...withCa,apkLine:m(withCa.apkLine),deviceLine:m(withCa.deviceLine)}},null,2))' "$CODE_WITHOUT" "$WITHOUT" "$CODE_WITH" "$WITH" "$RUN_DIR/evidence/install-ca.json" "$HOME"
echo "CA without: exit=$CODE_WITHOUT $(echo "$WITHOUT" | grep -o 'download: [^(]*' | head -1)"
echo "CA with:    exit=$CODE_WITH $(echo "$WITH" | grep -o '헬퍼 APK: .*' | head -1 | sed "s|$HOME|<home>|")"
echo "$WITHOUT" | grep -q "download: sha256 사이드카" && echo "$WITH" | grep -q "(download)"
