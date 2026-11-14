# 02: iOS 러너 HTTP 계약·호스트 클라이언트·트리 변환

**What to build:** 러너 API(헬퍼와 같은 모양): `GET /ping`(버전·iOS·모델·화면 크기·배율), `GET /dump`, `GET /snapshot`(스크린샷+트리 원자), `POST /action`(tap·long_press·swipe·type·key), `POST /app`(launch·terminate·foreground). XCUIElement 트리(타입·label·value·placeholderValue·identifier·frame 포인트·enabled·selected·hasFocus) → SemanticNode(역할 매핑, 포인트→픽셀 배율, secure 텍스트 가림). 가짜 러너로 테스트.

**Status:** ready-for-agent
