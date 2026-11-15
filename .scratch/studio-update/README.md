# Studio 앱 아이콘·자동 업데이트

## 결정 (2026-11-15)

- **아이콘:** `apps/studio/build/icon.svg` 가 원본이다. 그림은 휴대폰 화면 위 검증 체크와 에이전트를 뜻하는 반짝임이고, macOS 그리드(824 본체)를 따른다. `scripts/build-studio-icon.mjs` 가 Electron 화면 밖 창으로 PNG 를 그리고 sips·iconutil 로 icns 를 만든다. 새 의존은 없다. png·icns 는 커밋하고, dist 는 커밋된 icns 를 쓴다.
- **업데이트 장치:** electron-updater 는 쓰지 않는다. 그 mac 경로(Squirrel.Mac)는 코드 서명된 앱만 업데이트하는데, 우리 배포본은 서명하지 않는다(사내 배포).
- **배포 위치:** control-plane 이다. Studio 설정에 이미 control-plane 주소가 있고 사내망 안에 있으므로 새 서버나 주소가 필요 없다. 운영자는 `pnpm dist:studio` 의 zip 들과 `latest-mac.json` 을 `--studio-releases-dir` 에 둔다. 목록 파일은 요청마다 읽으므로 재시작 없이 바뀐다.
- **흐름:**
  1. Studio 는 기동 5초 뒤와 4시간마다 새 버전을 확인한다.
  2. 새 버전이 있으면 툴바에 `업데이트 x.y.z` 버튼이 나온다. 설치는 사람이 누른다. 세션 중 갑자기 재시작되지 않게 하려는 것이다.
  3. 누르면 zip 을 받아 크기와 sha256 을 확인하고 `ditto` 로 푼다. 번들 id(`dev.sinclair.studio`)와 버전이 목록과 같은지 맞추고, 격리 속성을 지운다.
  4. 분리된 sh 가 Studio 가 끝나기를 기다렸다 같은 경로의 .app 을 바꾸고 `open` 으로 다시 띄운다. 바꾸지 못하면 옛 앱을 되돌린다.
  5. 같은 경로에 들어가므로 PATH 에 건 CLI 링크도 그대로 동작한다.
- **업데이트하지 않는 경우:** 개발 모드, 디스크 이미지·App Translocation 위치에서 실행, 쓸 수 없는 폴더(이때는 이유를 보인다).
- **연결:** 받기는 Electron `net.fetch` 로 한다. 시스템 인증서 저장소를 쓰므로 사내 CA 도 통과한다.

## 티켓

01 아이콘 / 02 control-plane 배포(`/studio/releases/latest?arch=`, `/studio/releases/files/:name`, `--studio-releases-dir`, dist 의 `latest-mac.json`) / 03 Studio 업데이터(main `updater.ts`, IPC, 툴바·설정) / 04 설치본 종단 검증
