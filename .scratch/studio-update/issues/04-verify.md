# 04-verify

**What to build:** 설치본 종단: 동봉 CLI control-plane 이 버전만 올린 같은 빌드를 배포 → 설치본이 툴바에 알리고 누르면 바꿔 끼워 다시 뜸

**Status:** done. verify-install 16/16(빌드 직후 실행 포함). 기동 4.9초에 툴바에 '업데이트 99.0.0' 이 나왔고, 누른 뒤 5.3초에 Info.plist 가 0.1.0 → 99.0.0 이 되고 새 프로세스가 떴다. 교체 뒤에도 CLI 링크가 동작한다. 개발 모드 verify-studio fake 25/25.

발견: 빌드 직후 LaunchServices 가 리포 빌드를 늦게 다시 등록해 sinclair:// 처리기를 빼앗았다. 처리기가 맞을 때까지 등록 해제·등록을 반복한다.
