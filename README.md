# Sinclair

모바일/웹 앱을 위한 에이전트 기반 E2E 검증 플랫폼.

- 자연어 목표를 주면 에이전트가 앱을 조작하고, 검증이 통과한 흐름은 결정적 스크립트로 굳힌다.
- 테스트 사이클(Cycle) 단위로 기기 매트릭스에서 실행하고 결과를 취합해 검증 현황(Verdict)을 관리한다.
- 네트워크 모킹은 EverMock을 fixture로 연동한다.

구조와 작업 방식은 `CLAUDE.md`, 설계는 `specs/`, 결정 배경은 `intent/`와 `docs/adr/`을 본다.

```bash
pnpm install
pnpm check
```
