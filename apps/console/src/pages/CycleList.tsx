// Cycle 목록: 최신순 Cycle 의 빌드·상태·Verdict·진행률. 행을 누르면 그 Cycle 화면.
import type { Api } from '../api.ts';
import { Badge, Failure, Link, useLoad } from '../components.tsx';
import { CYCLE_STATE_LABEL, CYCLE_VERDICT_LABEL, STATE_TONE, VERDICT_TONE } from '../labels.ts';
import { href } from '../route.ts';

const when = (iso: string): string => new Date(iso).toLocaleString('ko-KR', { dateStyle: 'short', timeStyle: 'short' });

export function CycleList({ api }: { api: Api }) {
  const load = useLoad(() => api.cycleSummaries(50), [api]);
  if (load.state === 'loading') return <p className="muted">불러오는 중…</p>;
  if (load.state === 'error') return <Failure message={load.message} />;
  if (load.data.length === 0) return <p className="muted">아직 Cycle 이 없음 — <code>POST /cycles</code> 로 만든다</p>;
  return (
    <table className="table">
      <thead><tr><th>빌드</th><th>상태</th><th>Verdict</th><th>진행</th><th>타깃</th><th>만든 시각</th></tr></thead>
      <tbody>
        {load.data.map((c) => (
          <tr key={c.cycleId}>
            <td><Link to={href(`/cycles/${encodeURIComponent(c.cycleId)}`)}>{c.build}</Link></td>
            <td><Badge tone={STATE_TONE[c.state]}>{CYCLE_STATE_LABEL[c.state]}</Badge></td>
            <td><Badge tone={VERDICT_TONE[c.verdict]}>{CYCLE_VERDICT_LABEL[c.verdict]}</Badge></td>
            <td><span className="progress" title="끝난 Run / 전체(대체된 Run 제외)">{c.runs.finished}/{c.runs.total}</span></td>
            <td>{c.targets.join(', ')}</td>
            <td className="muted">{when(c.createdAt)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
