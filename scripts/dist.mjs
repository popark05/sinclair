/**
 * 플랫폼별 설치 배포본을 조립한다: release/sinclair-<version>-<target>.zip
 *
 * 레이아웃(.scratch/packaging/issues/02 의 계약):
 *   bin/sinclair-control-plane(.cmd), bin/sinclair-agent(.cmd)   런처 — 동봉 Node 로 dist/<app>.mjs 실행(플래그는 --no-warnings=ExperimentalWarning 만)
 *   node/node(.exe), node/LICENSE                               고정 버전 Node(SHASUMS256.txt 검증)
 *   dist/*.mjs                                                   build-bundles.mjs 산출물(한 디렉터리)
 *   node_modules/usb, node_modules/@node-usb/usb-<platform>      네이티브 USB(번들에서 external)
 *   resources/helper/sinclair-helper-<V>.apk(+.sha256)          헬퍼 APK(리포 빌드에서 복사, 없으면 실패)
 *   VERSION, README.md
 *
 * 사용: node scripts/dist.mjs [--targets mac-arm64,mac-x64,win-x64,win-arm64 | all] [--out release] [--node-binary <path>] [--no-zip]
 *   --node-binary: 다운로드 대신 주어진 Node 실행 파일을 쓴다(호스트 타깃 하나, 테스트·오프라인용). LICENSE 는 <prefix>/LICENSE 에서 찾고 없으면 --node-license 로 준다.
 * 사내망이면 NODE_EXTRA_CA_CERTS 로 nodejs.org 다운로드가 된다. EverMock fetch-node 와 같은 설계(코드 공유 없음).
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync, readdirSync, copyFileSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildBundles } from './build-bundles.mjs';
import { ensureUsbPackage, USB_PACKAGE_DIR, USB_PLATFORM_PACKAGES } from './fetch-usb-binaries.mjs';
// 헬퍼 버전·파일명·리포 빌드 경로는 에이전트 소스가 단일 출처다(Node 22.18+ 타입 스트리핑으로 .ts 를 그대로 읽는다)
import { HELPER_APK_VERSION, helperApkFileName, DEFAULT_REPO_BUILD } from '../apps/runner-agent/src/helper-apk.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 동봉 Node. 22.18+ 면 되지만(node:sqlite, 네이티브 타입 스트리핑) 24 LTS 계열로 고정해 호스트 개발 환경과 맞춘다 */
export const NODE_VERSION = '24.13.0';
export const NODE_DIST_BASE = 'https://nodejs.org/dist';
/** 타깃 → Node 배포 파일 접미사와 압축 형식 */
export const TARGETS = {
  'mac-arm64': { node: 'darwin-arm64', archive: 'tar.gz', exe: 'node', win: false },
  'mac-x64': { node: 'darwin-x64', archive: 'tar.gz', exe: 'node', win: false },
  'win-x64': { node: 'win-x64', archive: 'zip', exe: 'node.exe', win: true },
  'win-arm64': { node: 'win-arm64', archive: 'zip', exe: 'node.exe', win: true },
};
export { HELPER_APK_VERSION };
const HELPER_REPO_BUILD = DEFAULT_REPO_BUILD;
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
/** nodejs.org 다운로드 상한. Node 배포 파일은 30~50 MB 라 사내 회선에서도 2분이면 넉넉하고, 끊긴 프록시에서 영영 매달리지 않는다 */
const NODE_FETCH_TIMEOUT_MS = 120_000;

