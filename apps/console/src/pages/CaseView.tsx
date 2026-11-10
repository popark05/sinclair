// 케이스 상세(공유 링크 /console/cycles/:id/cases/:test/:target): 그 타깃의 Run 들(대체된 Run 포함)에서 그 테스트의 시도를 시간 순으로,
// 시도마다 결과·errorCode·소요 시간·스텝(종류·instruction·시간·모델 호출·토큰, 실패·안전망·Incident 표지)·아티팩트 키.
import type { Api, RunView } from '../api.ts';
import { Badge, Failure, Link, useLoad } from '../components.tsx';
import { CELL_LABEL, type CellKind, type Tone } from '../labels.ts';
import { cycleHref, href } from '../route.ts';

type Attempt = RunView['attempts'][number] & { runId: string; replaced: boolean };
type Step = Attempt['steps'][number];

const RESULT: Record<string, [string, Tone]> = { passed: ['통과', 'good'], failed: ['실패', 'bad'], blocked: ['막힘', 'warn'], skipped: ['건너뜀', 'neutral'] };
const seconds = (a?: string, b?: string): string => (a && b ? `${Math.max(0, Math.round((Date.parse(b) - Date.parse(a)) / 1000))}초` : '—');
const n = (x: number | undefined): string => (x ?? 0).toLocaleString('en-US');
/** 스텝 instruction 의 표지: 러너가 남기는 형식(`(안전망: …)`, `→@x(다시 찾음)`, `[Incident: …]`, `→ 실패`) */
const marks = (text: string) => ({
  guard: (text.match(/\(안전망: /g) ?? []).length,
  retarget: (text.match(/\(다시 찾음\)/g) ?? []).length,
  incident: text.includes('[Incident:'),
  failed: /→ 실패/.test(text),
});

export function CaseView({ api, cycleId, testId, targetId }: { api: Api; cycleId: string; testId: string; targetId: string }) {
  const load = useLoad(async () => {
    const cycle = await api.cycle(cycleId);
    const targetRuns = cycle.runs.filter((r) => r.targetId === targetId);
    const views = await Promise.all(targetRuns.map((r) => api.run(r.runId).then((v) => ({ v, replaced: !!r.replacedBy }))));
    const attempts: Attempt[] = views.flatMap(({ v, replaced }) => v.attempts.filter((a) => a.testId === testId).map((a) => ({ ...a, runId: v.runId, replaced })));
    attempts.sort((a, b) => (a.startedAt ?? '').localeCompare(b.startedAt ?? '') || (a.attemptNo ?? 0) - (b.attemptNo ?? 0));
    const cell = cycle.matrix[testId]?.[targetId];
    return { cycle, attempts, kind: (cell?.verdict ?? 'pending') as CellKind };
  }, [api, cycleId, testId, targetId]);
  if (load.state === 'loading') return <p className="muted">불러오는 중…</p>;
  if (load.state === 'error') return <Failure message={load.message} />;
  const { cycle, attempts, kind } = load.data;
  return (
    <>
      <header aria-label="케이스" className="cycle-head">
        <p className="muted"><Link to={cycleHref(cycleId)}>{cycle.build}</Link> · {cycleId}</p>
        <h1>{testId}</h1> <span className="muted">{targetId}</span> <span className={`cell cell-${kind} chip`}>{CELL_LABEL[kind]}</span>
        {' '}<Link to={`${href('/tests')}?testId=${encodeURIComponent(testId)}`}>이 테스트의 이력</Link>
      </header>
      {attempts.length === 0 ? <p className="muted">이 케이스의 시도가 아직 없음</p> : attempts.map((a) => <AttemptPanel key={`${a.runId}/${a.attemptId}`} a={a} />)}
    </>
  );
}

function AttemptPanel({ a }: { a: Attempt }) {
  const [label, tone] = a.result ? RESULT[a.result] ?? [a.result, 'neutral' as Tone] : ['진행 중', 'info' as Tone];
  return (
    <section aria-label={`시도 ${a.attemptNo ?? '?'} (${a.runId}${a.replaced ? ', 대체됨' : ''})`} className={`attempt ${a.replaced ? 'replaced-attempt' : ''}`}>
      <h2>시도 {a.attemptNo ?? '?'} <Badge tone={tone}>{label}</Badge>{a.errorCode ? <code className="code"> {a.errorCode}</code> : null} <span className="muted">{seconds(a.startedAt, a.finishedAt)} · {a.runId}{a.replaced ? ' (대체된 Run)' : ''}</span></h2>
      {a.steps.length ? (
        <table className="table steps">
          <thead><tr><th>#</th><th>종류</th><th>instruction</th><th>시간</th><th>모델</th><th>토큰 입력 / 출력 / 캐시 읽기</th></tr></thead>
          <tbody>{a.steps.map((s) => <StepRow key={s.stepIndex} s={s} />)}</tbody>
        </table>
      ) : <p className="muted">스텝 없음</p>}
      {a.artifacts.length ? (
        <ul aria-label="아티팩트" className="artifacts">{a.artifacts.map((x) => <li key={x.key}><span className="muted">{x.kind}</span> <code>{x.key}</code></li>)}</ul>
      ) : null}
    </section>
  );
}

function StepRow({ s }: { s: Step }) {
  const m = marks(s.instruction ?? '');
  return (
    <tr className={m.failed ? 'step-failed' : ''}>
      <td className="muted">{s.stepIndex}</td>
      <td><code>{s.kind}</code></td>
      <td className="instruction">
        {s.instruction}
        {m.guard ? <span className="mark mark-guard">안전망 {m.guard}</span> : null}
        {m.retarget ? <span className="mark mark-retarget">다시 찾음 {m.retarget}</span> : null}
        {m.incident ? <span className="mark mark-incident">Incident</span> : null}
      </td>
      <td>{(s.durationMs / 1000).toFixed(1)}초</td>
      <td>{s.modelCalls || ''}</td>
      <td className="mono">{s.usage ? `${n(s.usage.inputTokens)} / ${n(s.usage.outputTokens)} / ${n(s.usage.cacheReadTokens)}` : ''}</td>
    </tr>
  );
}
