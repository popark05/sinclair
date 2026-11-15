# Sinclair Studio

테스트를 작성·디버깅하는 데스크탑 앱입니다. 기기 화면을 보며 자연어 목표로 에이전트 세션을 돌리고, 판정을 더해 테스트 코드로 내보내거나 Cycle 로 실행합니다.

## 설치 (macOS)

1. `Sinclair-Studio-<버전>-mac-arm64.dmg`(Apple Silicon) 또는 `…-mac-x64.dmg`(Intel)를 열어 `Sinclair Studio` 를 `응용 프로그램` 으로 끌어 놓습니다.
2. 서명하지 않은 사내 배포본이라 처음 한 번 격리 속성을 지웁니다.
   ```bash
   xattr -dr com.apple.quarantine "/Applications/Sinclair Studio.app"
   ```
   그래도 막히면 시스템 설정 → 개인정보 보호 및 보안에서 허용합니다.
3. `/tmp` 같은 임시 폴더에 두면 Console 의 'Studio 에서 열기' 링크(`sinclair://`)가 이 앱으로 오지 않습니다. `응용 프로그램` 이나 홈 폴더 아래에 둡니다.

Node·Android 헬퍼 APK 를 함께 넣어 두었으므로 따로 설치할 것은 없습니다.

## CLI(control-plane·에이전트)

Studio 안에 CLI 가 들어 있어 따로 설치하지 않아도 됩니다. PATH 에 링크를 걸어 씁니다.

```bash
mkdir -p ~/.local/bin   # PATH 에 있는 폴더(예: /usr/local/bin)면 어디든
ln -sf "/Applications/Sinclair Studio.app/Contents/Resources/cli/bin/sinclair-agent" ~/.local/bin/
ln -sf "/Applications/Sinclair Studio.app/Contents/Resources/cli/bin/sinclair-control-plane" ~/.local/bin/
sinclair-control-plane --port 4780          # Console: http://127.0.0.1:4780/console/
sinclair-agent daemon --control-plane http://127.0.0.1:4780 --targets android --tests <테스트 폴더>
```

Studio 와 같은 Node·헬퍼 APK 를 쓰고, 버전도 Studio 와 같습니다. Studio 를 업데이트하면 CLI 도 함께 바뀝니다. 기기 노드 서버나 Windows 처럼 Studio 가 없는 머신은 CLI zip 설치본(`pnpm dist`)을 씁니다.

## 설정

- **Claude API 키·사내망 CA**: Finder 로 띄운 앱은 터미널 환경변수를 받지 못합니다. `~/.config/sinclair/env` 에 적어 두면 읽습니다(권한 600 권장). 받는 이름은 `ANTHROPIC_*`, `SINCLAIR_*`, `NODE_EXTRA_CA_CERTS` 뿐입니다.
  ```bash
  export ANTHROPIC_API_KEY=…
  export NODE_EXTRA_CA_CERTS=$HOME/.certs/all-system-certs.pem   # 사내망
  ```
- **control-plane·테스트 폴더**: 툴바 `설정`. 기본 control-plane 은 `http://127.0.0.1:4780`.

## 기기

- **데몬이 떠 있으면**(`sinclair-agent daemon`, 위 CLI) Studio 는 데몬이 가진 기기에 붙습니다(툴바 "데몬"). 데몬이 그 기기로 Run 을 돌리는 동안은 화면을 10초마다만 받고 세션을 막습니다.
- **데몬이 없으면** Studio 가 USB 기기를 직접 엽니다. Android 는 USB 디버깅 허용, 데몬·adb 서버와 동시에 같은 기기를 잡지 않습니다.
- **iPhone**: Xcode, Apple ID 로그인, iPhone 개발자 모드가 필요하고, `packages/device-layer/ios-runner/build.sh` 로 러너를 빌드해 `SINCLAIR_IOS_XCTESTRUN`(env 파일)에 경로를 줍니다. 무료 팀 서명은 7일마다 다시 빌드합니다.

## 업데이트

Studio 는 설정의 control-plane 에 새 버전이 있는지 기동 때와 4시간마다 확인합니다. 새 버전이 있으면 툴바에 `업데이트 x.y.z` 버튼이 나옵니다. 누르면 받아서 확인한 뒤 같은 자리의 앱을 바꾸고 다시 띄웁니다. 설정 대화상자에서 지금 버전을 보고 바로 확인할 수도 있습니다. `응용 프로그램` 처럼 쓸 수 있는 폴더에 둔 앱만 업데이트됩니다(디스크 이미지 안에서 띄운 앱은 업데이트하지 않습니다).

**배포(운영자):** `pnpm dist:studio` 가 만든 `release/studio/` 의 `Sinclair-Studio-<v>-mac-*.zip` 과 `latest-mac.json` 을 한 폴더에 두고, control-plane 을 `--studio-releases-dir <그 폴더>`(또는 `SINCLAIR_CP_STUDIO_RELEASES_DIR`)로 띄웁니다. 새 버전은 파일만 바꿔 끼우면 되고, 재시작은 필요 없습니다. 버전은 루트 `package.json` 의 version 입니다.

## Console 에서 열기

Console 케이스 상세의 'Studio 에서 열기' 는 control-plane 에 열기 요청을 남기고 `sinclair://open?request=<id>` 를 엽니다. Studio 가 떠 있으면 바로 앞으로 와서 기기·목표를 채우고, 꺼져 있으면 링크가 Studio 를 띄웁니다. 실행은 사람이 누릅니다.

## 개발

```bash
pnpm --filter @sinclair/studio dev     # electron-vite dev --watch
pnpm dist:studio                       # release/studio/ 에 dmg·zip(--dir 은 .app 만)
```

검증: `.claude/skills/verify-studio`(개발 모드 fake·실기 `--device [--platform ios|android]`, 설치본 `scripts/verify-install.ts`).
