// Studio 업데이트 배포(studio-update 02): 운영자가 `pnpm dist:studio` 산출물(zip + latest-mac.json)을 --studio-releases-dir 에 두면
// Studio 가 GET /studio/releases/latest?arch= 로 새 버전을 알고 /studio/releases/files/<name> 에서 받는다. 목록에 적힌 파일만 내준다.
// 서명하지 않은 사내 배포본이라 Squirrel.Mac(코드 서명 필수)을 쓰지 못해 Studio 가 직접 받아 sha256 을 맞추고 교체한다.
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import * as path from 'node:path';

export const RELEASE_MANIFEST = 'latest-mac.json';
export const RELEASE_ARCHES = ['arm64', 'x64'] as const;
export type ReleaseArch = (typeof RELEASE_ARCHES)[number];
export interface ReleaseFile { arch: ReleaseArch; name: string; sha256: string; size: number }
export interface ReleaseManifest { product: string; version: string; releasedAt?: string; files: ReleaseFile[] }
/** Studio 에 돌려주는 최신 버전(그 아키텍처의 zip 하나) */
export interface LatestRelease { version: string; releasedAt?: string; arch: ReleaseArch; name: string; sha256: string; size: number; url: string }

const VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
/** 경로 문자 없는 파일 이름 */
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function parseReleaseManifest(v: unknown): { ok: true; value: ReleaseManifest } | { ok: false; errors: string[] } {
  if (!isRecord(v)) return { ok: false, errors: ['객체여야 함'] };
  const errors: string[] = [];
  if (typeof v.product !== 'string' || !v.product) errors.push('product: 문자열');
  if (typeof v.version !== 'string' || !VERSION.test(v.version)) errors.push('version: x.y.z');
  if (v.releasedAt !== undefined && (typeof v.releasedAt !== 'string' || Number.isNaN(Date.parse(v.releasedAt)))) errors.push('releasedAt: ISO 시각');
  const files: ReleaseFile[] = [];
  if (!Array.isArray(v.files)) errors.push('files: 배열');
  else v.files.forEach((f, i) => {
    if (!isRecord(f) || !(RELEASE_ARCHES as readonly unknown[]).includes(f.arch) || typeof f.name !== 'string' || !FILE_NAME.test(f.name) || !f.name.endsWith('.zip')
      || typeof f.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(f.sha256) || !Number.isSafeInteger(f.size) || (f.size as number) <= 0) errors.push(`files[${i}]: { arch: arm64|x64, name: *.zip, sha256: 64 hex, size > 0 }`);
    else files.push({ arch: f.arch as ReleaseArch, name: f.name, sha256: f.sha256, size: f.size as number });
  });
  if (errors.length) return { ok: false, errors };
  return { ok: true, value: { product: v.product as string, version: v.version as string, ...(v.releasedAt ? { releasedAt: v.releasedAt as string } : {}), files } };
}

/** 배포 디렉터리. 목록 파일은 요청마다 읽는다(운영자가 파일만 바꿔 끼우면 재시작 없이 새 버전) */
export function createStudioReleases(dir: string) {
  const root = path.resolve(dir);
  const manifest = async (): Promise<{ ok: true; value: ReleaseManifest } | { ok: false; error: string }> => {
    let raw: string;
    try { raw = await readFile(path.join(root, RELEASE_MANIFEST), 'utf8'); } catch { return { ok: false, error: `배포된 Studio 가 없음(${RELEASE_MANIFEST})` }; }
    let json: unknown;
    try { json = JSON.parse(raw); } catch { return { ok: false, error: `${RELEASE_MANIFEST} 가 JSON 이 아님` }; }
    const parsed = parseReleaseManifest(json);
    return parsed.ok ? parsed : { ok: false, error: `${RELEASE_MANIFEST} 가 올바르지 않음: ${parsed.errors.join('; ')}` };
  };
  return {
    async latest(arch: string): Promise<{ ok: true; value: LatestRelease } | { ok: false; status: 400 | 404 | 500; error: string }> {
      if (!(RELEASE_ARCHES as readonly string[]).includes(arch)) return { ok: false, status: 400, error: `arch 는 ${RELEASE_ARCHES.join('|')}` };
      const m = await manifest();
      if (!m.ok) return { ok: false, status: m.error.startsWith('배포된') ? 404 : 500, error: m.error };
      const f = m.value.files.find((x) => x.arch === arch);
      if (!f) return { ok: false, status: 404, error: `${m.value.version} 에 ${arch} 배포본이 없음` };
      return { ok: true, value: { version: m.value.version, ...(m.value.releasedAt ? { releasedAt: m.value.releasedAt } : {}), arch: f.arch, name: f.name, sha256: f.sha256, size: f.size, url: `/studio/releases/files/${encodeURIComponent(f.name)}` } };
    },
    /** 목록에 적힌 파일만. 크기가 목록과 다르면(복사 중·잘못 바꿔 낌) 주지 않는다 */
    async file(name: string): Promise<{ path: string; size: number } | undefined> {
      const m = await manifest();
      const f = m.ok ? m.value.files.find((x) => x.name === name) : undefined;
      if (!f) return undefined;
      const p = path.join(root, f.name);
      const st = await stat(p).catch(() => undefined);
      return st?.isFile() && st.size === f.size ? { path: p, size: st.size } : undefined;
    },
    stream: (p: string) => createReadStream(p),
  };
}
export type StudioReleases = ReturnType<typeof createStudioReleases>;
