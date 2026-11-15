# 02-release-feed

**What to build:** control-plane Studio 배포 엔드포인트와 dist:studio 의 latest-mac.json

**Status:** done. `apps/control-plane/test/studio-releases-http.test.ts` 5개: 최신 버전·파일, 404·400·500, 목록 밖 파일과 경로 조작, 크기 불일치, 설정, dist 가 만든 목록의 검증 통과.
