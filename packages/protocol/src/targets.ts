// 타깃 선택 조건 계약(device-fleet 03): Cycle 매트릭스의 열(타깃)은 이름 문자열이거나 기기 선택 조건이다.
// 이름 타깃은 그 이름을 맡겠다고 선언한 노드가 채우고(하위 호환), 조건 타깃은 조건에 맞는 아무 기기가 채운다.
// POST /cycles 의 targets 와 control-plane 의 클레임 매칭이 이 검증기·매칭 함수를 쓴다. 닫힌 검증기라 모르는 필드는 거부한다.
import { DEVICE_PLATFORMS, type DevicePlatform } from './device-rpc.ts';
import type { NodeDevice } from './fleet.ts';

export interface TargetSelector {
  /** 매트릭스 열 이름 */
  id: string;
  platform: DevicePlatform;
  /** 정확히 일치하는 모델 하나 또는 목록 중 하나 */
  model?: string | string[];
  /** OS 버전 범위(양 끝 포함). 점으로 나눈 숫자로 비교한다 */
  osVersion?: { min?: string; max?: string };
  /** 그 기기(시리얼)만 — Studio 에서 고른 기기에서 돌릴 때(studio-console 02) */
  deviceId?: string;
}

export type CycleTargetInput = string | TargetSelector;

export type CycleTargetsParse =
  | { ok: true; ids: string[]; selectors: Record<string, TargetSelector> }
  | { ok: false; errors: string[] };

const VERSION = /^\d+(\.\d+)*$/;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

/** "13" < "13.1" < "14": 점으로 나눈 숫자를 앞에서부터 비교하고 빈 자리는 0 으로 본다. 둘 다 VERSION 모양이어야 한다 */
export function compareOsVersion(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

export function parseCycleTargets(input: unknown): CycleTargetsParse {
  if (!Array.isArray(input) || input.length === 0) return { ok: false, errors: ['targets 는 비어 있지 않은 배열이어야 함(이름 문자열 또는 조건 { id, platform, model?, osVersion? })'] };
  const errors: string[] = [];
  const ids: string[] = [];
  const selectors: Record<string, TargetSelector> = {};
  input.forEach((t: unknown, i: number) => {
    const at = `targets[${i}]`;
    let id: string | undefined;
    if (typeof t === 'string') {
      if (!t) errors.push(`${at}: 빈 이름`); else id = t;
    } else if (isRecord(t)) {
      for (const k of Object.keys(t)) if (!['id', 'platform', 'model', 'osVersion', 'deviceId'].includes(k)) errors.push(`${at}.${k}: 모르는 필드`);
      if (t.deviceId !== undefined && !nonEmpty(t.deviceId)) errors.push(`${at}.deviceId: 비어 있지 않은 문자열(기기 시리얼)이어야 함`);
      if (!nonEmpty(t.id)) errors.push(`${at}.id: 비어 있지 않은 문자열이어야 함`); else id = t.id;
      if (!(DEVICE_PLATFORMS as readonly unknown[]).includes(t.platform)) errors.push(`${at}.platform: ${DEVICE_PLATFORMS.join('|')} 중 하나여야 함`);
      if (t.model !== undefined && !nonEmpty(t.model) && !(Array.isArray(t.model) && t.model.length > 0 && t.model.every(nonEmpty))) errors.push(`${at}.model: 비어 있지 않은 문자열 또는 그 배열이어야 함`);
      if (t.osVersion !== undefined) {
        if (!isRecord(t.osVersion)) errors.push(`${at}.osVersion: { min?, max? } 이어야 함`);
        else {
          for (const k of Object.keys(t.osVersion)) if (k !== 'min' && k !== 'max') errors.push(`${at}.osVersion.${k}: 모르는 필드`);
          if (t.osVersion.min === undefined && t.osVersion.max === undefined) errors.push(`${at}.osVersion: min 이나 max 중 하나는 있어야 함(빈 범위는 숫자로 읽을 수 없는 버전의 기기만 막는다)`);
          for (const k of ['min', 'max'] as const) {
            const v = t.osVersion[k];
            if (v !== undefined && !(typeof v === 'string' && VERSION.test(v))) errors.push(`${at}.osVersion.${k}: "13" 이나 "13.1" 같은 버전 문자열이어야 함`);
          }
          const { min, max } = t.osVersion;
          if (typeof min === 'string' && typeof max === 'string' && VERSION.test(min) && VERSION.test(max) && compareOsVersion(min, max) > 0) errors.push(`${at}.osVersion: min 이 max 보다 큼`);
        }
      }
      if (id) selectors[id] = t as unknown as TargetSelector;
    } else errors.push(`${at}: 이름 문자열이거나 조건 객체여야 함`);
    if (id) {
      // 같은 이름 문자열이 두 번이면 예전처럼 하나로 합친다(하위 호환). 조건이 끼면 정의가 둘이 되므로 거부한다
      if (!ids.includes(id)) ids.push(id);
      else if (typeof t !== 'string' || selectors[id]) errors.push(`${at}: 타깃 id ${id} 가 두 번 있음`);
    }
  });
  return errors.length ? { ok: false, errors } : { ok: true, ids, selectors };
}

/** 기기가 조건에 맞는지. OS 조건이 있는데 기기의 OS 버전을 숫자로 읽을 수 없으면 맞지 않는다(코드네임 미리보기 빌드 등) */
export function matchesTarget(d: Pick<NodeDevice, 'id' | 'platform' | 'model' | 'osVersion'>, s: TargetSelector): boolean {
  if (d.platform !== s.platform) return false;
  if (s.deviceId !== undefined && d.id !== s.deviceId) return false;
  if (s.model !== undefined && !(Array.isArray(s.model) ? s.model.includes(d.model) : s.model === d.model)) return false;
  if (s.osVersion) {
    if (!VERSION.test(d.osVersion)) return false;
    if (s.osVersion.min !== undefined && compareOsVersion(d.osVersion, s.osVersion.min) < 0) return false;
    if (s.osVersion.max !== undefined && compareOsVersion(d.osVersion, s.osVersion.max) > 0) return false;
  }
  return true;
}
