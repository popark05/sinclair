# 06: Console — 녹화 캐시 적중

**What to build:** Cycle 사용량에 act 스텝의 캐시 결정 집계(재생·이어받음·live)와 재생으로 아낀 모델 호출 추정을 더하고, Console 모델 사용 절과 케이스 상세 스텝에 표시.

**Blocked by:** 02

**Status:** done

## Comments

- 2026-11-14 구현. control-plane `cycleUsage.recording {replayed, handedOff, live, replayRate}`(act 스텝의 cache 결정 — 캐시를 끈 실행의 스텝은 결정이 없어 세지 않음, 대체된 Run 포함). Console 모델 사용 절에 녹화 캐시 카드(재생·이어받음·라이브·재생률) — 모두 재생돼 모델 호출이 0 이어도 절을 보임. 케이스 상세 act 스텝에 `녹화 재생`·`녹화 이어받음` 표지.
- 아낀 모델 호출 추정은 하지 않았다: 재생 스텝이 아끼는 호출 수는 그 녹화를 만든 라이브 실행에 달려 있어(액션 수 + done, 재시도·거부 턴) 근거 없는 숫자가 된다. 필요하면 녹화 항목에 녹화 당시 modelCalls 를 실어 합산하는 후속으로.
