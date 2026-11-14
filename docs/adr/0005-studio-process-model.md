# 0005. Studio 는 기기·러너·에이전트를 Electron 밖의 Node 작업 프로세스에서 돌린다

- 상태: 승인
- 날짜: 2026-11-14

## 맥락
Studio(Electron)는 기기 화면·트리를 보고 조작하고, 에이전트(`runAct`, Claude API)와 러너를 직접 돌려야 한다(스텝 디버깅). 그런데:
- 기기는 데몬 하나가 소유해야 한다(ADR 0002). Studio 가 USB 를 직접 잡으면 데몬·EverMock 과 충돌한다.
- Electron 메인에서 node-usb 를 쓰려면 Electron ABI 로 다시 빌드해야 한다(EverMock 의 부담).
- EverMock 에서 Electron 의 BoringSSL 때문에 Node TLS 경로가 깨진 경험이 있다(mockttp upstream `INVALID_COMMAND`). 사내망 CA(`NODE_EXTRA_CA_CERTS`)도 plain Node 경로가 검증돼 있다.

## 결정
- Studio 메인 프로세스는 **plain Node 작업 프로세스**(`studio-worker`, 고정 Node — runner-agent 패키징과 같은 Node)를 하나 띄우고 IPC(구조화 복제 가능한 메시지)로만 대화한다.
- 작업 프로세스가 기기에 닿는 길: 기본은 **디바이스 서버(device-layer JSON-RPC)를 스스로 연다**(데몬이 없을 때 — 개발자 PC). 같은 머신에 데몬이 떠 있으면 데몬의 로컬 디바이스 RPC(토큰)에 붙는다(USB 를 다투지 않는다). 엔진은 그 RPC 위의 engine-mobile.
- 러너·에이전트(`runTests`, `runAct`, 녹화 캐시)도 작업 프로세스에서 돈다. Claude API 호출은 plain Node TLS·CA 경로.
- 렌더러(React + astryx)는 preload 로 노출한 좁은 API 만 쓴다. 화면 갱신은 작업 프로세스가 스냅샷(스크린샷 + 트리 원자)을 푸시.

## 결과
Electron 쪽에는 네이티브 모듈과 TLS 경로가 없다. 작업 프로세스는 runner-agent 의 워커와 같은 코드 경로를 써서 Studio 에서 통과한 테스트가 노드에서도 같은 방식으로 돈다. 대가: IPC 계약(`shared/studio-ipc` 같은 단일 정의)과 프로세스 수명 관리가 생긴다. 데몬 RPC 발견(포트·토큰 파일)은 Studio 티켓에서 정한다.
