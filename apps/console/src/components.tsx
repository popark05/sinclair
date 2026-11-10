// 공통 조각: 배지, 링크, 불러오기 상태.
import type { ReactNode, MouseEvent } from 'react';
import { useEffect, useState } from 'react';
import type { Tone } from './labels.ts';
import { navigate } from './route.ts';
import { ApiError } from './api.ts';

export function Badge({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

export function Link({ to, children, className, title }: { to: string; children?: ReactNode; className?: string; title?: string }) {
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return; // 새 탭 열기는 브라우저에 맡긴다
    e.preventDefault();
    navigate(to);
  };
  return <a href={to} onClick={onClick} {...(className ? { className } : {})} {...(title ? { title, 'aria-label': title } : {})}>{children}</a>;
}

/** stale: 이전에 불러온 data 를 보이는 중인데 새로 고침이 실패함(그 사유) */
export type Load<T> = { state: 'loading' } | { state: 'ok'; data: T; stale?: string } | { state: 'error'; message: string };

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** 비동기 불러오기. deps 가 바뀌면 불러오는 중으로 되돌리고 다시(이전 대상의 화면을 새 대상 아래 보이지 않게), 언마운트 뒤의 결과는 버린다 */
export function useLoad<T>(load: () => Promise<T>, deps: readonly unknown[]): Load<T> {
  return usePolling(load, deps, 0, () => false);
}

/** 일시 오류 뒤 다시 시도하는 간격의 상한: 서버가 재시작하는 동안 두드리는 횟수를 묶는다 */
const MAX_BACKOFF_MS = 60_000;

/**
 * 불러오고, keepPolling(data) 가 참인 동안 intervalMs 마다 다시 불러온다. 화면을 떠나거나 deps 가 바뀌면 타이머를 정리한다.
 * 실패: 404 면 멈춘다(모르는 대상을 계속 두드리지 않게). 그 밖(서버 재시작·네트워크)은 이전 화면을 두고 사유를 stale 로 알리며
 * 간격을 두 배씩(최대 60초) 늘려 다시 시도한다. intervalMs 가 0 이면 한 번만(useLoad).
 */
export function usePolling<T>(load: () => Promise<T>, deps: readonly unknown[], intervalMs: number, keepPolling: (data: T) => boolean): Load<T> {
  const [s, setS] = useState<Load<T>>({ state: 'loading' });
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let delay = intervalMs;
    setS({ state: 'loading' });
    const schedule = () => { if (alive && intervalMs > 0) timer = setTimeout(tick, delay); };
    const tick = () => {
      load().then((data) => {
        if (!alive) return;
        setS({ state: 'ok', data });
        delay = intervalMs;
        if (keepPolling(data)) schedule();
      }, (err: unknown) => {
        if (!alive) return;
        const message = messageOf(err);
        setS((prev) => (prev.state === 'ok' ? { state: 'ok', data: prev.data, stale: message } : { state: 'error', message }));
        if (err instanceof ApiError && err.status === 404) return;
        delay = Math.min(delay * 2, MAX_BACKOFF_MS);
        schedule();
      });
    };
    tick();
    return () => { alive = false; if (timer) clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return s;
}

/** 이전 화면을 보이는 중 새로 고침이 실패했다는 알림 */
export function Stale({ message }: { message?: string | undefined }) {
  return message ? <p role="status" className="stale">새로 고치지 못함: {message} — 다시 시도하는 중</p> : null;
}

export function Failure({ message }: { message: string }) {
  return <p role="alert" className="error">불러오지 못함: {message}</p>;
}
