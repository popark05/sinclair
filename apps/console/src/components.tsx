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

export function Failure({ message }: { message: string }) {
  return <p role="alert" className="error">불러오지 못함: {message}</p>;
}
