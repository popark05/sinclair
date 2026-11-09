// Console 뼈대: 머리띠 + 경로로 고른 화면.
import { useMemo } from 'react';
import { createApi, type Api } from './api.ts';
import { Link } from './components.tsx';
import { CycleList } from './pages/CycleList.tsx';
import { CycleView } from './pages/CycleView.tsx';
import { href, useRoute } from './route.ts';

export function App({ api: given }: { api?: Api }) {
  const api = useMemo(() => given ?? createApi(''), [given]);
  const route = useRoute();
  return (
    <div className="app">
      <header className="top"><Link to={href('/')}>Sinclair Console</Link></header>
      <main>
        {route.page === 'cycles' && (<><h1>Cycle</h1><CycleList api={api} /></>)}
        {route.page === 'cycle' && <CycleView api={api} cycleId={route.cycleId} />}
        {route.page === 'case' && <p className="muted">케이스 {route.testId} / {route.targetId} — 상세는 다음 티켓(console 03)</p>}
        {route.page === 'not-found' && <p role="alert">없는 화면: {route.path}</p>}
      </main>
    </div>
  );
}
