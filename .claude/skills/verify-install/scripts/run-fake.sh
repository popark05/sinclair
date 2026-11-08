#!/usr/bin/env bash
# 설치본 에이전트로 FakeEngine run: Reporter → 설치본 서버 → verified. 사용: scripts/run-fake.sh <RUN_DIR>   증거: evidence/install-fake.json
set -uo pipefail
RUN_DIR=${1:?RUN_DIR 필요}
. "$(dirname "$0")/lib.sh"; RUN_DIR=$(resolve_run_dir "$RUN_DIR")
DIR=$(install_dir "$RUN_DIR"); PORT=$(server_port "$RUN_DIR")
URL="http://127.0.0.1:$PORT"; CYCLE="install-fake-$(date +%s)"
mkdir -p "$RUN_DIR/tests" "$RUN_DIR/evidence"
printf "import { test } from '@sinclair/runner';\ntest('로그인', async ({ screen, expect }) => { await screen.getByRole('button', { name: '로그인' }).tap(); await expect(screen.getByText('환영합니다')).toBeVisible(); });\n" >"$RUN_DIR/tests/login.sinclair.ts"
curl -s -X POST "$URL/cycles" -d "{\"cycleId\":\"$CYCLE\",\"build\":\"verify\",\"targets\":[\"android\"]}" >/dev/null
OUT=$(cd /tmp && "$DIR/bin/sinclair-agent" run --control-plane "$URL" --cycle "$CYCLE" --target android --tests "$RUN_DIR/tests" --engine fake --spool "$RUN_DIR/spool" 2>&1); CODE=$?
VIEW=$(curl -s "$URL/cycles/$CYCLE")
node -e 'const [code,out,view,dest]=process.argv.slice(1);const v=JSON.parse(view);require("fs").writeFileSync(dest,JSON.stringify({exitCode:Number(code),output:out.split("\n"),cycle:{state:v.state,verdict:v.verdict}},null,2))' "$CODE" "$OUT" "$VIEW" "$RUN_DIR/evidence/install-fake.json"
echo "FAKE exit=$CODE $(node -p "const v=JSON.parse(process.argv[1]);v.state+'/'+v.verdict" "$VIEW")"
[ "$CODE" = "0" ]
