// Device 패널(studio 03): 기기 화면(스냅샷)을 그리고 조작을 기기로 보낸다. 클릭 = 탭, 드래그 = 스와이프, 화면에 초점을 두고 치면 글자 입력·키.
// 라이브 화면은 미디어라 astryx 컴포넌트가 아닌 <img>(object-fit: contain)를 쓴다 — 좌표 변환은 device-coords.
import { useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react';
import { Stack } from '@astryxdesign/core/Layout';
import { Heading, Text } from '@astryxdesign/core/Text';
import { Button } from '@astryxdesign/core/Button';
import { EmptyState } from '@astryxdesign/core/EmptyState';
import { Icon } from '@astryxdesign/core/Icon';
import { DevicePhoneMobileIcon } from '@heroicons/react/24/outline';
import type { StudioApi, StudioKey, StudioSnapshot } from '../../shared/studio-ipc.ts';
import { fitRect, toDevicePoint, type Point } from './device-coords.ts';
import { findNode, nodeAt } from './inspector-model.ts';

/** 이만큼 덜 움직였으면 탭(손 떨림), 넘으면 스와이프 */
const TAP_SLOP_PX = 10;
/** 글자는 모아서 한 번에 입력(키마다 RPC 를 부르지 않게) */
const TEXT_FLUSH_MS = 300;
const KEY_MAP: Record<string, StudioKey> = { Enter: 'enter', Backspace: 'backspace', Tab: 'tab', Escape: 'escape', ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };

const styles: Record<string, CSSProperties> = {
  panel: { padding: 'var(--spacing-4)', height: '100%' },
  frame: { position: 'relative', flex: 1, minHeight: 0 },
  screen: { width: '100%', height: '100%', objectFit: 'contain', touchAction: 'none', cursor: 'pointer', outlineOffset: 2, borderRadius: 'var(--radius-2)', display: 'block' },
  highlight: { position: 'absolute', pointerEvents: 'none', border: '2px solid var(--color-accent)', background: 'color-mix(in srgb, var(--color-accent) 12%, transparent)', // 반투명: 테마의 muted 색은 다크에서 불투명이라 큰 노드가 화면을 가린다
    borderRadius: 'var(--radius-1)' },
};

export interface DevicePanelProps {
  api: StudioApi;
  deviceId: string;
  deviceLabel?: string;
  snapshot?: StudioSnapshot;
  /** 조작을 보낸 뒤(화면을 곧바로 다시 받게) */
  onInput?: () => void;
  /** 스냅샷을 받지 못한 이유 */
  error?: string;
  /** Inspector 가 고른 노드(화면 위 하이라이트) */
  selectedRef?: string;
  /** 화면을 클릭하면 그 자리의 가장 안쪽 노드를 고른다(탭과 함께) */
  onSelectNode?: (ref: string) => void;
  /** 세션 중: 화면을 턴마다만 갱신한다는 표시 */
  paused?: boolean;
  /** 데몬의 Run 이 이 기기를 쓰는 중 */
  inUse?: boolean;
}

export function DevicePanel({ api, deviceId, deviceLabel, snapshot, onInput, error, selectedRef, onSelectNode, paused, inUse }: DevicePanelProps) {
  const img = useRef<HTMLImageElement>(null);
  const down = useRef<{ p: Point; at: number }>(undefined);
  const buffer = useRef('');
  const flushTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [problem, setProblem] = useState('');
  const [highlight, setHighlight] = useState<{ left: number; top: number; width: number; height: number }>();
  /** 그림이 로드되면 원본 크기를 알게 되므로 하이라이트를 다시 놓는다 */
  const [loaded, setLoaded] = useState(0);

  // 고른 노드의 rect(기기 픽셀)를 표시 좌표로: 그림이 들어간 사각형(여백 제외)과 배율로
  useLayoutEffect(() => {
    const place = (): void => {
      const el = img.current;
      const node = snapshot && selectedRef ? findNode(snapshot.root, selectedRef) : undefined;
      if (!el || !node?.rect || !el.naturalWidth) { setHighlight(undefined); return; }
      const r = el.getBoundingClientRect();
      const fit = fitRect({ width: r.width, height: r.height }, { width: el.naturalWidth, height: el.naturalHeight });
      const k = fit.width / el.naturalWidth;
      setHighlight({ left: Math.round(fit.x + node.rect.x * k), top: Math.round(fit.y + node.rect.y * k), width: Math.round(node.rect.width * k), height: Math.round(node.rect.height * k) });
    };
    place();
    if (typeof ResizeObserver === 'undefined' || !img.current) return;
    const ro = new ResizeObserver(place);
    ro.observe(img.current);
    return () => ro.disconnect();
  }, [snapshot, selectedRef, loaded]);

  const send = async (f: () => Promise<void>): Promise<void> => {
    try { await f(); setProblem(''); onInput?.(); } catch (err) { setProblem(err instanceof Error ? err.message : String(err)); }
  };
  /** 요소 안 표시 좌표 → 기기 픽셀(여백이면 undefined) */
  const devicePoint = (clientX: number, clientY: number): Point | undefined => {
    const el = img.current;
    if (!el || !el.naturalWidth) return undefined;
    const r = el.getBoundingClientRect();
    return toDevicePoint({ x: clientX - r.left, y: clientY - r.top }, { width: r.width, height: r.height }, { width: el.naturalWidth, height: el.naturalHeight });
  };

  const onPointerDown = (e: PointerEvent<HTMLImageElement>): void => {
    down.current = { p: { x: e.clientX, y: e.clientY }, at: Date.now() };
    e.currentTarget.focus();
  };
  const onPointerUp = (e: PointerEvent<HTMLImageElement>): void => {
    const start = down.current;
    down.current = undefined;
    if (!start) return;
    const from = devicePoint(start.p.x, start.p.y);
    if (!from) return;
    const moved = Math.hypot(e.clientX - start.p.x, e.clientY - start.p.y);
    if (moved < TAP_SLOP_PX) {
      const hit = snapshot ? nodeAt(snapshot.root, from) : undefined;
      if (hit) onSelectNode?.(hit.ref);
      void send(() => api.tap(deviceId, from.x, from.y));
      return;
    }
    const to = devicePoint(e.clientX, e.clientY);
    if (!to) return;
    const durationMs = Math.min(2_000, Math.max(100, Date.now() - start.at));
    void send(() => api.swipe(deviceId, from, to, durationMs));
  };

  const flushText = (): void => {
    clearTimeout(flushTimer.current);
    const text = buffer.current;
    buffer.current = '';
    if (text) void send(() => api.text(deviceId, text));
  };
  const onKeyDown = (e: KeyboardEvent<HTMLImageElement>): void => {
    const key = KEY_MAP[e.key];
    if (key) { e.preventDefault(); flushText(); void send(() => api.key(deviceId, key)); return; }
    if (e.key.length === 1 && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      buffer.current += e.key;
      clearTimeout(flushTimer.current);
      flushTimer.current = setTimeout(flushText, TEXT_FLUSH_MS);
    }
  };

  return (
    <Stack as="section" aria-label="기기" direction="vertical" gap={3} style={styles.panel}>
      <Stack direction="vertical" gap={1}>
        <Heading level={2} maxLines={1}>기기</Heading>
        {deviceLabel ? <Text type="supporting" color="secondary" maxLines={1}>{deviceLabel}</Text> : null}
        {inUse ? <Text type="supporting" color="secondary" maxLines={2}>Run 실행 중 — 화면은 10초마다만 갱신(기기를 Run 에 양보)</Text> : null}
        {paused ? <Text type="supporting" color="secondary" maxLines={2}>세션 중 — 화면은 에이전트 턴마다 갱신(기기를 에이전트에게 양보)</Text> : null}
      </Stack>
      {snapshot ? (
        <Stack direction="vertical" style={styles.frame}>
        <img
          ref={img}
          src={`data:image/png;base64,${snapshot.png}`}
          alt={`기기 화면${deviceLabel ? ` ${deviceLabel}` : ''}`}
          tabIndex={0}
          draggable={false}
          style={styles.screen}
          onPointerDown={onPointerDown}
          onPointerUp={onPointerUp}
          onKeyDown={onKeyDown}
          onLoad={() => setLoaded((n) => n + 1)}
        />
          {highlight ? <Stack aria-label="선택한 노드 영역" style={{ ...styles.highlight, left: highlight.left, top: highlight.top, width: highlight.width, height: highlight.height }} /> : null}
        </Stack>
      ) : (
        <EmptyState
          isCompact
          icon={<Icon icon={DevicePhoneMobileIcon} size="lg" />}
          title={deviceId ? '화면을 불러오는 중' : '연결된 기기 없음'}
          description={error ?? (deviceId ? '기기 화면과 화면 트리를 받고 있습니다.' : 'Android 기기를 USB 로 연결하면 화면이 여기 보입니다. 클릭하면 탭, 드래그하면 스와이프합니다.')}
        />
      )}
      <Stack direction="horizontal" gap={2}>
        <Button label="뒤로" size="sm" variant="secondary" isDisabled={!deviceId} onClick={() => void send(() => api.button(deviceId, 'back'))} />
        <Button label="홈" size="sm" variant="secondary" isDisabled={!deviceId} onClick={() => void send(() => api.button(deviceId, 'home'))} />
      </Stack>
      {problem || (snapshot && error) ? <Text type="supporting" color="secondary">{problem || error}</Text> : null}
    </Stack>
  );
}
