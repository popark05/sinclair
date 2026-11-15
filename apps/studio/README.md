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

## 설정

- **Claude API 키·사내망 CA**: Finder 로 띄운 앱은 터미널 환경변수를 받지 못합니다. `~/.config/sinclair/env` 에 적어 두면 읽습니다(권한 600 권장). 받는 이름은 `ANTHROPIC_*`, `SINCLAIR_*`, `NODE_EXTRA_CA_CERTS` 뿐입니다.
  ```bash
  export ANTHROPIC_API_KEY=…
  export NODE_EXTRA_CA_CERTS=$HOME/.certs/all-system-certs.pem   # 사내망
  ```
- **control-plane·테스트 폴더**: 툴바 `설정`. 기본 control-plane 은 `http://127.0.0.1:4780`.

## 기기

- **데몬이 떠 있으면**(`sinclair-agent daemon`, CLI 설치본) Studio 는 데몬이 가진 기기에 붙습니다(툴바 "데몬"). 데몬이 그 기기로 Run 을 돌리는 동안은 화면을 10초마다만 받고 세션을 막습니다.
- **데몬이 없으면** Studio 가 USB 기기를 직접 엽니다. Android 는 USB 디버깅 허용, 데몬·adb 서버와 동시에 같은 기기를 잡지 않습니다.
- **iPhone**: Xcode, Apple ID 로그인, iPhone 개발자 모드가 필요하고, `packages/device-layer/ios-runner/build.sh` 로 러너를 빌드해 `SINCLAIR_IOS_XCTESTRUN`(env 파일)에 경로를 줍니다. 무료 팀 서명은 7일마다 다시 빌드합니다.

## Console 에서 열기

Console 케이스 상세의 'Studio 에서 열기' 는 control-plane 에 열기 요청을 남기고 `sinclair://open?request=<id>` 를 엽니다. Studio 가 떠 있으면 바로 앞으로 와서 기기·목표를 채우고, 꺼져 있으면 링크가 Studio 를 띄웁니다. 실행은 사람이 누릅니다.

## 개발

```bash
pnpm --filter @sinclair/studio dev     # electron-vite dev --watch
pnpm dist:studio                       # release/studio/ 에 dmg·zip(--dir 은 .app 만)
```

검증: `.claude/skills/verify-studio`(개발 모드 fake·실기 `--device [--platform ios|android]`, 설치본 `scripts/verify-install.ts`).
