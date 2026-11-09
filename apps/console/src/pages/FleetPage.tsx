// 플릿 상태: 노드마다 온라인 여부·마지막 보고, 기기 표(상태·사유·헬퍼·잠김). 사용 중 기기는 그 Run(→ Cycle)으로 간다.
import type { Api, FleetView } from '../api.ts';
import { Badge, Failure, Link, usePolling } from '../components.tsx';
import { maskDevice, type Tone } from '../labels.ts';
import { href } from '../route.ts';

/** 새로 고침 간격: 노드는 lease TTL/3(기본 약 20초)마다 보고하므로 10초면 변화를 놓치지 않으면서 서버를 괴롭히지 않는다 */
export const FLEET_REFRESH_MS = 10_000;
type Device = FleetView['nodes'][number]['devices'][number];
const STATE: Record<Device['state'], [string, Tone]> = { idle: ['쓸 수 있음', 'good'], leased: ['사용 중', 'info'], untrusted: ['신뢰 안 됨', 'warn'], offline: ['오프라인', 'neutral'] };
const PLATFORM: Record<string, string> = { android: 'Android', ios: 'iOS' };

export function FleetPage({ api }: { api: Api }) {
  const load = usePolling(() => api.fleet(), [api], FLEET_REFRESH_MS, () => true);
  if (load.state === 'loading') return <p className="muted">불러오는 중…</p>;
  if (load.state === 'error') return <Failure message={load.message} />;
  if (load.data.nodes.length === 0) return <p className="muted">보고한 노드가 없음 — 기기 노드에서 <code>sinclair-agent daemon</code> 을 띄운다</p>;
  return (
    <>
      {load.data.nodes.map((n) => (
        <section key={n.agentId} aria-label={`노드 ${n.agentId}`} className="attempt">
          <h2>{n.agentId} <Badge tone={n.online ? 'good' : 'bad'}>{n.online ? '온라인' : '끊김'}</Badge> <span className="muted">마지막 보고 {new Date(n.reportedAt).toLocaleString('ko-KR', { dateStyle: 'short', timeStyle: 'medium' })}</span></h2>
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
