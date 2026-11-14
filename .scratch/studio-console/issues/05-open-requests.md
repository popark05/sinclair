# 05: control-plane 열기 요청 + Console "Studio 에서 열기"

**What to build:** `POST /studio/open-requests`(deviceId·goal?·app?·from{cycleId,testId,targetId}) → {id}, `GET /studio/open-requests?devices=a,b` (그 기기들의 처리 안 된 요청, 10분 TTL), `POST /studio/open-requests/:id/ack`. 메모리 저장(짧게 사는 신호). Console 케이스 상세에 버튼 — 셀의 기기, 마지막 시도의 act 목표.

**Status:** done
