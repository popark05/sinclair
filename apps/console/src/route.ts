// 아주 작은 라우터: Console 은 /console/ 아래에서 서빙되고, 화면은 경로로 고른다(공유 링크가 그대로 그 화면을 연다).
import { useEffect, useState } from 'react';

export const BASE = '/console';
export const href = (path: string): string => `${BASE}${path}`;

export type Route = { page: 'cycles' } | { page: 'cycle'; cycleId: string } | { page: 'not-found'; path: string };

export function parseRoute(pathname: string): Route {
  const rest = pathname.startsWith(BASE) ? pathname.slice(BASE.length) : pathname;
  const parts = rest.split('/').filter(Boolean).map(decodeURIComponent);
  if (parts.length === 0) return { page: 'cycles' };
  if (parts[0] === 'cycles' && parts.length === 2) return { page: 'cycle', cycleId: parts[1]! };
  return { page: 'not-found', path: rest };
}

/** 링크 클릭을 가로채 새로 읽지 않고 화면만 바꾼다 */
export function navigate(to: string): void {
  window.history.pushState({}, '', to);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseRoute(window.location.pathname));
  useEffect(() => {
    const on = () => setRoute(parseRoute(window.location.pathname));
    window.addEventListener('popstate', on);
    return () => window.removeEventListener('popstate', on);
  }, []);
  return route;
}
