# 사내망(SSL 인터셉션)에서 헬퍼 다운로드

릴리스 URL 이 사내 CA 로 서명된 HTTPS 일 때, 에이전트는 `NODE_EXTRA_CA_CERTS` 가 있어야만 헬퍼 APK 를 받는다.

## Sub-features

- `ca-without` CA 없이: 번들을 끈 상태(`SINCLAIR_RESOURCES_DIR` 빈 디렉터리)에서 `download: sha256 사이드카 … 실패` 사유로 blocked(2).
- `ca-with` `NODE_EXTRA_CA_CERTS=<ca.pem>`: `헬퍼 APK: … (download)` 로 받아 캐시에 둔다(기기 없음이라 그 뒤 blocked(2) 는 정상).

## How to get to it (user POV)

사내 노드 환경변수에 `SINCLAIR_AGENT_HELPER_URL` 과 `NODE_EXTRA_CA_CERTS` 를 둔다.

## Driving it with scripts

```bash
$S/ca-check.sh $RUN
# CA without: exit=2 download: sha256 사이드카 …
# CA with:    exit=2 헬퍼 APK: …/ca-cache-with/sinclair-helper-<V>.apk (download)
```

## Gotchas

- 자체 CA 는 2일짜리로 매번 새로 만든다(openssl). 릴리스 서버는 동봉 Node 로 띄워 설치본의 TLS 스택을 그대로 쓴다.
- 기기가 없으므로 download 뒤 "기기 없음" blocked(2) 로 끝나는 것이 정상이다. 증거는 `헬퍼 APK: … (download)` 줄.
