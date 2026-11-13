// agent.act 툴 루프: 매 턴 화면을 관찰해 실행기(모델)에 다음 툴을 묻고, 닫힌 검사를 통과한 호출만 엔진에 실행한다.
// 잘못된 호출(검사 실패)과 엔진 오류는 실행하지 않거나 실패한 채로 다음 턴의 기록에 실어 모델이 고치게 하고, 턴 한도에 센다.
// done 이면 성공, 턴·시간 한도에 닿거나 실행기가 던지면 실패(사유).
import { EngineError, type Engine, type EngineErrorCode, type SemanticNode, type StepUsage, type CacheAction, type CacheTarget } from '@sinclair/protocol';
import { ACTIONS, checkToolCall, toolSchemas, type ActionSpec } from './action-spec.ts';
import { ModelConfigError, ModelCallError, type AgentTurn, type StepExecutor, type StepReply } from './executor.ts';
import { renderObservation } from './observe.ts';
import { actionSummary, endAnchors, targetLeaks, toCacheTarget } from './recording.ts';
import { addUsage } from './usage.ts';
import { SecretBox } from './secrets.ts';
import { describeTarget, relocate } from './relocate.ts';
import { regionDiff, COVER_DIFF_THRESHOLD } from './pixels.ts';
import { screenChange } from './ledger.ts';
import { DEFAULT_PII, type PiiFilter } from './pii.ts';
import { appPackageOf, detectIncident, type IncidentKind, type IncidentPolicy, type IncidentRecovery } from './incidents.ts';

/** 기본 턴 한도: 로그인·화면 이동 같은 목표는 대개 10턴 안에 끝난다. 20 이면 헤매는 모델을 멈추면서 정상 목표는 넉넉하다 */
export const DEFAULT_MAX_TURNS = 20;
/** 기본 시간 한도: 모델 호출 한 번이 수 초라 20턴 × ~5초 ≈ 100초에 여유를 둔다 */
export const DEFAULT_ACT_TIMEOUT_MS = 120_000;

/** 모델이 고칠 수 있는 엔진 오류: 다음 턴에 알려 다른 대상·행동을 고르게 한다. 그 밖(기기 없음·기기 오류 등)은 인프라 문제라 act 를 그 코드로 끝낸다 —
 *  턴을 태우다 agent 실패로 뭉개지 않게(Verdict 에서 blocked 로 보여야 한다) */
const CORRECTABLE: ReadonlySet<EngineErrorCode> = new Set(['not-found', 'not-actionable', 'unsupported-action', 'ambiguous']);
/** Incident 종류별 결정적 복구 상한(act 하나): 권한 요청은 카메라·마이크처럼 연달아 뜰 수 있어 3, 그 밖은 두 번 해도 안 되면 다른 원인이라 2 */
const INCIDENT_LIMIT: Record<Exclude<IncidentKind, 'action-failed'>, number> = { permission: 3, 'app-error': 2, 'left-app': 2, keyboard: 2 };
/** 같은 호출의 연속 실패: 이만큼이면 모델에게 알리고, 한 번 더면 act 를 멈춘다. 거부된 턴(실행 안 함)은 끊지 않는다 */
const SAME_CALL_FAILS_NOTE = 2;
/** 모델에 돌려줄 오류 문구 상한 */
const MAX_DETAIL = 300;

/** 오류 문구에서 이번 호출이 입력한 글자를 지운다: 실기기 셸 오류는 입력 명령(글자 포함)을 그대로 싣는다 — 비밀값이 모델에 되돌아가지 않게 */
function scrubDetail(detail: string, input: Record<string, string>, hide: (t: string) => string = (t) => t): string {
  let out = hide(detail); // 자르기 전에 가린다(경계에 걸친 값의 반쪽이 남지 않게)
  if (input.text) out = out.split(input.text).join('<입력값>');
  return out.length > MAX_DETAIL ? `${out.slice(0, MAX_DETAIL)}…` : out;
}

function findRef(node: SemanticNode, ref: string): SemanticNode | undefined {
  if (node.ref === ref) return node;
  for (const c of node.children ?? []) { const f = findRef(c, ref); if (f) return f; }
  return undefined;
}

