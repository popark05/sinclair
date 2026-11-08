#!/usr/bin/env bash
# 실기기: 헬퍼를 지운 뒤(adb uninstall → adb kill-server) 설치본 에이전트가 번들 APK 로 온보딩하고 설정 앱 샘플을 통과하는지.
# 사용: scripts/run-device.sh <RUN_DIR> [serial]   증거: evidence/install-device.json (시리얼·홈 마스킹)
set -uo pipefail
RUN_DIR=${1:?RUN_DIR 필요}; SERIAL=${2:-}
. "$(dirname "$0")/lib.sh"; RUN_DIR=$(resolve_run_dir "$RUN_DIR")
DIR=$(install_dir "$RUN_DIR"); PORT=$(server_port "$RUN_DIR")
URL="http://127.0.0.1:$PORT"; CYCLE="install-device-$(date +%s)"
ADB=${ADB:-$HOME/Library/Android/sdk/platform-tools/adb}; command -v adb >/dev/null && ADB=adb
[ -z "$SERIAL" ] && SERIAL=$("$ADB" devices | awk 'NR>1 && $2=="device"{print $1; exit}')
[ -n "$SERIAL" ] || { echo "DEVICE FAIL: 꽂힌 기기 없음"; exit 1; }
UNINSTALL=$("$ADB" -s "$SERIAL" uninstall io.sinclair.helper 2>&1 | tr -d '\r')
"$ADB" kill-server   # 직접 USB 경로가 인터페이스를 잡을 수 있게
mkdir -p "$RUN_DIR/evidence" "$RUN_DIR/devtests"
cp apps/runner-agent/test/fixtures/device/settings.sinclair.ts "$RUN_DIR/devtests/"
curl -s -X POST "$URL/cycles" -d "{\"cycleId\":\"$CYCLE\",\"build\":\"verify\",\"targets\":[\"android\"]}" >/dev/null
OUT=$(cd /tmp && SINCLAIR_AGENT_HELPER_URL= "$DIR/bin/sinclair-agent" run --control-plane "$URL" --cycle "$CYCLE" --target android --device "$SERIAL" --app com.android.settings --tests "$RUN_DIR/devtests" --spool "$RUN_DIR/spool" --helper-cache "$RUN_DIR/helper-cache" 2>&1); CODE=$?
VIEW=$(curl -s "$URL/cycles/$CYCLE")
node -e "$mask_js"'const [code,out,view,dest,serial,home,uninstall]=process.argv.slice(1);const v=JSON.parse(view);const m=(s)=>mask(s.replaceAll(serial,`…${serial.slice(-4)}`),home);require("fs").writeFileSync(dest,JSON.stringify({exitCode:Number(code),uninstall:m(uninstall),output:out.split("\n").map(m),cycle:{state:v.state,verdict:v.verdict}},null,2))' "$CODE" "$OUT" "$VIEW" "$RUN_DIR/evidence/install-device.json" "$SERIAL" "$HOME" "$UNINSTALL"
echo "DEVICE exit=$CODE $(node -p "const v=JSON.parse(process.argv[1]);v.state+'/'+v.verdict" "$VIEW") apk=$(echo "$OUT" | sed -n 's/.*헬퍼 APK: .*(\(.*\)).*/\1/p' | head -1)"
[ "$CODE" = "0" ]
