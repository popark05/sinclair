# evals/

에이전트 설정(CLAUDE.md, 스킬, hooks)이 바뀔 때 회귀를 잡기 위한 실제 작업 모음. 각 eval은 작업 설명과 통과 기준을 가진다. 운영 중 발생한 사고마다 하나씩 추가한다.

형식 예: `evals/0001-add-ipc-channel.json`
```json
{ "task": "...", "pass": ["모든 테스트 통과", "specs/와 일치"] }
```