/** promise 와 abort 의 경주. 이미 abort 됐으면 바로 거부하고, 끝나면 리스너를 뗀다(턴마다 쌓이지 않게) */
export function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason as Error);
  let onAbort!: () => void;
  const aborted = new Promise<never>((_, reject) => { onAbort = () => reject(signal.reason as Error); signal.addEventListener('abort', onAbort, { once: true }); });
  return Promise.race([promise, aborted]).finally(() => signal.removeEventListener('abort', onAbort));
}

export interface ActOptions {
  executor: StepExecutor; maxTurns?: number; timeoutMs?: number;
  /** Incident 결정적 복구 정책(권한 요청에 누를 버튼 등) */
  incidents?: IncidentPolicy;
  /** 액션 전 안전망 설정. 대상 재탐색은 늘 켜져 있고, pixels 를 켜면 엔진이 픽셀을 줄 때 대상 영역의 변화(트리에 없는 덮개)도 본다(기본 꺼짐) */
  safetyNet?: { pixels?: boolean };
  /** 화면 개인정보 가림(기본 켜짐: 패턴만). false 면 끔 */
  pii?: PiiFilter | false;
  /** 이 테스트가 등록한 비밀값. type 의 text 에 온 자리표시만 실제 값으로 바뀌고, 모델에 가는 관찰·오류 문구에서 값은 가려진다. 있으면 픽셀은 보내지 않는다 */
  secrets?: SecretBox;
}
export interface ActResult {
  ok: boolean;
  turns: number;
  /** 실행기(모델)에 물은 횟수 */
  modelCalls: number;
  /** 모델 토큰 사용량 합. 사용량을 보고하지 않는 실행기(대본)면 없다 */
  usage?: StepUsage;
  /** 성공 시 모델이 done 에 쓴 근거 */
  summary?: string;
  /** 실패 사유 */
  reason?: string;
  history: AgentTurn[];
  /** 결정적으로 복구한 Incident(종류·복구 동작·횟수) */
  incidents?: Array<{ kind: IncidentKind; action: string; count: number }>;
  /** 녹화(recording-cache): 성공했고 기술자가 가림에 걸리지 않았을 때만. 실행한 툴 호출(대상 기술자·자리표시 글자)과 끝 anchor */
  recording?: { actions: CacheAction[]; end: { anchors: CacheTarget[] } };
  /** act 시작 화면의 foreground 앱(녹화 키·재생 전제) */
  startApp?: string;
}

/** 에이전트 스텝(act·판정 동사)이 던질 때 그때까지 쓴 모델 호출 수·토큰. 오류 객체를 바꾸지 않고 옆에 둔다(러너가 실패 스텝에 싣는다) */
export interface ActProgress { modelCalls: number; usage?: StepUsage }
const progress = new WeakMap<object, ActProgress>();
export function recordProgress(err: unknown, p: ActProgress): void {
  if (typeof err === 'object' && err !== null) progress.set(err, p);
}
export function actProgressOf(err: unknown): ActProgress | undefined {
  return typeof err === 'object' && err !== null ? progress.get(err) : undefined;
}

