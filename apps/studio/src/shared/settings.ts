// Studio 설정(studio-console 03): control-plane 주소·테스트 폴더. 의존 없는 모듈(메인 프로세스가 import — main-imports 테스트).
export interface StudioSettings {
  /** control-plane 주소(녹화 캐시 저장·Cycle 등록·Console 링크) */
  controlPlane: string;
  /** 내보낸 테스트를 두는 폴더(Cycle 의 suite — 같은 머신의 데몬이 읽는다). 절대 경로 또는 ~/ */
  testsDir: string;
}

const ABS = /^(\/|~\/|[A-Za-z]:[\\/])/;

export function parseStudioSettings(v: unknown): { ok: true; value: StudioSettings } | { ok: false; errors: string[] } {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return { ok: false, errors: ['설정은 객체여야 함'] };
  const o = v as Record<string, unknown>;
  const errors: string[] = [];
  for (const k of Object.keys(o)) if (k !== 'controlPlane' && k !== 'testsDir') errors.push(`${k}: 모르는 설정`);
  let url: URL | undefined;
  try { url = typeof o.controlPlane === 'string' ? new URL(o.controlPlane) : undefined; } catch { url = undefined; }
  if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:') || (o.controlPlane as string).length > 500) errors.push('controlPlane: http(s) 주소여야 함');
  if (typeof o.testsDir !== 'string' || !ABS.test(o.testsDir) || o.testsDir.length > 1000) errors.push('testsDir: 절대 경로(또는 ~/)여야 함');
  return errors.length ? { ok: false, errors } : { ok: true, value: { controlPlane: (o.controlPlane as string).replace(/\/+$/, ''), testsDir: o.testsDir as string } };
}
