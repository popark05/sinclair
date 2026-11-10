// 플릿 상태: 노드마다 온라인 여부·마지막 보고, 기기 표(상태·사유·헬퍼·잠김). 사용 중 기기는 그 Run(→ Cycle)으로 간다.
// 끊긴 노드는 확인 뒤 지울 수 있다(보존 기간이 지나면 서버가 알아서도 지운다).
import { useState } from 'react';
import type { Api, FleetView } from '../api.ts';
import { Badge, Failure, Link, Stale, usePolling } from '../components.tsx';
import { maskDevice, type Tone } from '../labels.ts';
import { href } from '../route.ts';

/** 새로 고침 간격: 노드는 lease TTL/3(기본 약 20초)마다 보고하므로 10초면 변화를 놓치지 않으면서 서버를 괴롭히지 않는다 */
export const FLEET_REFRESH_MS = 10_000;
type Device = FleetView['nodes'][number]['devices'][number];
const STATE: Record<Device['state'], [string, Tone]> = { idle: ['쓸 수 있음', 'good'], leased: ['사용 중', 'info'], untrusted: ['신뢰 안 됨', 'warn'], offline: ['오프라인', 'neutral'] };
const PLATFORM: Record<string, string> = { android: 'Android', ios: 'iOS' };

export function FleetPage({ api, confirm = (m) => window.confirm(m) }: { api: Api; confirm?: (message: string) => boolean }) {
  const load = usePolling(() => api.fleet(), [api], FLEET_REFRESH_MS, () => true);
  // 지운 노드는 다음 새로 고침 전까지 화면에서 바로 뺀다. 다시 보고하면(서버 목록에 다시 나오면) 보인다 — 지운 시각 뒤의 보고만 남는다
  const [removed, setRemoved] = useState<ReadonlyMap<string, string>>(new Map());
  const [removeError, setRemoveError] = useState<string>();
  const remove = async (agentId: string, reportedAt: string) => {
    if (!confirm(`노드 ${agentId} 의 기록을 지운다. 그 데몬이 다시 보고하면 새로 나타난다.`)) return;
    setRemoveError(undefined);
    try {
      await api.deleteNode(agentId);
      setRemoved((m) => new Map(m).set(agentId, reportedAt));
    } catch (err) { setRemoveError(`${agentId} 를 지우지 못함: ${err instanceof Error ? err.message : String(err)}`); }
  };
  if (load.state === 'loading') return <p className="muted">불러오는 중…</p>;
  if (load.state === 'error') return <Failure message={load.message} />;
  const nodes = load.data.nodes.filter((n) => removed.get(n.agentId) !== n.reportedAt);
  if (nodes.length === 0) return <p className="muted">보고한 노드가 없음 — 기기 노드에서 <code>sinclair-agent daemon</code> 을 띄운다</p>;
  return (
    <>
      <Stale message={load.stale} />
      {removeError ? <p role="alert" className="error">{removeError}</p> : null}
      {nodes.map((n) => (
        <section key={n.agentId} aria-label={`노드 ${n.agentId}`} className="attempt">
          <h2>{n.agentId} <Badge tone={n.online ? 'good' : 'bad'}>{n.online ? '온라인' : '끊김'}</Badge> <span className="muted">마지막 보고 {new Date(n.reportedAt).toLocaleString('ko-KR', { dateStyle: 'short', timeStyle: 'medium' })}</span>
            {n.online ? null : <> <button type="button" onClick={() => void remove(n.agentId, n.reportedAt)}>지우기</button></>}</h2>
          {n.devices.length === 0 ? <p className="muted">보고한 기기 없음</p> : (
            <table className="table">
              <thead><tr><th>기기</th><th>모델</th><th>OS</th><th>연결</th><th>상태</th><th>사유</th><th>헬퍼</th><th>잠금</th><th>Run</th></tr></thead>
              <tbody>
                {n.devices.map((d) => {
                  const [label, tone] = STATE[d.state];
                  return (
                    <tr key={d.id}>
                      <td className="mono">{maskDevice(d.id)}</td>
                      <td>{d.model}</td>
                      <td>{PLATFORM[d.platform] ?? d.platform} {d.osVersion}</td>
                      <td>{d.connection}</td>
                      <td><Badge tone={tone}>{label}</Badge></td>
                      <td className="muted">{d.reason ?? ''}</td>
                      <td>{d.helper ?? '—'}</td>
                      <td>{d.locked === undefined ? '—' : d.locked ? '잠김' : '열림'}</td>
                      <td>{d.runId ? <Link to={href(`/runs/${encodeURIComponent(d.runId)}`)}>{d.runId}</Link> : ''}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </section>
      ))}
    </>
  );
}
