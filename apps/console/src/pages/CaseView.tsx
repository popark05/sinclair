// 케이스 상세(공유 링크 /console/cycles/:id/cases/:test/:target): 그 타깃의 Run 들(대체된 Run 포함)에서 그 테스트의 시도를 시간 순으로,
// 시도마다 결과·errorCode·소요 시간·스텝(종류·instruction·시간·모델 호출·토큰, 실패·안전망·Incident 표지)·아티팩트 키, 실패면 그 Issue 링크.
import { useState } from 'react';
import { ApiError, type Api, type RunView } from '../api.ts';
import { Badge, Failure, Link, useLoad } from '../components.tsx';
import { ISSUE_CYCLES } from './IssuesPage.tsx';
import { CELL_LABEL, type CellKind, type Tone } from '../labels.ts';
import { cycleHref, href } from '../route.ts';

type Attempt = RunView['attempts'][number] & { runId: string; replaced: boolean; deviceId?: string };

/** act 스텝 instruction(`act "목표" → …`)의 목표 */
export function actGoal(instruction: string): string | undefined {
  const m = /^act ("(?:[^"\\]|\\.)*")/.exec(instruction);
  try { return m ? (JSON.parse(m[1]!) as string) : undefined; } catch { return undefined; }
}
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
    // 대기 Run(이벤트가 아직 없음 — 막 등록된 대체 Run 등)은 묻지 않고, 그 사이 404 가 나도 그 Run 만 뺀다(공유 링크가 통째로 실패하지 않게)
    const targetRuns = cycle.runs.filter((r) => r.targetId === targetId && r.state !== 'queued');
    const views = (await Promise.all(targetRuns.map((r) => api.run(r.runId).then((v) => ({ v, replaced: !!r.replacedBy }), (err: unknown) => {
      if (err instanceof ApiError && err.status === 404) return undefined;
      throw err;
    })))).filter((x) => x !== undefined);
    const attempts: Attempt[] = views.flatMap(({ v, replaced }) => v.attempts.filter((a) => a.testId === testId).map((a) => ({ ...a, runId: v.runId, replaced, ...(v.deviceId ? { deviceId: v.deviceId } : {}) })));
    attempts.sort((a, b) => (a.startedAt ?? '').localeCompare(b.startedAt ?? '') || (a.attemptNo ?? 0) - (b.attemptNo ?? 0));
    const cell = cycle.matrix[testId]?.[targetId];
    return { cycle, attempts, kind: (cell?.verdict ?? 'pending') as CellKind };
  }, [api, cycleId, testId, targetId]);
  // 시도 → Issue id: 서명 규칙은 서버(issueSignature)에만 있으므로 Issue 목록의 발생(runId·attemptId)으로 찾는다. 못 불러오면 링크만 없다
  const issues = useLoad(async () => {
    const byAttempt = new Map<string, string>();
    for (const i of await api.issues(ISSUE_CYCLES)) for (const o of i.occurrences) byAttempt.set(`${o.runId}/${o.attemptId}`, i.id);
    return byAttempt;
  }, [api]);
  if (load.state === 'loading') return <p className="muted">불러오는 중…</p>;
  if (load.state === 'error') return <Failure message={load.message} />;
  const { cycle, attempts, kind } = load.data;
  const issueOf = (a: Attempt): string | undefined => (issues.state === 'ok' ? issues.data.get(`${a.runId}/${a.attemptId}`) : undefined);
  return (
    <>
      <header aria-label="케이스" className="cycle-head">
        <p className="muted"><Link to={cycleHref(cycleId)}>{cycle.build}</Link> · {cycleId}</p>
        <h1>{testId}</h1> <span className="muted">{targetId}</span> <span className={`cell cell-${kind} chip`}>{CELL_LABEL[kind]}</span>
        {' '}<Link to={`${href('/tests')}?testId=${encodeURIComponent(testId)}`}>이 테스트의 이력</Link>
        <OpenInStudio api={api} attempts={attempts} cycleId={cycleId} testId={testId} targetId={targetId} />
      </header>
      {attempts.length === 0 ? <p className="muted">이 케이스의 시도가 아직 없음</p> : attempts.map((a) => <AttemptPanel key={`${a.runId}/${a.attemptId}`} a={a} api={api} issueId={issueOf(a)} />)}
    </>
  );
}

