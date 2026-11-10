// Console 뼈대: 머리띠 + 경로로 고른 화면.
import { useMemo } from 'react';
import { createApi, type Api } from './api.ts';
import { Link } from './components.tsx';
import { CycleList } from './pages/CycleList.tsx';
import { CycleView } from './pages/CycleView.tsx';
import { CaseView } from './pages/CaseView.tsx';
import { FleetPage } from './pages/FleetPage.tsx';
import { RunRedirect } from './pages/RunRedirect.tsx';
import { HistoryPage } from './pages/HistoryPage.tsx';
import { href, useRoute } from './route.ts';

export function App({ api: given }: { api?: Api }) {
  const api = useMemo(() => given ?? createApi(''), [given]);
  const route = useRoute();
  return (
    <div className="app">
      <header className="top">
        <Link to={href('/')}>Sinclair Console</Link>
        <nav className="nav"><Link to={href('/cycles')}>Cycle</Link><Link to={href('/fleet')}>플릿</Link><Link to={href('/tests')}>안정성</Link></nav>
      </header>
      <main>
        {route.page === 'cycles' && (<><h1>Cycle</h1><CycleList api={api} /></>)}
        {route.page === 'cycle' && <CycleView api={api} cycleId={route.cycleId} />}
        {route.page === 'case' && <CaseView api={api} cycleId={route.cycleId} testId={route.testId} targetId={route.targetId} />}
        {route.page === 'fleet' && (<><h1>플릿</h1><FleetPage api={api} /></>)}
        {route.page === 'tests' && (<><h1>안정성 이력{route.testId ? ` — ${route.testId}` : ''}</h1><HistoryPage api={api} {...(route.testId ? { testId: route.testId } : {})} /></>)}
        {route.page === 'run' && <RunRedirect api={api} runId={route.runId} />}
        {route.page === 'not-found' && <p role="alert">없는 화면: {route.path}</p>}
      </main>
    </div>
  );
}
