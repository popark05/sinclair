// Cycle 의 모델 사용: 합계, 모델별, 타깃·테스트별(호출 많은 순). 토큰만 보인다 — 단가가 바뀌어 달러로 바꾸지 않는다(모델별 표에 단가를 곱하면 된다).
import type { Api, CycleUsage } from '../api.ts';
import { Failure, usePolling } from '../components.tsx';

/** 진행 중 Cycle 의 사용량 새로 고침 간격(Cycle 화면과 같은 박자) */
const USAGE_REFRESH_MS = 5_000;

type Totals = CycleUsage['total'];
const n = (x: number): string => x.toLocaleString('en-US');
const rate = (r: number | null): string => (r === null ? '—' : `${(r * 100).toFixed(1)}%`);

export function UsageSection({ api, cycleId, live = false }: { api: Api; cycleId: string; live?: boolean }) {
  // 진행 중이면 Cycle 화면과 함께 새로 고친다(에이전트 스텝이 쌓이는 동안 비용이 보이게)
  const load = usePolling(() => api.usage(cycleId), [api, cycleId, live], USAGE_REFRESH_MS, () => live);
  if (load.state === 'loading') return null;
  if (load.state === 'error') return <Failure message={load.message} />;
  const u = load.data;
  if (u.total.modelCalls === 0) return null; // 에이전트 스텝이 없는 Cycle
  return (
    <section aria-label="모델 사용">
      <h2>모델 사용</h2>
      <dl className="cards">
        {([['모델 호출', n(u.total.modelCalls)], ['입력 토큰', n(u.total.inputTokens)], ['출력 토큰', n(u.total.outputTokens)], ['캐시 읽기', n(u.total.cacheReadTokens)], ['캐시 쓰기', n(u.total.cacheWriteTokens)], ['캐시 적중률', rate(u.total.cacheHitRate)]] as const).map(([k, v]) => (
          <div key={k} className="card"><dt>{k}</dt><dd>{v}</dd></div>
        ))}
      </dl>
      <p className="muted">대체된(버려진) Run 의 호출도 센다. 캐시 적중률 = 캐시 읽기 / (입력 + 캐시 읽기 + 캐시 쓰기).</p>
      {Object.keys(u.byModel).length ? <Models rows={u.byModel} /> : null}
      <Breakdown name="타깃별" rows={u.byTarget} />
      <Breakdown name="테스트별" rows={u.byTest} />
    </section>
  );
}

function Breakdown({ name, rows }: { name: string; rows: Record<string, Totals> }) {
  const sorted = Object.entries(rows).sort((a, b) => b[1].modelCalls - a[1].modelCalls || a[0].localeCompare(b[0]));
  return (
    <table className="table" aria-label={name}>
      <thead><tr><th>{name.replace('별', '')}</th><th>호출</th><th>입력</th><th>출력</th><th>캐시 읽기</th><th>캐시 쓰기</th><th>적중률</th></tr></thead>
      <tbody>
        {sorted.map(([k, t]) => (
          <tr key={k}><td>{k}</td><td>{n(t.modelCalls)}</td><td>{n(t.inputTokens)}</td><td>{n(t.outputTokens)}</td><td>{n(t.cacheReadTokens)}</td><td>{n(t.cacheWriteTokens)}</td><td>{rate(t.cacheHitRate)}</td></tr>
        ))}
      </tbody>
    </table>
  );
}

/** 모델별 토큰(본 모델·요약 모델·fallback 모델은 단가가 달라 나눠 본다). 호출 수는 스텝 단위라 모델로 나누지 않는다 */
function Models({ rows }: { rows: CycleUsage['byModel'] }) {
  const sorted = Object.entries(rows).sort((a, b) => b[1].inputTokens - a[1].inputTokens || a[0].localeCompare(b[0]));
  return (
    <table className="table" aria-label="모델별">
      <thead><tr><th>모델</th><th>입력</th><th>출력</th><th>캐시 읽기</th><th>캐시 쓰기</th><th>적중률</th></tr></thead>
      <tbody>{sorted.map(([m, t]) => <tr key={m}><td className="mono">{m}</td><td>{n(t.inputTokens)}</td><td>{n(t.outputTokens)}</td><td>{n(t.cacheReadTokens)}</td><td>{n(t.cacheWriteTokens)}</td><td>{rate(t.cacheHitRate)}</td></tr>)}</tbody>
    </table>
  );
}
