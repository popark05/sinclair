#!/usr/bin/env bash
# 호스트 타깃 배포본을 실제 `pnpm dist`(fetchNode 로 동봉 Node 다운로드·검증, 캐시되면 네트워크 없음)로 만들고 $RUN/install/ 에 푼다.
# 사용: scripts/build.sh <RUN_DIR>   → $RUN_DIR/install.json {dir, zip, version, target, nodeVersion, zipMb}
set -euo pipefail
RUN_DIR=${1:?RUN_DIR 필요}
. "$(dirname "$0")/lib.sh"; RUN_DIR=$(resolve_run_dir "$RUN_DIR")
case "$(uname -s)-$(uname -m)" in Darwin-arm64) TARGET=mac-arm64;; Darwin-x86_64) TARGET=mac-x64;; *) echo "지원하지 않는 호스트: $(uname -s)-$(uname -m)" >&2; exit 1;; esac
node scripts/dist.mjs --targets "$TARGET" --out "$RUN_DIR/release" >"$RUN_DIR/build.out" 2>&1 || { echo "조립 실패" >&2; cat "$RUN_DIR/build.out" >&2; exit 1; }
ZIP=$(ls "$RUN_DIR"/release/sinclair-*-"$TARGET".zip)
rm -rf "$RUN_DIR/install"; mkdir -p "$RUN_DIR/install"
unzip -q "$ZIP" -d "$RUN_DIR/install"
DIR=$(ls -d "$RUN_DIR"/install/sinclair-*)
NODE_VERSION=$("$DIR/node/node" --version)   # 동봉 Node 가 실제로 실행된다는 첫 증거
node -e 'const [dir,zip,nv,target,out]=process.argv.slice(1);const fs=require("fs");const v=fs.readFileSync(`${dir}/VERSION`,"utf8").split("\n")[0];fs.writeFileSync(`${out}/install.json`,JSON.stringify({dir,zip,version:v,target,nodeVersion:nv,zipMb:+(fs.statSync(zip).size/1048576).toFixed(1)},null,2))' "$DIR" "$ZIP" "$NODE_VERSION" "$TARGET" "$RUN_DIR"
grep -E "\[node\]|\[zip\]" "$RUN_DIR/build.out" || true
echo "INSTALLED dir=$DIR node=$NODE_VERSION"
