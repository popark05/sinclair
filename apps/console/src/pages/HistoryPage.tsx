// 안정성 이력(/console/tests): 최근 Cycle 들에서 테스트별 결과를 색 칸 줄(오래된 → 최신)로, flaky 비율 높은 순. 칸은 그 케이스 상세로.
import type { Api } from '../api.ts';
import { Failure, Link, useLoad } from '../components.tsx';
import { CELL_LABEL, CELL_ORDER } from '../labels.ts';
import { caseHref, href } from '../route.ts';

/** 볼 Cycle 수: 20 이면 몇 주의 흐름이 보이고, Cycle 마다 이벤트를 읽는 서버 비용이 묶인다 */
export const HISTORY_LIMIT = 20;
const pct = (r: number | null): string => (r === null ? '—' : `${Math.round(r * 100)}%`);

export function HistoryPage({ api, testId }: { api: Api; testId?: string }) {
  const load = useLoad(() => api.history({ limit: HISTORY_LIMIT, ...(testId ? { testId } : {}) }), [api, testId]);
  if (load.state === 'loading') return <p className="muted">불러오는 중…</p>;
  if (load.state === 'error') return <Failure message={load.message} />;
  const h = load.data;
  if (h.tests.length === 0) return <p className="muted">최근 {HISTORY_LIMIT} Cycle 에 결과가 없음</p>;
  return (
    <>
      <p className="muted">최근 {h.cycles.length} Cycle · flaky 비율 = 통과(흔들림) / (통과 + 통과(흔들림) + 실패){testId ? <> · <Link to={href('/tests')}>전체 보기</Link></> : null}</p>
      <table className="table">
        <thead><tr><th>테스트</th><th>flaky</th><th>실패</th><th>추이(오래된 → 최신)</th></tr></thead>
        <tbody>
          {h.tests.map((t) => (
            <tr key={t.testId}>
              <td><Link to={`${href('/tests')}?testId=${encodeURIComponent(t.testId)}`}>{t.testId}</Link></td>
              <td>{pct(t.flakyRate)}</td>
              <td>{t.stats.failed}</td>
              <td className="sparkline">
                {t.cells.map((c) => (
                  <Link key={`${c.cycleId}/${c.targetId}`} to={caseHref(c.cycleId, t.testId, c.targetId)} className={`spark cell-${c.verdict}`} title={`${c.build} · ${c.targetId} · ${CELL_LABEL[c.verdict]}`} />
                ))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <ul aria-label="범례" className="legend">{CELL_ORDER.filter((k) => k !== 'pending').map((k) => <li key={k} className={`cell cell-${k}`}>{CELL_LABEL[k]}</li>)}</ul>
    </>
  );
}
