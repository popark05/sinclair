// /console/runs/:id → 그 Run 의 Cycle 화면(플릿의 사용 중 기기 링크). Run 이 Cycle 에 속하지 않으면 안내.
import { useEffect } from 'react';
import type { Api } from '../api.ts';
import { Failure, useLoad } from '../components.tsx';
import { cycleHref } from '../route.ts';

export function RunRedirect({ api, runId }: { api: Api; runId: string }) {
  const load = useLoad(() => api.run(runId), [api, runId]);
  useEffect(() => {
    if (load.state === 'ok' && load.data.cycleId) {
      window.history.replaceState({}, '', cycleHref(load.data.cycleId));
      window.dispatchEvent(new PopStateEvent('popstate'));
    }
  }, [load]);
  if (load.state === 'error') return <Failure message={load.message} />;
  if (load.state === 'ok' && !load.data.cycleId) return <p className="muted">Run {runId} 은 Cycle 에 속하지 않음(로컬 실행)</p>;
  return <p className="muted">Run {runId} 의 Cycle 로 가는 중…</p>;
}