/** 모델이 고칠 수 없는 엔진 오류(기기 없음 등)와 관찰 실패는 EngineError 로 던진다 — 결과로 돌려주지 않는다. 던진 오류의 진행은 actProgressOf 로 읽는다 */
export async function runAct(engine: Engine, goal: string, opts: ActOptions): Promise<ActResult> {
  const maxTurns = opts.maxTurns ?? DEFAULT_MAX_TURNS;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_ACT_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  const aborter = new AbortController();
  const timer = setTimeout(() => aborter.abort(new Error(`시간 한도 ${timeoutMs}ms`)), timeoutMs);
  timer.unref?.();
  const history: AgentTurn[] = [];
  let modelCalls = 0;
  let usage: StepUsage | undefined;
  const secrets = opts.secrets;
  const pii = opts.pii === false ? undefined : opts.pii ?? DEFAULT_PII;
  // 모델에 가는 글: 비밀값(값 일치) 다음 개인정보(모양·목록)
  const hide = (t: string): string => { const a = secrets ? secrets.redact(t) : t; return pii ? pii.redact(a) : a; };
  const hideTree = (root: SemanticNode): SemanticNode => { const a = secrets ? secrets.redactTree(root) : root; return pii ? pii.redactTree(a) : a; };
  // Incident: 종류별 결정적 복구 시도 수, 복구 기록, 모델에게 알린 상황, 같은 호출의 연속 실패
  const recovered = new Map<string, { kind: IncidentKind; action: string; count: number }>();
  const attempts = new Map<IncidentKind, number>();
  const informed = new Set<string>();
  let appPackage: string | undefined;
  let note: string | undefined;
  const addNote = (n: string): void => { note = note ? `${note}\n${n}` : n; };
  let lastFailedCall: string | undefined;
  let prevShown: SemanticNode | undefined;
  let failedInRow = 0;
  // 녹화: 실행에 성공한 툴 호출. 기술자가 가림에 걸리면 이 act 의 녹화는 버린다
  const recorded: CacheAction[] = [];
  let recordable = true;
  let startRoot: SemanticNode | undefined;
  const record = (kind: IncidentKind, rawAction: string, countAttempt = true): void => {
    const action = hide(rawAction);
    if (countAttempt) attempts.set(kind, (attempts.get(kind) ?? 0) + 1);
    const key = `${kind}|${action}`;
    const r = recovered.get(key);
    if (r) r.count++; else recovered.set(key, { kind, action, count: 1 });
  };
  const result = (r: Pick<ActResult, 'ok' | 'summary' | 'reason' | 'recording'>): ActResult => ({ ...r, turns: history.length, modelCalls, ...(usage ? { usage } : {}), history, ...(recovered.size ? { incidents: [...recovered.values()] } : {}), ...(appPackage ? { startApp: appPackage } : {}) });
  const goalSecrets = new Set(SecretBox.mentioned(goal));
    const fail = (reason: string): ActResult => result({ ok: false, reason: hide(reason) });
  // 픽셀은 가릴 수 없다: 비밀값이 있는 테스트에서는 이미지를 보내지 않는다
  const pixels = opts.executor.pixels === true && !(secrets && secrets.size > 0);
  // 안전망의 픽셀 비교는 모델에 보내지 않고 로컬에서만 쓰므로 비밀값과 무관하다
  const guardPixels = opts.safetyNet?.pixels === true;
  const observeNow = (withPixels: boolean) => raceAbort(engine.observe(withPixels ? { pixels: true } : undefined), aborter.signal);
  /** 결정적 복구 하나. 엔진이 못 하면(session 없음) false. 고칠 수 있는 엔진 오류는 시도로 세고 넘어간다(다음 관찰이 다시 판단) */
  const recover = async (r: IncidentRecovery): Promise<string | undefined> => {
    try {
      if (r.kind === 'tap') { await raceAbort(engine.perform(r.ref, 'tap'), aborter.signal); return r.label; }
      // 다시 열기는 act 시작 때의 앱으로(대상 없이 열면 엔진의 기본 앱이나 홈으로 간다). 시작 앱을 모르면 결정적으로 하지 않는다
      if (r.kind === 'tap-then-reopen') { if (!engine.session || !appPackage) return undefined; await raceAbort(engine.perform(r.ref, 'tap'), aborter.signal); await raceAbort(engine.session.open(appPackage), aborter.signal); return `${r.label} → 다시 열기`; }
      if (r.kind === 'reopen') { if (!engine.session || !appPackage) return undefined; await raceAbort(engine.session.open(appPackage), aborter.signal); return '다시 열기'; }
      if (!engine.keyboard) return undefined;
      await raceAbort(engine.keyboard.dismiss(), aborter.signal);
      return '키보드 내림';
    } catch (err) {
      if (aborter.signal.aborted || (err instanceof EngineError && !CORRECTABLE.has(err.code))) throw err;
      return r.kind === 'tap' || r.kind === 'tap-then-reopen' ? `${r.label}(실패)` : '복구 실패';
    }
  };
  try {
    for (let turn = 0; turn < maxTurns; turn++) {
      if (Date.now() >= deadline) return fail(`시간 한도 ${timeoutMs}ms 에 닿음`);
      let observed;
      try { observed = await raceAbort(engine.observe(pixels || guardPixels ? { pixels: true } : undefined), aborter.signal); } catch (err) {
        if (aborter.signal.aborted) return fail(`시간 한도 ${timeoutMs}ms 에 닿음`);
        throw err;
      }
      // Incident: 모델에 묻기 전에 끼어든 화면을 알아보고 결정적 복구를 먼저 한다(모델 호출·턴 없음)
      if (turn === 0) appPackage = appPackageOf(observed.root);
      const incidentCtx = () => ({ ...(appPackage ? { appPackage } : {}), ...(opts.incidents ? { policy: opts.incidents } : {}) });
      let lastRecovered: string | undefined;
      let sameAfterRecovery = 0;
      let recoveredThisTurn = false;
      for (;;) {
        if (aborter.signal.aborted) return fail(`시간 한도 ${timeoutMs}ms 에 닿음`);
        const inc = detectIncident(observed.root, incidentCtx());
        if (!inc) break;
        // 다른 앱으로의 이동(결정적 복구 없음)은 목표의 일부일 수 있다: 한 번 알리고, 그 앱에 머무는 동안 다시 알리거나 실패시키지 않는다
        if (inc.kind === 'left-app' && !inc.recovery) {
          if (!informed.has(inc.signature)) { informed.add(inc.signature); addNote(`Incident: ${inc.summary}`); record(inc.kind, '모델에 알림', false); }
          break;
        }
        // 모델에게 이미 알렸는데도 그대로면 복구하지 못한 것이다
        if (informed.has(inc.signature)) return fail(`Incident 를 복구하지 못함: ${inc.summary}`);
        sameAfterRecovery = inc.signature === lastRecovered ? sameAfterRecovery + 1 : 0;
        const used = attempts.get(inc.kind) ?? 0;
        const why = !inc.recovery ? '' : used >= INCIDENT_LIMIT[inc.kind as keyof typeof INCIDENT_LIMIT] ? ` (자동 복구 ${used}번으로 상한)` : sameAfterRecovery >= 2 ? ' (자동 복구가 통하지 않음)' : undefined;
        const action = why === undefined && inc.recovery ? await recover(inc.recovery) : undefined;
        if (action === undefined) {
          // 결정적 복구가 없거나 상한·무효: 모델에게 한 번 알리고 묻는다
          informed.add(inc.signature);
          addNote(`Incident: ${inc.summary}${why ?? ''} — 이 상황을 먼저 해결하라`);
          record(inc.kind, '모델에 알림', false);
          break;
        }
        record(inc.kind, action);
        recoveredThisTurn = true;
        lastRecovered = inc.signature;
        try { observed = await observeNow(pixels || guardPixels); } catch (err) {
          if (aborter.signal.aborted) return fail(`시간 한도 ${timeoutMs}ms 에 닿음`);
          throw err;
        }
      }
      if (!startRoot) startRoot = observed.root;
      // 트리의 문자열 잎을 가린 뒤 그린다(그린 글에 가리면 JSON 이스케이프된 값을 놓친다)
      const shown = hideTree(observed.root);
      // Ledger: 앞 턴이 실행한 뒤 화면이 바뀐 부분을 그 턴의 기록에 붙인다(이전 관찰을 통째로 싣는 대신)
      const prevTurn = history.at(-1);
      if (prevShown && prevTurn?.call && prevTurn.result !== 'rejected' && !prevTurn.change) {
        // 실행한 턴에는 늘 붙인다('없음' 도 — 계산하지 않은 것과 구별). 그 사이 Incident 복구가 있었으면 복구 뒤 화면이라고 밝힌다(모델이 자기 탭의 결과로 오해하지 않게)
        const change = screenChange(prevShown, shown) ?? '없음';
        prevTurn.change = recoveredThisTurn ? `Incident 복구 뒤: ${change}` : change;
      }
      prevShown = shown;
      const observation = renderObservation(shown);
      // 관찰하는 사이 한도가 지났으면 묻지 않는다(abort 가 리스너보다 먼저 와서 영영 기다리는 일이 없게 raceAbort 도 같은 검사를 한다)
      if (aborter.signal.aborted) return fail(`시간 한도 ${timeoutMs}ms 에 닿음`);
      let reply: StepReply;
      try {
        modelCalls++;
        // 실행기가 시간 한도를 넘기면 기다리지 않는다. 스키마는 매번 새로(실행기가 고쳐도 다음 턴에 영향 없게)
        const incident = note; note = undefined;
        // 목표는 작성자의 글이라 개인정보 가림을 하지 않는다(작성자가 쓴 이메일·번호를 입력하는 목표가 있다) — 비밀값만
        const request = { goal: secrets ? secrets.redact(goal) : goal, ...(incident ? { incident: hide(incident) } : {}), observation, history: history.map((h) => ({ ...h })), tools: toolSchemas(), ...(pixels && observed.pixels ? { pixels: observed.pixels } : {}) };
        reply = await raceAbort(opts.executor.next(request, aborter.signal), aborter.signal);
      } catch (err) {
        if (err instanceof ModelConfigError) throw err; // 설정 문제는 테스트 실패가 아니다: 러너가 blocked 로 다룬다
        if (err instanceof ModelCallError) usage = addUsage(usage, err.usage);
        if (aborter.signal.aborted) return fail(`시간 한도 ${timeoutMs}ms 에 닿음`);
        const msg = hide(err instanceof Error ? err.message : String(err));
        return fail(`모델 호출 실패: ${msg.length > MAX_DETAIL ? `${msg.slice(0, MAX_DETAIL)}…` : msg}`);
      }
      usage = addUsage(usage, reply.usage);
      const call = reply.call;
      if (!call) {
        const said = reply.text?.trim() ? `: ${reply.text.trim().slice(0, MAX_DETAIL)}` : '';
        history.push({ result: 'rejected', detail: `툴을 부르지 않음 — 한 턴에 툴 하나를 불러야 함${said}` });
        continue;
      }
      const checked = checkToolCall(call);
      if (!checked.ok) { history.push({ call, result: 'rejected', detail: checked.error }); continue; }
      const spec: ActionSpec = ACTIONS[checked.call.name];
      // 자리표시는 type 의 text 에서만 실제 값으로 바뀐다. 다른 툴·필드(ref, summary…)에 쓰면 값이 엉뚱한 곳(탭 대상·기록)으로 새므로 거부
      const input = { ...checked.call.input };
      const misplaced = Object.entries(input).find(([k, v]) => !(checked.call.name === 'type' && k === 'text') && /\{\{secret:/.test(v));
      if (misplaced) { history.push({ call, result: 'rejected', detail: `비밀값 자리표시는 type 의 text 에만 쓸 수 있음(${checked.call.name}.${misplaced[0]})` }); continue; }
      let typed: string | undefined; // 비밀값을 치환했으면 그 글자(대상 재확인용)
      if (checked.call.name === 'type' && input.text !== undefined && /\{\{secret:/.test(input.text)) {
        // 목표에 주어진 이름만(같은 run 의 다른 테스트가 등록한 값, 화면에 심긴 자리표시로 값을 꺼내지 못하게), 입력 칸에만
        const revealed = secrets ? secrets.reveal(input.text, goalSecrets) : { ok: false as const, error: '이 테스트에는 비밀값이 없음' };
        if (!revealed.ok) { history.push({ call, result: 'rejected', detail: revealed.error }); continue; }
        const target = findRef(observed.root, input.ref ?? '');
        if (target && !(target.role === 'textbox' || target.states?.secure)) { history.push({ call, result: 'rejected', detail: `비밀값은 입력 칸(textbox)에만 넣을 수 있음: ${input.ref} 는 ${target.role}` }); continue; }
        input.text = revealed.text;
        typed = revealed.text;
      }
      // 액션 전 안전망: 모델이 본 화면에서 대상의 설명을 만들고, 실행 직전 화면에서 같은 대상을 다시 찾는다
      let retargeted: string | undefined;
      const target = input.ref !== undefined ? describeTarget(observed.root, input.ref) : undefined;
      // 모델이 본 화면에 없는 ref(지어냈거나 옛 화면의 것)는 실행하지 않는다: 엔진이 옛 관찰의 기억으로 엉뚱한 노드를 고를 수 있다
      if (input.ref !== undefined && !target) { history.push({ call, result: 'rejected', detail: `${hide(input.ref)} 는 지금 화면에 없는 ref — 지금 화면의 @ref 로 다시 골라라` }); continue; }
      if (target) {
        let fresh;
        try { fresh = await raceAbort(engine.observe(guardPixels ? { pixels: true } : undefined), aborter.signal); } catch (err) {
          if (aborter.signal.aborted) return fail(`시간 한도 ${timeoutMs}ms 에 닿음`);
          throw err;
        }
        // 모델이 고른 뒤 실행 전에 끼어든 창(권한 요청·앱 오류): 그 창을 누르지 않게 실행하지 않고, 다음 턴의 관찰이 복구한다
        // 모델이 본 화면에 이미 있던 창(모델에게 알려 직접 다루게 한 것)은 끼어든 것이 아니다
        const intruder = detectIncident(fresh.root, incidentCtx());
        if (intruder && intruder.recovery && intruder.signature !== detectIncident(observed.root, incidentCtx())?.signature) { history.push({ call, result: 'rejected', detail: `실행 직전에 끼어든 창: ${hide(intruder.summary)}. 실행하지 않았다 — 다음 화면에서 다시 골라라` }); continue; }
        const where = relocate(target, fresh.root);
        const what = hide(`${target.ref} (${target.role}${target.label ? ` "${target.label}"` : ''})`);
        if (where.kind === 'gone' || where.kind === 'ambiguous') {
          const why = where.kind === 'gone' ? '사라짐' : `애매함 — 후보 ${where.candidates.slice(0, 5).join(', ')}`;
          history.push({ call, result: 'rejected', guard: where.kind, detail: `안전망: 실행 직전 화면에서 대상 ${what} 이 ${why}. 실행하지 않았다 — 지금 화면에서 다시 골라라` });
          continue;
        }
        if (guardPixels && observed.pixels && fresh.pixels) {
          // 옛 자리의 옛 그림과 새 자리의 새 그림을 비교한다(옮겨 간 대상을 덮였다고 보지 않게)
          const area = findRef(fresh.root, where.ref)?.rect;
          const diff = area && target.rect ? regionDiff(observed.pixels, fresh.pixels, target.rect, area) : undefined;
          if (diff !== undefined && diff > COVER_DIFF_THRESHOLD) {
            history.push({ call, result: 'rejected', guard: 'covered', detail: `안전망: 대상 ${what} 영역의 화면이 바뀜(트리에 없는 덮개·팝업일 수 있음). 실행하지 않았다 — 지금 화면에서 다시 골라라` });
            continue;
          }
        }
        // 비밀값을 넣는 대상은 실행 직전 화면에서도 입력 칸이어야 한다(옮겨 간 대상의 상태를 다시 본다)
        const now = findRef(fresh.root, where.ref);
        if (typed !== undefined && now && !(now.role === 'textbox' || now.states?.secure)) { history.push({ call, result: 'rejected', detail: `비밀값은 입력 칸(textbox)에만 넣을 수 있음: ${where.ref} 는 ${now.role}` }); continue; }
        if (where.kind === 'moved') { input.ref = where.ref; retargeted = where.ref; }
      }
      const callKey = `${checked.call.name}${input.ref ? ` ${input.ref}` : ''}`;
      try {
        try {
          await spec.run(engine, input);
        } catch (err) {
          // keyboard Incident: 입력 바로 뒤의 탭·스크롤이 실패하면 키보드가 가렸을 수 있다 — 내리고 같은 호출을 한 번 다시 한다
          // 근거가 있어야 한다: 엔진이 키보드가 떠 있다고 말하고(shown — 모르면 하지 않는다. 모바일의 dismiss 는 뒤로 버튼이라 키보드가 없으면 화면을 떠난다),
          // 대상이 비활성이 아니어야 한다(비활성 버튼은 키보드 탓이 아니다)
          const prev = history.at(-1);
          const keyboardSuspect = err instanceof EngineError && (err.code === 'not-found' || err.code === 'not-actionable') && (checked.call.name === 'tap' || checked.call.name === 'scroll')
            && prev?.result === 'ok' && prev.call?.name === 'type' && !findRef(observed.root, input.ref ?? '')?.states?.disabled
            && (attempts.get('keyboard') ?? 0) < INCIDENT_LIMIT.keyboard && engine.keyboard?.shown !== undefined && await engine.keyboard.shown();
          if (!keyboardSuspect) throw err;
          const action = await recover({ kind: 'dismiss-keyboard' });
          if (action === undefined) throw err;
          record('keyboard', action);
          // 키보드가 내려가면 화면이 다시 배치된다(adjustResize): 같은 대상을 다시 찾아 그 ref 로
          if (target) {
            const after = await raceAbort(engine.observe(), aborter.signal);
            const again = relocate(target, after.root);
            if (again.kind !== 'same' && again.kind !== 'moved') throw err;
            if (again.kind === 'moved') { input.ref = again.ref; retargeted = again.ref; }
          }
          await spec.run(engine, input);
        }
      } catch (err) {
        // 인프라 오류는 모델이 고칠 수 없다: 그 코드 그대로 던져 러너가 blocked 등으로 다루게 한다
        if (err instanceof EngineError && !CORRECTABLE.has(err.code)) throw err;
        const raw = err instanceof EngineError ? `${err.code}: ${err.message}` : err instanceof Error ? err.message : String(err);
        history.push({ call, result: 'error', detail: scrubDetail(raw, input, hide), ...(retargeted ? { retargeted } : {}) });
        // action-failed Incident: 같은 호출이 연달아 실패하면 두 번째에 모델에게 알리고, 세 번째면 멈춘다(같은 실패를 되풀이하는 루프)
        failedInRow = callKey === lastFailedCall ? failedInRow + 1 : 1;
        lastFailedCall = callKey;
        if (failedInRow > SAME_CALL_FAILS_NOTE) return fail(`Incident: 같은 호출(${hide(callKey)})이 세 번 연달아 실패 — 복구하지 못함`);
        if (failedInRow === SAME_CALL_FAILS_NOTE) { addNote(`Incident: 같은 호출(${hide(callKey)})이 두 번 연달아 실패 — 다른 대상이나 방법을 골라라`); record('action-failed', '모델에 알림', false); }
        continue;
      }
      lastFailedCall = undefined; failedInRow = 0;
      history.push({ call, result: 'ok', ...(retargeted ? { retargeted } : {}) });
      if (spec.terminal) {
        const recording = recordable ? { actions: recorded, end: { anchors: endAnchors(startRoot, observed.root, hide) } } : undefined;
        return result({ ok: true, ...(checked.call.input.summary ? { summary: checked.call.input.summary } : {}), ...(recording ? { recording } : {}) });
      }
      if (recordable) {
        const name = checked.call.name as CacheAction['tool'];
        const t = target ? toCacheTarget(target) : undefined;
        if (t && targetLeaks(t, hide)) recordable = false;
        else {
          // 글자는 모델이 쓴 그대로(비밀값은 자리표시) — 값 일치로 다시 가려 혹시 값이 그대로 온 경우도 남기지 않는다
          const text = name === 'type' ? (secrets ? secrets.redact(checked.call.input.text ?? '') : checked.call.input.text ?? '') : undefined;
          const direction = name === 'scroll' ? (checked.call.input.direction as 'up' | 'down') : undefined;
          const a = { tool: name, ...(t ? { target: t } : {}), ...(text !== undefined ? { text } : {}), ...(direction ? { direction } : {}) };
          recorded.push({ ...a, summary: actionSummary(a) });
        }
      }
    }
    return fail(`턴 한도 ${maxTurns} 안에 목표를 이루지 못함`);
  } catch (err) {
    recordProgress(err, { modelCalls, ...(usage ? { usage } : {}) });
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
