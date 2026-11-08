#!/usr/bin/env bash
# 사내망 흉내: openssl 자체 CA + 127.0.0.1 서버 인증서 → 동봉 Node 로 HTTPS 릴리스 서버 → 설치본 에이전트가
# (번들을 SINCLAIR_RESOURCES_DIR 빈 디렉터리로 끈 채) NODE_EXTRA_CA_CERTS 없이는 실패, 있으면 (download) 로 APK 를 받는지 본다. 기기는 필요 없다.
# 사용: scripts/ca-check.sh <RUN_DIR>   증거: evidence/install-ca.json
set -uo pipefail
RUN_DIR=${1:?RUN_DIR 필요}
. "$(dirname "$0")/lib.sh"; RUN_DIR=$(resolve_run_dir "$RUN_DIR")
DIR=$(install_dir "$RUN_DIR"); PORT=$(server_port "$RUN_DIR")
URL="http://127.0.0.1:$PORT"; CA="$RUN_DIR/ca"; mkdir -p "$CA" "$RUN_DIR/evidence" "$RUN_DIR/empty-resources" "$RUN_DIR/tests"
HERE=$(cd "$(dirname "$0")" && pwd)
openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj "/CN=Sinclair Verify CA" -keyout "$CA/ca.key" -out "$CA/ca.pem" >"$CA/openssl.log" 2>&1 || { echo "CA FAIL: openssl CA 생성 실패"; cat "$CA/openssl.log"; exit 1; }
openssl req -newkey rsa:2048 -nodes -subj "/CN=127.0.0.1" -keyout "$CA/srv.key" -out "$CA/srv.csr" >>"$CA/openssl.log" 2>&1 || { echo "CA FAIL: 서버 CSR 실패"; exit 1; }
printf "subjectAltName=IP:127.0.0.1\n" >"$CA/ext.cnf"
openssl x509 -req -in "$CA/srv.csr" -CA "$CA/ca.pem" -CAkey "$CA/ca.key" -CAcreateserial -days 2 -extfile "$CA/ext.cnf" -out "$CA/srv.pem" >>"$CA/openssl.log" 2>&1 || { echo "CA FAIL: 서버 인증서 서명 실패"; exit 1; }
"$DIR/node/node" "$HERE/release-server.mjs" "$CA/srv.pem" "$CA/srv.key" "$DIR/resources/helper" </dev/null >"$RUN_DIR/release.out" 2>&1 & RPID=$!
for _ in $(seq 1 50); do grep -q READY "$RUN_DIR/release.out" 2>/dev/null && break; sleep 0.1; done  # 0.1s × 50 = 5초: 동봉 Node 기동 + TLS 서버 listen
RPORT=$(sed -n 's/^READY port=\([0-9]*\).*/\1/p' "$RUN_DIR/release.out")
[ -n "$RPORT" ] || { echo "CA FAIL: 릴리스 서버가 READY 를 내지 않음"; cat "$RUN_DIR/release.out"; kill $RPID 2>/dev/null; exit 1; }
[ -f "$RUN_DIR/tests/login.sinclair.ts" ] || printf "import { test } from '@sinclair/runner';\ntest('x', async () => {});\n" >"$RUN_DIR/tests/login.sinclair.ts"
run_agent() { # $1 = 이름, 나머지 env. 기기 없이(NO-SUCH-DEVICE) APK 해석 단계만 본다
  local name=$1; shift
  local cycle="ca-$name-$$"
  curl -s -X POST "$URL/cycles" -d "{\"cycleId\":\"$cycle\",\"build\":\"verify\",\"targets\":[\"android\"]}" >/dev/null
  (cd /tmp && env "$@" SINCLAIR_RESOURCES_DIR="$RUN_DIR/empty-resources" SINCLAIR_AGENT_HELPER_URL="https://127.0.0.1:$RPORT" SINCLAIR_AGENT_HELPER_APK= \
    "$DIR/bin/sinclair-agent" run --control-plane "$URL" --cycle "$cycle" --target android --device NO-SUCH-DEVICE --tests "$RUN_DIR/tests" --engine mobile --spool "$RUN_DIR/spool" --helper-cache "$RUN_DIR/ca-cache-$name" 2>&1)
}
OUT_NO_CA=$(run_agent without); CODE_NO_CA=$?
OUT_WITH_CA=$(run_agent with NODE_EXTRA_CA_CERTS="$CA/ca.pem"); CODE_WITH_CA=$?
kill $RPID 2>/dev/null
# 꽂힌 기기가 있으면 "목록에 없음(<시리얼>)" 에 실시리얼이 섞이므로 시리얼도 마스킹한다
node -e "$mask_js"'const [cw,ow,cx,ox,dest,home]=process.argv.slice(1);const m=(s)=>mask(s,home);const fs=require("fs");
const without={exitCode:Number(cw),reason:ow.split("\n").filter(l=>/download:|헬퍼 APK/.test(l)).map(m)};const withCa={exitCode:Number(cx),apkLine:m(ox.split("\n").find(l=>/헬퍼 APK: /.test(l))||""),deviceLine:m(ox.split("\n").find(l=>/기기|불가/.test(l))||"")};
fs.writeFileSync(dest,JSON.stringify({without,withCa},null,2))' "$CODE_NO_CA" "$OUT_NO_CA" "$CODE_WITH_CA" "$OUT_WITH_CA" "$RUN_DIR/evidence/install-ca.json" "$HOME"
echo "CA without: exit=$CODE_NO_CA $(echo "$OUT_NO_CA" | grep -o 'download: sha256 사이드카[^)]*)' | head -1)"
echo "CA with:    exit=$CODE_WITH_CA $(echo "$OUT_WITH_CA" | grep -o '헬퍼 APK: .*' | head -1 | sed "s|$HOME|<home>|")"
# CA 없이는 TLS 원인(자체 서명 인증서)이 사유에 보여야 "CA 때문" 이 증명된다
echo "$OUT_NO_CA" | grep -q "download: sha256 사이드카.*\(SELF_SIGNED\|self.signed\|UNABLE_TO_VERIFY\|CERT\)" && echo "$OUT_WITH_CA" | grep -q "(download)"
