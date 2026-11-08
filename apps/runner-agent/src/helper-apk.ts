// 헬퍼 APK 해석: 플래그 → 환경변수 → 에이전트 번들 리소스 → 리포 디버그 빌드(개발용) → 릴리스 URL 다운로드(sha256 사이드카 검증, 캐시).
// 각 단계의 실패 사유를 모아 로그와 오류에 남긴다. 다운로드는 Node fetch 라 사내망 CA 는 NODE_EXTRA_CA_CERTS 로 들어온다(EverMock ApkManager 와 같은 전제, 코드 공유 없음).
// 경로 기본값은 소스 트리 배치를 전제한다(import.meta.url 기준). 설치형 번들은 패키징 티켓에서 다시 잡는다.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

/** 에이전트가 기대하는 헬퍼 버전. android-helper 의 versionName 과 같이 올린다(README "릴리스"). 같은 버전 문자열로 재릴리스하면 캐시가 갱신되지 않는다 */
export const HELPER_APK_VERSION = '0.1.0';
export const helperApkFileName = (version = HELPER_APK_VERSION): string => `sinclair-helper-${version}.apk`;

export class HelperApkError extends Error {}

export type HelperApkSource = 'flag' | 'env' | 'bundled' | 'repo-build' | 'cache' | 'download';
export interface ResolvedHelperApk { path: string; source: HelperApkSource }

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
/** 사내 호스트가 죽어 있을 때 데몬이 USB 전 단계에서 영영 멈추지 않도록. 1 MB 남짓한 APK 라 넉넉하다 */
const FETCH_TIMEOUT_MS = 30_000;

const sha256 = (buf: Buffer): string => createHash('sha256').update(buf).digest('hex');
const HEX64 = /^[0-9a-f]{64}/i;

export async function resolveHelperApk(opts: ResolveHelperApkOptions): Promise<ResolvedHelperApk> {
  const log = opts.log ?? (() => {});
  const reasons: string[] = [];
  const giveUp = () => new HelperApkError(`헬퍼 APK 를 찾지 못함:\n  ${reasons.join('\n  ')}`);
  const use = (p: string, source: HelperApkSource): ResolvedHelperApk => { log(`헬퍼 APK: ${p} (${source})`); return { path: p, source }; };

  const local = findLocal(opts, reasons);
  if (local) return use(local.path, local.source);

  const base = opts.env.SINCLAIR_AGENT_HELPER_URL?.replace(/\/$/, '');
  if (!base) { reasons.push('download: 릴리스 URL 없음(SINCLAIR_AGENT_HELPER_URL)'); throw giveUp(); }
  const name = helperApkFileName();
  const target = path.join(opts.cacheDir, name);
  const sidecar = `${target}.sha256`;

  if (cacheVerifies(target, sidecar)) return use(target, 'cache');

  const doFetch = opts.fetch ?? fetch;
  const get = async (url: string): Promise<Response> => {
    const res = await doFetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
    return res;
  };

  // 사이드카를 먼저 받는다: 검증할 수 없는 APK 는 받지 않는다
  let expected: string;
  try {
    const text = (await (await get(`${base}/${name}.sha256`)).text()).trim();
    const m = HEX64.exec(text);
    if (!m) throw new Error(`형식이 아님: ${text.slice(0, 40)}`);
    expected = m[0].toLowerCase();
  } catch (err) {
    reasons.push(`download: sha256 사이드카(${base}/${name}.sha256) 실패: ${err instanceof Error ? err.message : String(err)}`);
    throw giveUp();
  }
  if (fs.existsSync(target) && sha256(fs.readFileSync(target)) === expected) { fs.writeFileSync(sidecar, expected); return use(target, 'cache'); }
  if (fs.existsSync(target)) log(`헬퍼 APK 캐시가 사이드카와 달라 다시 받음: ${target}`);

  let bytes: Buffer;
  try {
    bytes = Buffer.from(await (await get(`${base}/${name}`)).arrayBuffer());
  } catch (err) {
    reasons.push(`download: ${base}/${name} 실패: ${err instanceof Error ? err.message : String(err)}`);
    throw giveUp();
  }
  const actual = sha256(bytes);
  if (actual !== expected) throw new HelperApkError(`헬퍼 APK sha256 불일치: 기대 ${expected}, 실제 ${actual} (${base}/${name})`);
  fs.mkdirSync(opts.cacheDir, { recursive: true });
  const part = `${target}.part`;
  fs.writeFileSync(part, bytes);
  fs.renameSync(part, target); // 부분 파일이 캐시로 남지 않게
  fs.writeFileSync(sidecar, expected);
  return use(target, 'download');
}

/** 플래그 → env → 번들 → 리포 빌드 중 처음 존재하는 파일. 없으면 reasons 에 사유를 더하고 undefined */
function findLocal(opts: ResolveHelperApkOptions, reasons: string[]): ResolvedHelperApk | undefined {
  const candidates: Array<[HelperApkSource, string | undefined, string]> = [
    ['flag', opts.flag, '--helper-apk 미지정'],
    ['env', opts.env.SINCLAIR_AGENT_HELPER_APK, 'SINCLAIR_AGENT_HELPER_APK 미설정'],
    ['bundled', path.join(opts.bundledDir ?? DEFAULT_BUNDLED_DIR, helperApkFileName()), '번들'],
    ['repo-build', opts.repoBuild ?? DEFAULT_REPO_BUILD, '리포 빌드'],
  ];
  for (const [source, p, missingLabel] of candidates) {
    if (!p) { reasons.push(`${source}: ${missingLabel} 없음`); continue; }
    if (fs.existsSync(p)) return { path: p, source };
    reasons.push(`${source}: ${p} 없음`);
  }
  return undefined;
}

/** 캐시에 APK 와 사이드카가 함께 있고 서로 맞으면 네트워크 없이 쓴다(오프라인 노드) */
function cacheVerifies(target: string, sidecar: string): boolean {
  if (!fs.existsSync(target) || !fs.existsSync(sidecar)) return false;
  const want = fs.readFileSync(sidecar, 'utf8').trim().slice(0, 64).toLowerCase();
  return /^[0-9a-f]{64}$/.test(want) && sha256(fs.readFileSync(target)) === want;
}
