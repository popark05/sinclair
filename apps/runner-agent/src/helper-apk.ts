// 헬퍼 APK 해석: 플래그 → 환경변수 → 에이전트 번들 리소스 → 리포 디버그 빌드(개발용) → 릴리스 URL 다운로드(sha256 사이드카 검증, 캐시).
// 각 단계의 실패 사유를 모아 로그와 오류에 남긴다. 다운로드는 Node fetch 라 사내망 CA 는 NODE_EXTRA_CA_CERTS 로 들어온다(EverMock ApkManager 와 같은 전제, 코드 공유 없음).
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

/** 에이전트가 기대하는 헬퍼 버전. android-helper 의 versionName 과 같이 올린다(README "릴리스") */
export const HELPER_APK_VERSION = '0.1.0';
export const helperApkFileName = (version = HELPER_APK_VERSION): string => `sinclair-helper-${version}.apk`;

export class HelperApkError extends Error {}

export type HelperApkSource = 'flag' | 'env' | 'bundled' | 'repo-build' | 'cache' | 'download';

export interface ResolveHelperApkOptions {
  /** --helper-apk */
  flag?: string;
  /** SINCLAIR_AGENT_HELPER_APK(파일), SINCLAIR_AGENT_HELPER_URL(릴리스 base URL) */
  env: NodeJS.ProcessEnv;
  /** 에이전트와 함께 배포되는 리소스 디렉터리. 기본 apps/runner-agent/resources/helper */
  bundledDir?: string;
  /** 리포 체크아웃의 디버그 빌드(개발 전용). 기본 packages/device-layer/android-helper 의 app-debug.apk */
  repoBuild?: string;
  /** 다운로드 캐시. 기본 OS 데이터 디렉터리/sinclair/cache/helper */
  cacheDir: string;
  fetch?: typeof fetch;
  log?: (line: string) => void;
}

const here = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_BUNDLED_DIR = path.resolve(here, '..', 'resources', 'helper');
export const DEFAULT_REPO_BUILD = path.resolve(here, '..', '..', '..', 'packages', 'device-layer', 'android-helper', 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk');

const sha256 = (buf: Buffer): string => createHash('sha256').update(buf).digest('hex');

export async function resolveHelperApk(opts: ResolveHelperApkOptions): Promise<{ path: string; source: HelperApkSource }> {
  const log = opts.log ?? (() => {});
  const reasons: string[] = [];
  const found = (p: string, source: HelperApkSource) => { log(`헬퍼 APK: ${p} (${source})`); return { path: p, source }; };
  const tryFile = (p: string | undefined, source: HelperApkSource, label: string) => {
    if (!p) { reasons.push(`${source}: ${label} 없음`); return undefined; }
    if (fs.existsSync(p)) return found(p, source);
    reasons.push(`${source}: ${p} 없음`);
    return undefined;
  };

  const direct = tryFile(opts.flag, 'flag', '--helper-apk 미지정') ?? tryFile(opts.env.SINCLAIR_AGENT_HELPER_APK, 'env', 'SINCLAIR_AGENT_HELPER_APK 미설정')
    ?? tryFile(path.join(opts.bundledDir ?? DEFAULT_BUNDLED_DIR, helperApkFileName()), 'bundled', '번들') ?? tryFile(opts.repoBuild ?? DEFAULT_REPO_BUILD, 'repo-build', '리포 빌드');
  if (direct) return direct;

  const base = opts.env.SINCLAIR_AGENT_HELPER_URL?.replace(/\/$/, '');
  if (!base) {
    reasons.push('download: 릴리스 URL 없음(SINCLAIR_AGENT_HELPER_URL)');
    throw new HelperApkError(`헬퍼 APK 를 찾지 못함:\n  ${reasons.join('\n  ')}`);
  }
  const doFetch = opts.fetch ?? fetch;
  const name = helperApkFileName();
  const target = path.join(opts.cacheDir, name);
  const cachedSidecar = `${target}.sha256`;

  // 캐시에 APK 와 사이드카가 함께 있고 서로 맞으면 네트워크 없이 쓴다(오프라인 노드)
  if (fs.existsSync(target) && fs.existsSync(cachedSidecar)) {
    const want = fs.readFileSync(cachedSidecar, 'utf8').trim().slice(0, 64).toLowerCase();
    if (/^[0-9a-f]{64}$/.test(want) && sha256(fs.readFileSync(target)) === want) return found(target, 'cache');
    log(`헬퍼 APK 캐시가 사이드카와 달라 다시 받음: ${target}`);
  }

  // 사이드카를 먼저 받는다: 검증할 수 없는 APK 는 받지 않는다
  let expected: string;
  try {
    const res = await doFetch(`${base}/${name}.sha256`);
    if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
    const text = (await res.text()).trim();
    const m = /^[0-9a-f]{64}/i.exec(text);
    if (!m) throw new Error(`형식이 아님: ${text.slice(0, 40)}`);
    expected = m[0].toLowerCase();
  } catch (err) {
    reasons.push(`download: sha256 사이드카(${base}/${name}.sha256) 실패: ${err instanceof Error ? err.message : String(err)}`);
    throw new HelperApkError(`헬퍼 APK 를 찾지 못함:\n  ${reasons.join('\n  ')}`);
  }

  if (fs.existsSync(target) && sha256(fs.readFileSync(target)) === expected) { fs.writeFileSync(cachedSidecar, expected); return found(target, 'cache'); }

  let bytes: Buffer;
  try {
    const res = await doFetch(`${base}/${name}`);
    if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
    bytes = Buffer.from(await res.arrayBuffer());
  } catch (err) {
    reasons.push(`download: ${base}/${name} 실패: ${err instanceof Error ? err.message : String(err)}`);
    throw new HelperApkError(`헬퍼 APK 를 찾지 못함:\n  ${reasons.join('\n  ')}`);
  }
  const actual = sha256(bytes);
  if (actual !== expected) throw new HelperApkError(`헬퍼 APK sha256 불일치: 기대 ${expected}, 실제 ${actual} (${base}/${name})`);
  fs.mkdirSync(opts.cacheDir, { recursive: true });
  const tmp = `${target}.part`;
  fs.writeFileSync(tmp, bytes);
  fs.renameSync(tmp, target); // 부분 파일이 캐시로 남지 않게
  fs.writeFileSync(cachedSidecar, expected);
  return found(target, 'download');
}
