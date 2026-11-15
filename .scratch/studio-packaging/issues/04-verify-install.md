# 04-verify-install

**What to build:** 설치본을 리포 밖으로 복사해 Playwright executablePath 로 띄우고 작업 프로세스(동봉 Node)·기기·URL 스킴 확인, verify 스킬

**Blocked by:** 03

**Status:** done — `.claude/skills/verify-studio/scripts/verify-install.ts` 8/8(두 번 연속): 처리기 등록, 설치본(리포 밖), 동봉 Node v24.13.0 준비(PATH 에 node 없음), env 파일 키 전달, 데몬 기기(…XLZW), 실행 중 인스턴스로 open-url·목표 205~458ms(폴링 전), 콜드 스타트 3.2초 ack. 개발 모드 verify-studio fake 25/25. 발견: LaunchServices 는 /private/tmp·/var/folders 아래 앱을 URL 처리기로 쓰지 않는다; 리포 release 복사본이 등록돼 있으면 open 이 그쪽을 띄운다
