# REVIEW.md

PR 리뷰(사람과 AI 모두)에서 무엇을 중요하게 볼지 정한다.

## 반드시 지적 (merge 차단)

- `packages/protocol` 계약 변경에 계약 테스트 갱신이 없음
- 의존 방향 위반 (`protocol ← device-layer ← engine-mobile ← runner ← apps`)
- `reference/` 코드의 복사 (특히 FSL 라이선스인 mobilecli, devicekit)
- 비밀값(토큰, 인증서, 사내 URL)이 코드나 테스트 픽스처에 포함됨
- 에이전트가 볼 수 있는 관찰 데이터에 redaction 없이 secure 필드가 노출됨
- 설치된 앱(패키징 빌드)에서 깨지는 변경을 dev 모드에서만 검증함

## 중요 (수정 요청)

- spec과 다른 동작. spec이 틀렸다면 spec을 먼저 고친다
- 디바이스 레이어 호출이 직렬화되지 않아 경쟁 상태 가능
- 폴링·대기 상수가 설명 없이 하드코딩됨

## 사소 (PR 당 최대 3개까지만)

- 네이밍, 주석 문체, 파일 배치

## 제외

- 포매터가 처리하는 스타일
- `reference/`, 생성된 파일, lockfile
