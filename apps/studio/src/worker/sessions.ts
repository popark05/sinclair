// 에이전트 세션(studio 05): 고른 기기의 엔진에서 runAct(실제 모델)를 돌리고 턴·끝을 이벤트로 밀어 보낸다. 중지는 AbortSignal, 판정은 judgeAssert.
// 녹화(recording)는 결과에 실어 내보내기(06)가 쓴다 — 저장소에 쓰는 것은 내보낼 때.
import { randomUUID } from 'node:crypto';
import { runAct, judgeAssert, type AgentTurn, type StepExecutor } from '@sinclair/agent';
import type { Engine, SemanticNode } from '@sinclair/protocol';
import { uniqueLocator } from '../shared/locators.ts';
import type { JudgeView, SessionEvent, SessionResult, TurnView } from '../shared/studio-ipc.ts';

export interface SessionAgent { executor: StepExecutor; maxTurns?: number; timeoutMs?: number }
export interface SessionDeps {
  /** 그 기기의 엔진(세션마다 새로 — 엔진은 한 번에 한 호출자) */
  engineFor: (deviceId: string) => Promise<Engine>;
  /** 실행기(모델). 못 만들면 사유로 던진다 */
  agent: () => Promise<SessionAgent>;
  emit: (sessionId: string, event: SessionEvent) => void;
}

const REF = /^@[\w:.-]{1,40}$/;
/** 타임라인 한 줄: 툴 이름과 대상 ref 만(입력 글자는 싣지 않는다 — 비밀값·개인정보일 수 있다) */
export function toTurnView(t: AgentTurn, observed?: SemanticNode): TurnView {
  const ref = (t.call?.input as { ref?: unknown } | undefined)?.ref;
  // 모델이 고른 대상(모델이 본 화면의 ref)이 그 화면에서 정확히 하나로 정해지는 locator. 안전망이 옮겼어도 같은 대상이다
  const locator = t.result === 'ok' && observed && typeof ref === 'string' && REF.test(ref) ? uniqueLocator(observed, ref) : undefined;
  return {
    ...(t.call ? { tool: t.call.name } : {}),
    ...(typeof ref === 'string' && REF.test(ref) ? { target: ref } : {}),
    result: t.result,
    ...(t.detail ? { detail: t.detail.slice(0, 300) } : {}),
    ...(t.guard ? { guard: t.guard } : {}),
    ...(t.retargeted && REF.test(t.retargeted) ? { retargeted: t.retargeted } : {}),
    ...(locator ? { locator } : {}),
  };
}

export function createSessionManager(deps: SessionDeps) {
  const running = new Map<string, AbortController>();
  return {
    /** restartApp: 그 앱을 처음 상태로 다시 띄운 뒤 시작한다 — 내보낸 테스트(app.restart)와 같은 시작 화면이라야 녹화·locator 가 맞는다 */
    async start(deviceId: string, goal: string, opts: { restartApp?: string } = {}): Promise<{ sessionId: string }> {
      const agent = await deps.agent(); // 설정 문제는 시작 전에 드러낸다
      const engine = await deps.engineFor(deviceId);
      const sessionId = randomUUID();
      const ac = new AbortController();
      running.set(sessionId, ac);
      void (async () => {
        let result: SessionResult;
        try {
          if (opts.restartApp) {
            if (!engine.session) throw new Error('처음부터 시작하지 못함: 이 엔진은 앱을 다시 띄울 수 없음');
            await engine.session.restart(opts.restartApp).catch((err: unknown) => { throw new Error(`처음부터 시작하지 못함(${opts.restartApp}): ${err instanceof Error ? err.message : String(err)}`); });
          }
          const r = await runAct(engine, goal, { executor: agent.executor, signal: ac.signal, onTurn: (t, index, observed) => deps.emit(sessionId, { type: 'turn', index, turn: toTurnView(t, observed) }), ...(agent.maxTurns !== undefined ? { maxTurns: agent.maxTurns } : {}), ...(agent.timeoutMs !== undefined ? { timeoutMs: agent.timeoutMs } : {}) });
          result = { ok: r.ok, turns: r.turns, modelCalls: r.modelCalls, ...(r.summary ? { summary: r.summary } : {}), ...(r.reason ? { reason: r.reason } : {}), ...(r.usage ? { inputTokens: r.usage.inputTokens, outputTokens: r.usage.outputTokens } : {}), ...(r.recording ? { recording: r.recording } : {}), ...(r.startApp ? { startApp: r.startApp } : {}), ...(opts.restartApp ? { freshStart: true } : {}) };
        } catch (err) {
          result = { ok: false, reason: err instanceof Error ? err.message : String(err), turns: 0, modelCalls: 0 };
        } finally {
          running.delete(sessionId);
        }
        deps.emit(sessionId, { type: 'done', result });
      })();
      return { sessionId };
    },
    async stop(sessionId: string): Promise<void> {
      running.get(sessionId)?.abort(new Error('중지됨'));
    },
    async assert(deviceId: string, statement: string): Promise<JudgeView> {
      const agent = await deps.agent();
      const r = await judgeAssert(await deps.engineFor(deviceId), statement, { executor: agent.executor });
      return { pass: r.ok, reason: r.reason ?? (r.ok ? '참' : '거짓') };
    },
  };
}
