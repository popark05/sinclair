// Cycle 화면: 머리(빌드·상태·Verdict·경고), 테스트 × 타깃 매트릭스, Run 행. 끝나지 않은 Cycle 은 주기적으로 새로 고친다.
import type { Api, CycleViewWithWarnings } from '../api.ts';
import { Badge, Failure, Link, Stale, usePolling } from '../components.tsx';
import { CELL_LABEL, CELL_ORDER, RUN_STATE_LABEL, CYCLE_STATE_LABEL, CYCLE_VERDICT_LABEL, STATE_TONE, VERDICT_TONE, maskDevice, type CellKind } from '../labels.ts';
import { caseHref } from '../route.ts';
import { UsageSection } from './UsageSection.tsx';

/** 새로 고침 간격: 테스트 하나가 보통 수 초~수십 초라 5초면 진행이 바로 보이고, Cycle 조회(이벤트 투영)를 서버에 과하게 걸지 않는다 */
export const REFRESH_MS = 5_000;
const DONE = new Set(['finished', 'expired', 'cancelled']);

export function CycleView({ api, cycleId }: { api: Api; cycleId: string }) {
  const load = usePolling(() => api.cycle(cycleId), [api, cycleId], REFRESH_MS, (v) => !DONE.has(v.state));
  if (load.state === 'loading') return <p className="muted">불러오는 중…</p>;
  if (load.state === 'error') return <Failure message={load.message} />;
  const v = load.data;
  return (
    <>
      <Stale message={load.stale} />
      <header aria-label="Cycle" className="cycle-head">
        <h1>{v.build}</h1>
        <Badge tone={STATE_TONE[v.state]}>{CYCLE_STATE_LABEL[v.state]}</Badge>{' '}
        <Badge tone={VERDICT_TONE[v.verdict]}>{CYCLE_VERDICT_LABEL[v.verdict]}</Badge>
        <span className="muted"> · {v.cycleId}{v.requiredTags.length ? ` · 필수 태그 ${v.requiredTags.map((t) => `@${t}`).join(' ')}` : ''}</span>
      </header>
      {v.warnings?.length ? <ul aria-label="경고" className="warnings">{v.warnings.map((w) => <li key={w}>{w}</li>)}</ul> : null}
      <Matrix v={v} />
      <UsageSection api={api} cycleId={v.cycleId} live={!DONE.has(v.state)} />
      <Runs v={v} />
    </>
  );
}

function Matrix({ v }: { v: CycleViewWithWarnings }) {
  const tests = Object.keys(v.matrix);
  const required = new Set(v.required);
  return (
    <section>
      <h2>매트릭스</h2>
      {tests.length === 0 ? <p className="muted">아직 케이스 결과가 없음</p> : (
        <table className="table matrix" aria-label="매트릭스">
          <thead><tr><th>테스트</th>{v.targets.map((t) => <th key={t}>{t}</th>)}</tr></thead>
          <tbody>
            {tests.map((test) => (
              <tr key={test}>
                <th scope="row" className="test-name">{test}{required.has(test) ? <span className="req" title="verified 판정에 들어가는 케이스"> 필수</span> : null}</th>
                {v.targets.map((target) => {
                  const cell = v.matrix[test]?.[target];
                  const kind: CellKind = cell?.verdict ?? 'pending';
                  return (
                    <td key={target} className={`cell cell-${kind}`}>
                      {cell ? <Link to={caseHref(v.cycleId, test, target)}>{CELL_LABEL[kind]}</Link> : CELL_LABEL[kind]}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <ul aria-label="범례" className="legend">{CELL_ORDER.map((k) => <li key={k} className={`cell cell-${k}`}>{CELL_LABEL[k]}</li>)}</ul>
    </section>
  );
}

function Runs({ v }: { v: CycleViewWithWarnings }) {
  const used = Object.entries(v.retriesUsed).filter(([, n]) => n > 0);
  return (
    <section>
      <h2>Run</h2>
      {used.length ? <p className="muted">버려진 Run 대체: {used.map(([t, n]) => `대체 ${t} ${n}/${v.retryLimit}`).join(', ')}</p> : null}
      {v.runs.some((r) => r.replaceReason === 'cancelled') ? <p className="muted">취소(노드 종료·lease 상실)로 끝난 Run 은 재시도 한도를 쓰지 않고 다시 등록된다.</p> : null}
      <table className="table" aria-label="Run">
        <thead><tr><th>타깃</th><th>상태</th><th>기기</th><th>노드</th><th>대체</th><th>Run</th></tr></thead>
        <tbody>
          {v.runs.map((r) => (
            <tr key={r.runId} className={r.replacedBy ? 'replaced' : ''}>
              <td>{r.targetId}</td>
              <td>{RUN_STATE_LABEL[r.state]}</td>
              <td>{maskDevice(r.lease?.deviceId ?? r.deviceId)}</td>
              <td>{r.lease?.agentId ?? r.agentId ?? '—'}</td>
              <td>
                {r.replaces ? (r.replaceReason === 'cancelled' ? `${r.replaces} 가 취소돼 다시 등록` : `${r.replaces} 을 대체`) : ''}
                {r.replacedBy ? `${r.replacedBy} 로 대체됨${r.abandonedAt ? ` (버려짐 ${new Date(r.abandonedAt).toLocaleTimeString('ko-KR')})` : ''}` : ''}
              </td>
              <td className="muted mono">{r.runId}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
