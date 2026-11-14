// Console → Studio 열기 요청(studio-console 05): Console 이 남기고 그 기기가 연결된 Studio 가 가져가 처리(ack)하는 짧게 사는 신호.
// 메모리에만(재시작하면 사라져도 된다), 10분 뒤 버린다. Studio 는 기기를 고르고 목표를 채울 뿐 실행하지 않는다.
import { randomUUID } from 'node:crypto';

export interface OpenRequest {
  id: string;
  deviceId: string;
  goal?: string;
  app?: string;
  from?: { cycleId?: string; testId?: string; targetId?: string };
  createdAt: string;
}
export const OPEN_REQUEST_TTL_MS = 10 * 60_000;
const APP_ID = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;

export function parseOpenRequest(v: unknown): { ok: true; value: Omit<OpenRequest, 'id' | 'createdAt'> } | { ok: false; errors: string[] } {
  if (!isRecord(v)) return { ok: false, errors: ['객체여야 함'] };
  const errors: string[] = [];
  for (const k of Object.keys(v)) if (!['deviceId', 'goal', 'app', 'from'].includes(k)) errors.push(`${k}: 모르는 필드`);
  if (!str(v.deviceId, 128)) errors.push('deviceId: 비어 있지 않은 문자열(128자 이하)');
  if (v.goal !== undefined && !str(v.goal, 2000)) errors.push('goal: 2000자 이하 문자열');
  if (v.app !== undefined && !(typeof v.app === 'string' && v.app.length <= 255 && APP_ID.test(v.app))) errors.push('app: 패키지 이름 형식');
  if (v.from !== undefined) {
    if (!isRecord(v.from)) errors.push('from: 객체');
    else for (const [k, x] of Object.entries(v.from)) if (!['cycleId', 'testId', 'targetId'].includes(k) || !str(x, 300)) errors.push(`from.${k}: 300자 이하 문자열`);
  }
  if (errors.length) return { ok: false, errors };
  return { ok: true, value: { deviceId: v.deviceId as string, ...(v.goal !== undefined ? { goal: v.goal as string } : {}), ...(v.app !== undefined ? { app: v.app as string } : {}), ...(v.from !== undefined ? { from: v.from as NonNullable<OpenRequest['from']> } : {}) } };
}

export function createOpenRequestStore(now: () => number) {
  const items = new Map<string, OpenRequest & { at: number }>();
  const prune = (): void => { const t = now(); for (const [id, r] of items) if (t - r.at > OPEN_REQUEST_TTL_MS) items.delete(id); };
  return {
    add(v: Omit<OpenRequest, 'id' | 'createdAt'>): OpenRequest {
      prune();
      const at = now();
      const r = { ...v, id: randomUUID(), createdAt: new Date(at).toISOString() };
      items.set(r.id, { ...r, at });
      return r;
    },
    list(devices: readonly string[]): OpenRequest[] {
      prune();
      return [...items.values()].filter((r) => devices.includes(r.deviceId)).map(({ at: _at, ...r }) => r);
    },
    ack(id: string): boolean { return items.delete(id); },
  };
}
