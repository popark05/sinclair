# 02-electron-builder

**What to build:** 스테이징 디렉터리(out + 의존성 없는 package.json) → electron-builder mac dmg·zip arm64/x64, extraResources(node·worker 번들·usb·헬퍼 APK), protocols sinclair

**Blocked by:** 01

**Status:** done — `pnpm dist:studio` → release/studio/Sinclair-Studio-0.1.0-mac-{arm64,x64}.{dmg,zip}(약 153·158MB). asar 2.8MB(out·package.json), Resources: node(v24.13.0), worker(번들 + usb 플랫폼별), helper APK, VERSION. Info.plist CFBundleURLSchemes sinclair. 리포 밖 복사본이 PATH 에 node 없이 작업 프로세스 ready(동봉 Node, 0.4초)