function AttemptPanel({ a, api, issueId }: { a: Attempt; api: Api; issueId?: string | undefined }) {
  const [label, tone] = a.result ? RESULT[a.result] ?? [a.result, 'neutral' as Tone] : ['진행 중', 'info' as Tone];
  return (
    <section aria-label={`시도 ${a.attemptNo ?? '?'} (${a.runId}${a.replaced ? ', 대체됨' : ''})`} className={`attempt ${a.replaced ? 'replaced-attempt' : ''}`}>
      <h2>시도 {a.attemptNo ?? '?'} <Badge tone={tone}>{label}</Badge>{a.errorCode ? <code className="code"> {a.errorCode}</code> : null} <span className="muted">{seconds(a.startedAt, a.finishedAt)} · {a.runId}{a.replaced ? ' (대체된 Run)' : ''}</span>
        {issueId ? <> <Link to={`${href('/issues')}#${issueId}`}>같은 원인의 Issue</Link></> : null}</h2>
      {a.steps.length ? (
        <table className="table steps">
          <thead><tr><th>#</th><th>종류</th><th>지시</th><th>시간</th><th>모델</th><th>토큰 입력 / 출력 / 캐시 읽기</th></tr></thead>
          <tbody>{a.steps.map((s) => <StepRow key={s.stepIndex} s={s} />)}</tbody>
        </table>
      ) : <p className="muted">스텝 없음</p>}
      {a.artifacts.length ? (
        <ul aria-label="아티팩트" className="artifacts">
          {a.artifacts.map((x) => {
            const src = api.artifactUrl(a.runId, x.key);
            // 스크린샷은 그림으로(업로드되지 않았으면 깨진 그림 대신 키만 남는다), 나머지(화면 트리 등)는 새 탭 링크
            return (
              <li key={x.key}>
                <span className="muted">{x.kind}</span>{' '}
                {x.kind === 'screenshot'
                  ? <><code>{x.key}</code><br /><a href={src} target="_blank" rel="noreferrer"><img src={src} alt={`시도 ${a.attemptNo ?? '?'} 의 마지막 화면`} className="shot" loading="lazy" onError={(e) => { e.currentTarget.style.display = 'none'; }} /></a></>
                  : <a href={src} target="_blank" rel="noreferrer">{x.key}</a>}
              </li>
            );
          })}
        </ul>
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
        {s.cache === 'replayed' ? <span className="mark mark-replayed">녹화 재생</span> : s.cache === 'handed-off' ? <span className="mark mark-handed-off">녹화 이어받음</span> : null}
      </td>
      <td>{(s.durationMs / 1000).toFixed(1)}초</td>
      <td>{s.modelCalls || ''}</td>
      <td className="mono">{s.usage ? `${n(s.usage.inputTokens)} / ${n(s.usage.outputTokens)} / ${n(s.usage.cacheReadTokens)}` : ''}</td>
    </tr>
  );
}

/** Studio 에서 열기(studio-console 05): 마지막 시도의 기기와 act 목표로 control-plane 에 열기 요청 — 그 기기가 연결된 Studio 가 기기를 고르고 목표를 채운다(실행은 사람이) */
function OpenInStudio({ api, attempts, cycleId, testId, targetId }: { api: Api; attempts: Attempt[]; cycleId: string; testId: string; targetId: string }) {
  const [note, setNote] = useState('');
  const last = [...attempts].reverse().find((a) => a.deviceId);
  if (!last?.deviceId) return null;
  const goal = [...attempts].reverse().flatMap((a) => a.steps.filter((s) => s.kind === 'act').map((s) => actGoal(s.instruction ?? ''))).find((g) => g);
  const send = async (): Promise<void> => {
    try {
      await api.openInStudio({ deviceId: last.deviceId!, ...(goal ? { goal } : {}), from: { cycleId, testId, targetId } });
      setNote(`Studio 에 보냄 — 기기 …${last.deviceId!.slice(-4)} 가 연결된 Studio 에서 열린다(10분 안)`);
    } catch (err) { setNote(`보내지 못함: ${err instanceof Error ? err.message : String(err)}`); }
  };
  return <> <button type="button" className="button" onClick={() => void send()}>Studio 에서 열기</button>{note ? <span className="muted"> {note}</span> : null}</>;
}
