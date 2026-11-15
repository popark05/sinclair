# 01-worker-bundle

**What to build:** 작업 프로세스 esbuild 단일 ESM 번들(usb external, 리포 경로 가드), 메인이 설치본이면 동봉 Node·번들·execArgv 없음으로 띄움, 헬퍼 APK·env 파일 해석. 번들을 리포 밖에서 고정 Node 로 띄워 ready

**Blocked by:** ready-for-agent

**Status:** done — esbuild 단일 번들(1.6MB, 리포 경로·__dirname 가드), 메인이 설치본이면 동봉 Node·번들·플래그 없음·동봉 헬퍼 APK, ~/.config/sinclair/env 의 허용 이름(ANTHROPIC_*·SINCLAIR_*·NODE_EXTRA_CA_CERTS)을 작업 프로세스 환경에. 번들을 리포 밖 임시 폴더에서 띄워 ready·ping 테스트
