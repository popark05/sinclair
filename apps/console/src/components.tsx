// 공통 조각: 배지, 링크, 불러오기 상태.
import type { ReactNode, MouseEvent } from 'react';
import { useEffect, useState } from 'react';
import type { Tone } from './labels.ts';
import { navigate } from './route.ts';

export function Badge({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

export function Link({ to, children }: { to: string; children: ReactNode }) {
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return; // 새 탭 열기는 브라우저에 맡긴다
    e.preventDefault();
    navigate(to);
  };
  return <a href={to} onClick={onClick}>{children}</a>;
}

export type Load<T> = { state: 'loading' } | { state: 'ok'; data: T } | { state: 'error'; message: string };

/** 비동기 불러오기. deps 가 바뀌면 다시, 언마운트 뒤의 결과는 버린다 */
export function useLoad<T>(load: () => Promise<T>, deps: readonly unknown[]): Load<T> {
  const [s, setS] = useState<Load<T>>({ state: 'loading' });
  useEffect(() => {
    let alive = true;
    load().then((data) => alive && setS({ state: 'ok', data }), (err: unknown) => alive && setS({ state: 'error', message: err instanceof Error ? err.message : String(err) }));
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return s;
}

/** 불러오고, keepPolling(data) 가 참인 동안 intervalMs 마다 다시 불러온다. 화면을 떠나면 타이머를 정리한다 */
export function usePolling<T>(load: () => Promise<T>, deps: readonly unknown[], intervalMs: number, keepPolling: (data: T) => boolean): Load<T> {
  const [s, setS] = useState<Load<T>>({ state: 'loading' });
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = () => {
      load().then((data) => {
        if (!alive) return;
        setS({ state: 'ok', data });
        if (keepPolling(data)) timer = setTimeout(tick, intervalMs);
      }, (err: unknown) => {
        // 일시 오류여도 이전 화면은 지우고 사유를 보인다. 다시 부르지 않는다(모르는 Cycle 을 계속 두드리지 않게) — 사용자가 새로 고친다
        if (alive) setS({ state: 'error', message: err instanceof Error ? err.message : String(err) });
      });
    };
    tick();
    return () => { alive = false; if (timer) clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return s;
}

export function Failure({ message }: { message: string }) {
  return <p role="alert" className="error">불러오지 못함: {message}</p>;
}