export function defaultCacheDir(env = process.env, platform = process.platform) {
  const home = env.HOME ?? env.USERPROFILE ?? '.';
  const base = platform === 'darwin' ? path.join(home, 'Library', 'Caches') : platform === 'win32' ? (env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local')) : (env.XDG_CACHE_HOME ?? path.join(home, '.cache'));
  return path.join(base, 'sinclair', 'node');
}

/**
 * 고정 버전 Node 를 받아(SHASUMS256.txt 로 검증) 캐시에 풀고 { exe, license } 경로를 돌려준다. 캐시에 있으면 네트워크 없음.
 * 무결성은 HTTPS 로 받은 SHASUMS256.txt 를 신뢰한다(.sig 서명 검증은 하지 않는다 — 사내 빌드 머신 전제). 테스트는 base/fetch 를 바꿔 끼운다.
 */
export async function fetchNode(target, { version = NODE_VERSION, base = NODE_DIST_BASE, cacheDir = defaultCacheDir(), fetch: doFetch = fetch } = {}) {
  const spec = TARGETS[target];
  if (!spec) throw new Error(`알 수 없는 대상: ${target}`);
  const dirName = `node-v${version}-${spec.node}`;
  const extracted = path.join(cacheDir, dirName);
  const exe = spec.win ? path.join(extracted, spec.exe) : path.join(extracted, 'bin', spec.exe);
  const license = path.join(extracted, 'LICENSE');
  if (existsSync(exe) && existsSync(license)) return { exe, license, fromCache: true };

  const file = `${dirName}.${spec.archive}`;
  const getOk = async (url) => {
    let res;
    try { res = await doFetch(url, { signal: AbortSignal.timeout(NODE_FETCH_TIMEOUT_MS) }); }
    catch (err) { throw new Error(`${url}: ${err instanceof Error ? err.message : String(err)}${err?.cause?.message ? ` (${err.cause.message})` : ''}`); }
    if (res.status !== 200) throw new Error(`${url}: HTTP ${res.status}`);
    return res;
  };
  const sums = await (await getOk(`${base}/v${version}/SHASUMS256.txt`)).text();
  const expected = sums.split('\n').map((l) => l.trim().split(/\s+/)).find(([, name]) => name === file)?.[0];
  if (!expected) throw new Error(`SHASUMS256.txt 에 ${file} 이 없음`);
  const bytes = Buffer.from(await (await getOk(`${base}/v${version}/${file}`)).arrayBuffer());
  const actual = sha256(bytes);
  if (actual !== expected) throw new Error(`Node 배포 파일 sha256 불일치(${file}): 기대 ${expected}, 실제 ${actual}`);
  mkdirSync(cacheDir, { recursive: true });
  const archive = path.join(cacheDir, file);
  writeFileSync(archive, bytes);
  rmSync(extracted, { recursive: true, force: true });
  // bsdtar(macOS·Windows 10+) 는 zip 도 푼다
  execFileSync('tar', ['-xf', archive, '-C', cacheDir]);
  if (!existsSync(exe)) throw new Error(`Node 압축을 풀었지만 실행 파일이 없음: ${exe}`);
  return { exe, license, fromCache: false };
}

function launcherSh(app) {
  return `#!/bin/sh
# Sinclair ${app} 런처. 이 디렉터리 구조(bin/, node/, dist/)를 전제한다.
DIR=$(cd "$(dirname "$0")/.." && pwd)
exec "$DIR/node/node" --no-warnings=ExperimentalWarning "$DIR/dist/${app}.mjs" "$@"
`;
}
function launcherCmd(app) {
  return `@echo off\r\nrem Sinclair ${app} 런처. 이 디렉터리 구조(bin\\, node\\, dist\\)를 전제한다.\r\nset "DIR=%~dp0.."\r\n"%DIR%\\node\\node.exe" --no-warnings=ExperimentalWarning "%DIR%\\dist\\${app}.mjs" %*\r\nexit /b %ERRORLEVEL%\r\n`;
}

function windowsNotes() {
  return `
## Windows
- 실행: \`bin\\sinclair-control-plane.cmd\`, \`bin\\sinclair-agent.cmd\` (PowerShell·cmd 어디서나; 인자와 환경변수는 그대로 전달되고 종료 코드가 보존된다).
- 데이터 디렉터리: \`%APPDATA%\\sinclair\` (DB·스풀·헬퍼 캐시). 설치 디렉터리에는 쓰지 않는다.
- USB: 직접 USB 연결(기본)은 기기에 **WinUSB 드라이버**가 필요하다(Zadig 등으로 "Android ADB Interface" 를 WinUSB 로 바꾼다). 제조사 ADB 드라이버가 잡혀 있거나 adb 서버가 떠 있으면 인터페이스를 못 잡아 "기기 없음" 으로 보인다 — \`adb kill-server\` 를 먼저 한다. adb 서버 경유 모드는 아직 에이전트 옵션으로 노출돼 있지 않다.
- 신호: Windows 에는 SIGTERM 이 없다. 데몬은 Ctrl-C(SIGINT)로 "진행 중 run 을 마치고" 멈추고, 작업 관리자 종료처럼 강제 종료되면 run 의 스풀이 남아 다음 \`sinclair-agent resume\` 이 이어 보낸다.
- 스풀 lock: 같은 머신의 다른 프로세스가 쓰는 스풀은 pid 로 판별한다. pid 가 재사용되면 잘못 "사용 중" 으로 보일 수 있으니 그런 스풀은 \`.lock\` 파일을 지우고 \`resume\` 한다.
- 방화벽: 서버는 기본 127.0.0.1 에만 바인딩하므로 규칙이 필요 없다. 다른 노드에서 접근하려면 \`--host 0.0.0.0\` 과 방화벽 허용이 필요하고, 인증이 없으므로 신뢰망 안에서만.
- 이 배포본은 macOS 에서 교차 빌드됐다. 실행 검증은 Windows 머신에서 체크리스트(.scratch/packaging/windows-checklist.md)로 한다.
`;
}

function readme(version, target, sizeMb) {
  return `# Sinclair ${version} (${target})

설치 크기 약 ${sizeMb} MB(압축 전).

사내 QA 용 E2E 검증 플랫폼의 control-plane(API 서버)과 runner-agent(기기 노드 에이전트) 설치본. Node ${NODE_VERSION} 을 동봉하므로 따로 설치할 것이 없다.

## 실행
- 서버: \`bin/sinclair-control-plane --port 4780 --db <경로>\` (기본 저장소 SQLite, 데이터는 OS 데이터 디렉터리/sinclair)
- 에이전트: \`bin/sinclair-agent run --control-plane http://<서버>:4780 --cycle <id> --target <id> --tests <디렉터리> --device <시리얼>\`
- 데몬: \`bin/sinclair-agent daemon --control-plane … --targets android --tests <디렉터리>\`
- 도움말: 각 명령에 \`--help\`

## 구성
bin/(런처) · node/(Node ${NODE_VERSION} + LICENSE) · dist/(앱 번들) · node_modules/(USB 네이티브 모듈) · resources/helper/(Android 헬퍼 APK ${HELPER_APK_VERSION} + sha256) · VERSION

## 설치
zip 을 원하는 곳에 푼다(예: \`/opt/sinclair/<version>\`, \`C:\\sinclair\\<version>\`). 설치 디렉터리에는 아무것도 쓰지 않으므로 읽기 전용이어도 된다.

## 데이터 디렉터리
서버 DB·에이전트 스풀·헬퍼 APK 캐시는 설치 디렉터리 밖, OS 데이터 디렉터리의 \`sinclair/\` 아래에 둔다: macOS \`~/Library/Application Support/sinclair\`, Windows \`%APPDATA%\\sinclair\`, Linux \`$XDG_DATA_HOME/sinclair\`(\`control-plane.db\`, \`spool/\`, \`cache/helper/\`). \`--db\`, \`--spool\`, \`--helper-cache\` 또는 같은 이름의 환경변수로 바꿀 수 있다.

## 업그레이드
새 zip 을 다른 디렉터리에 풀고 런처만 바꿔 실행한다. 데이터 디렉터리는 그대로라 지난 Cycle/Run 이 보인다(DB 스키마는 기동 시 자동으로 올라가며, 더 새로운 버전의 DB 는 이전 버전이 열지 않는다). 스풀에 남은 이벤트는 새 버전의 \`bin/sinclair-agent resume\` 이 이어 보낸다.

## 제거
설치 디렉터리를 지운다. 데이터까지 지우려면 데이터 디렉터리의 \`sinclair/\` 도 지운다. 기기의 헬퍼는 \`adb uninstall io.sinclair.helper\`.

## 알려진 한계
- 코드 서명·공증 없음(사내 배포 전제). macOS 는 아래 격리 속성 제거가 필요하다.
- Windows 배포본은 교차 빌드만 돼 있고 실행 검증은 별도 체크리스트(packaging 04)로 한다.
- 한 머신에 에이전트를 여럿 띄우면 \`--agent\` 로 서로 다른 id 를 준다.

## macOS 첫 실행
서명되지 않은 배포본이라 격리 속성을 지운다: \`xattr -dr com.apple.quarantine <이 디렉터리>\`. 그래도 막히면 시스템 설정 > 개인정보 보호 및 보안에서 허용한다.
${TARGETS[target].win ? windowsNotes() : ''}

## 사내망(SSL 인터셉션)
헬퍼 APK 를 릴리스 URL 에서 받게 하려면(\`SINCLAIR_AGENT_HELPER_URL\`) 사내 CA 번들을 \`NODE_EXTRA_CA_CERTS\` 로 준다. 이 배포본은 APK 를 동봉하므로 기본 설정에서는 네트워크가 필요 없다.

## Android 기기
USB 디버깅을 켜고 처음 연결 시 기기에서 "USB 디버깅 허용" 을 승인한다. adb 서버가 떠 있으면 USB 인터페이스를 점유하므로 \`adb kill-server\` 를 먼저 한다. 헬퍼 APK 설치·접근성 활성화는 에이전트가 자동으로 한다(Samsung Secure Folder 기기 포함).
`;
}

/**
 * 타깃 하나의 배포본을 조립한다. 돌려주는 값: { stageDir, zipPath? , files }
 * nodeBinary 를 주면 다운로드 없이 그 실행 파일을 쓴다(호스트 타깃 테스트). license 는 있으면 함께.
 */
export async function assembleDistributable({ target, outDir = path.join(root, 'release'), version = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version, nodeBinary, nodeLicense, zip = true, log = console.log, bundlesDir, nodeFetchOptions = {}, helperApk = HELPER_REPO_BUILD }) {
  const spec = TARGETS[target];
  if (!spec) throw new Error(`알 수 없는 대상: ${target} (${Object.keys(TARGETS).join(', ')})`);
  if (!helperApk || !existsSync(helperApk)) throw new Error(`헬퍼 APK 가 없음: ${helperApk ?? '(경로 없음)'}\n  packages/device-layer/android-helper 의 README 대로 ./gradlew assembleDebug 로 빌드한 뒤 다시 실행`);

  const name = `sinclair-${version}-${target}`;
  const stage = path.join(outDir, 'stage', name);
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(path.join(stage, 'bin'), { recursive: true });
  mkdirSync(path.join(stage, 'node'));
  mkdirSync(path.join(stage, 'resources', 'helper'), { recursive: true });

  // 1) 번들(한 번 만들어 재사용 가능)
  const dist = bundlesDir ?? (await buildBundles(path.join(outDir, 'stage', 'dist'))).outdir;
  cpSync(dist, path.join(stage, 'dist'), { recursive: true });

  // 2) Node
  let node;
  if (nodeBinary) {
    // 설치된 Node(nvm 등)는 <prefix>/bin/node 옆 <prefix>/LICENSE 를 가진다. 재배포에 LICENSE 는 필수라 못 찾으면 실패
    const derived = path.resolve(path.dirname(nodeBinary), '..', 'LICENSE');
    const license = nodeLicense ?? (existsSync(derived) ? derived : undefined);
    if (!license) throw new Error(`Node LICENSE 를 찾지 못함(${derived}). nodeLicense/--node-license 로 지정`);
    node = { exe: nodeBinary, license };
    log(`[node] 주어진 실행 파일 사용: ${nodeBinary}`);
  } else {
    node = await fetchNode(target, nodeFetchOptions);
    log(`[node] v${NODE_VERSION} ${spec.node} ${node.fromCache ? '(캐시)' : '(다운로드·검증)'}`);
  }
  copyFileSync(node.exe, path.join(stage, 'node', spec.exe));
  if (!spec.win) chmodSync(path.join(stage, 'node', spec.exe), 0o755);
  copyFileSync(node.license, path.join(stage, 'node', 'LICENSE'));

  // 3) usb + 플랫폼 패키지
  const usbPkg = USB_PLATFORM_PACKAGES[target];
  const platformDir = await ensureUsbPackage(target);
  cpSync(USB_PACKAGE_DIR, path.join(stage, 'node_modules', 'usb'), { recursive: true, dereference: true });
  cpSync(platformDir, path.join(stage, 'node_modules', '@node-usb', usbPkg), { recursive: true, dereference: true });

  // 4) 헬퍼 APK + 사이드카
  const apkName = helperApkFileName();
  const apk = readFileSync(helperApk);
  writeFileSync(path.join(stage, 'resources', 'helper', apkName), apk);
  writeFileSync(path.join(stage, 'resources', 'helper', `${apkName}.sha256`), `${sha256(apk)}  ${apkName}\n`);

  // 5) 런처·메타
  for (const app of ['control-plane', 'runner-agent']) {
    const binName = app === 'control-plane' ? 'sinclair-control-plane' : 'sinclair-agent';
    if (spec.win) writeFileSync(path.join(stage, 'bin', `${binName}.cmd`), launcherCmd(app));
    else { const p = path.join(stage, 'bin', binName); writeFileSync(p, launcherSh(app)); chmodSync(p, 0o755); }
  }
  writeFileSync(path.join(stage, 'VERSION'), `${version}\nnode ${NODE_VERSION}\nhelper ${HELPER_APK_VERSION}\ntarget ${target}\n`);
  writeFileSync(path.join(stage, 'README.md'), readme(version, target, (dirSize(stage) / 1024 / 1024).toFixed(0)));

  // 6) zip (-y: 심링크 보존, -q: 조용히). Windows 타깃도 mac 에서 zip 으로 만든다
  let zipPath;
  if (zip) {
    zipPath = path.join(outDir, `${name}.zip`);
    rmSync(zipPath, { force: true });
    execFileSync('zip', ['-qry', zipPath, name], { cwd: path.join(outDir, 'stage') });
    log(`[zip] ${path.relative(root, zipPath)} (${(readFileSync(zipPath).length / 1024 / 1024).toFixed(1)} MB)`);
  }
  return { stageDir: stage, zipPath, files: listFiles(stage) };
}

function dirSize(dir) {
  let total = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); total += e.isDirectory() ? dirSize(p) : statSync(p).size; }
  return total;
}

