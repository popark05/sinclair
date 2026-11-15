#!/usr/bin/env bash
# iOS 러너 build-for-testing(ios-backend 04). 결과 .xctestrun 경로를 마지막 줄에 출력한다 → SINCLAIR_IOS_XCTESTRUN 에 지정.
#   ./build.sh --team <TEAM_ID> [--bundle-prefix dev.sinclair.<이름>]   # 실기기(서명 필요, Xcode 에 Apple ID 로그인)
#   ./build.sh --simulator                                             # 시뮬레이터(서명 없음)
set -euo pipefail
cd "$(dirname "$0")"

TEAM="" PREFIX="" SIM=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --team) TEAM="$2"; shift 2 ;;
    --bundle-prefix) PREFIX="$2"; shift 2 ;;
    --simulator) SIM=1; shift ;;
    *) echo "모르는 옵션: $1" >&2; exit 2 ;;
  esac
done

command -v xcodegen >/dev/null || { echo "xcodegen 이 없음: brew install xcodegen" >&2; exit 1; }
xcodegen generate --quiet

ARGS=(build-for-testing -project SinclairRunner.xcodeproj -scheme SinclairRunner -derivedDataPath build -quiet)
if [[ $SIM == 1 ]]; then
  ARGS+=(-destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO)
else
  [[ -n "$TEAM" ]] || { echo "실기기 빌드는 --team <TEAM_ID> 가 필요(Xcode → Settings → Accounts 의 팀)" >&2; exit 2; }
  ARGS+=(-destination 'generic/platform=iOS' -allowProvisioningUpdates DEVELOPMENT_TEAM="$TEAM")
fi
[[ -n "$PREFIX" ]] && ARGS+=(SINCLAIR_BUNDLE_PREFIX="$PREFIX")
xcodebuild "${ARGS[@]}"

PLATFORM=$([[ $SIM == 1 ]] && echo iphonesimulator || echo iphoneos)
ls -t build/Build/Products/*"$PLATFORM"*.xctestrun | head -1 | sed "s|^|$PWD/|"
