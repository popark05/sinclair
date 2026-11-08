// 노드 기기 보고 계약: runner-agent(노드)가 자기에게 꽂힌 기기를 control-plane 에 알린다(PUT /fleet/nodes/:agentId 의 본문).
// apps 는 서로 import 하지 않으므로 이 타입과 검증기가 둘 사이의 유일한 계약이다. 닫힌 검증기라 모르는 필드는 거부한다.
import { DEVICE_CONNECTION_STATES, DEVICE_PLATFORMS, HELPER_STATES, type DeviceConnectionState, type DevicePlatform, type HelperState } from './device-rpc.ts';

export interface NodeDevice {
  /** 기기 식별자(Android 시리얼). control-plane 안에서는 그대로 쓰고, 로그·증거에서는 마스킹한다 */
  id: string;
  platform: DevicePlatform;
  model: string;
  osVersion: string;
  /** 디바이스 레이어의 연결 판정(device = 승인돼 쓸 수 있음) */
  connection: DeviceConnectionState;
  /** 온디바이스 헬퍼 상태. 없으면 그 플랫폼에 헬퍼 개념이 없거나 아직 모르는 것 */
  helper?: HelperState;
  /** 화면 잠금(보안 잠금 포함). 없으면 확인하지 못한 것 */
  locked?: boolean;
}

export interface NodeReport { devices: NodeDevice[] }

export type NodeReportParse = { ok: true; value: NodeReport } | { ok: false; errors: string[] };

const FIELDS = new Set(['id', 'platform', 'model', 'osVersion', 'connection', 'helper', 'locked']);
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

export function parseNodeReport(input: unknown): NodeReportParse {
  if (!isRecord(input) || !Array.isArray(input.devices)) return { ok: false, errors: ['보고는 { devices: [...] } 이어야 함'] };
  const errors: string[] = [];
  const seen = new Set<string>();
  input.devices.forEach((d: unknown, i: number) => {
    const at = `devices[${i}]`;
    if (!isRecord(d)) { errors.push(`${at}: 객체여야 함`); return; }
    for (const k of Object.keys(d)) if (!FIELDS.has(k)) errors.push(`${at}.${k}: 모르는 필드`);
    if (!nonEmpty(d.id)) errors.push(`${at}.id: 비어 있지 않은 문자열이어야 함`);
    else if (seen.has(d.id)) errors.push(`${at}.id: 같은 기기가 두 번 있음`);
    else seen.add(d.id);
    if (!(DEVICE_PLATFORMS as readonly unknown[]).includes(d.platform)) errors.push(`${at}.platform: ${DEVICE_PLATFORMS.join('|')} 중 하나여야 함`);
    if (typeof d.model !== 'string') errors.push(`${at}.model: 문자열이어야 함`);
    if (typeof d.osVersion !== 'string') errors.push(`${at}.osVersion: 문자열이어야 함`);
    if (!(DEVICE_CONNECTION_STATES as readonly unknown[]).includes(d.connection)) errors.push(`${at}.connection: ${DEVICE_CONNECTION_STATES.join('|')} 중 하나여야 함`);
    if (d.helper !== undefined && !(HELPER_STATES as readonly unknown[]).includes(d.helper)) errors.push(`${at}.helper: ${HELPER_STATES.join('|')} 중 하나여야 함`);
    if (d.locked !== undefined && typeof d.locked !== 'boolean') errors.push(`${at}.locked: 불리언이어야 함`);
  });
  return errors.length ? { ok: false, errors } : { ok: true, value: input as unknown as NodeReport };
}