/** 구성 목록. node_modules 아래는 수천 파일이라 패키지 디렉터리 한 줄로 접는다 */
function listFiles(dir, prefix = '') {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) { if (rel.startsWith('node_modules/')) { out.push(`${rel}/`); continue; } out.push(...listFiles(path.join(dir, e.name), rel)); }
    else out.push(rel);
  }
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const targetsArg = opt('--targets');
  const hostTargets = process.platform === 'darwin' ? ['mac-arm64', 'mac-x64'] : process.platform === 'win32' ? ['win-x64', 'win-arm64'] : [];
  const targets = targetsArg === 'all' ? Object.keys(TARGETS) : targetsArg ? targetsArg.split(',').map((t) => t.trim()) : hostTargets;
  if (targets.length === 0) throw new Error('--targets 를 지정하세요');
  const outDir = path.resolve(root, opt('--out') ?? 'release');
  const nodeBinary = opt('--node-binary');
  const nodeLicense = opt('--node-license');
  if (nodeBinary && targets.length !== 1) throw new Error('--node-binary 는 타깃이 하나일 때만 쓸 수 있다(실행 파일은 플랫폼마다 다르다)');
  const bundles = await buildBundles(path.join(outDir, 'stage', 'dist'));
  for (const target of targets) {
    const result = await assembleDistributable({ target, outDir, zip: !argv.includes('--no-zip'), bundlesDir: bundles.outdir, ...(nodeBinary ? { nodeBinary } : {}), ...(nodeLicense ? { nodeLicense } : {}) });
    console.log(`[ok] ${target}: ${result.files.length}개 파일 → ${path.relative(root, result.stageDir)}`);
  }
}
