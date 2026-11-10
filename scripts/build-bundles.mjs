/**
 * control-plane·runner-agent 를 리포 밖에서도 도는 ESM 번들로 만든다(esbuild, 코드 스플리팅).
 *
 * 산출물(dist/):
 *   control-plane.mjs      서버 CLI 엔트리
 *   runner-agent.mjs       에이전트 CLI 엔트리
 *   runner.mjs             사용자 테스트 파일이 쓰는 `@sinclair/runner` 공개 API(에이전트와 같은 청크를 공유해 test() 레지스트리가 하나다)
 *   hooks.mjs              node:module resolve 훅: 테스트 파일의 '@sinclair/runner' → runner.mjs
 *   chunk-*.mjs            공유 코드(protocol 등 — 단일 인스턴스라 instanceof 가 어긋나지 않는다)
 *
 * external: `usb`(네이티브, 번들 옆 node_modules 에서 해석; 02 배포본이 넣는다). 그 밖의 의존성은 전부 들어간다.
 * 가드: 번들에 리포 절대 경로가 남으면 실패한다(소스 트리 경로를 하드코딩한 자산 참조를 잡는다).
 *
 * 사용: node scripts/build-bundles.mjs [--out dist]
 */
import { build } from 'esbuild';
import { readFileSync, readdirSync, copyFileSync, mkdirSync, rmSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outArg = process.argv.indexOf('--out');
const outdir = path.resolve(root, outArg >= 0 ? process.argv[outArg + 1] : 'dist');

export async function buildBundles(dir = outdir) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const result = await build({
    entryPoints: {
      'control-plane': path.join(root, 'apps/control-plane/src/cli.ts'),
      'runner-agent': path.join(root, 'apps/runner-agent/src/cli.ts'),
      runner: path.join(root, 'packages/runner/src/index.ts'),
    },
    outdir: dir,
    bundle: true,
    splitting: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    outExtension: { '.js': '.mjs' },
    chunkNames: 'chunk-[hash]',
    external: ['usb'],
    define: { 'process.env.SINCLAIR_BUNDLED': '"1"' },
    logLevel: 'warning',
    metafile: true,
  });
  copyFileSync(path.join(root, 'apps/runner-agent/src/hooks.mjs'), path.join(dir, 'hooks.mjs'));
  guardBundles(dir);
  return { outdir: dir, outputs: Object.keys(result.metafile.outputs).map((p) => path.basename(p)) };
}

/**
 * 번들 가드. 리포 밖에서 깨질 참조를 빌드 시점에 잡는다(EverMock proxy-worker 번들의 `__dirname` 가드와 같은 목적).
 *  - 리포 절대 경로: 소스 트리를 가리키는 자산 참조.
 *  - `__dirname`/`__filename`: ESM 번들에는 없어 ReferenceError 가 된다(CJS 의존성이 파일 자산을 읽는 신호).
 *  - `import.meta.url` 사용 수: 아래 허용 목록만. 새 사용처(= 새 파일 자산)가 생기면 여기 목록과 02 배포본 구성을 함께 갱신한다.
 */
const IMPORT_META_URL_ALLOWED = [
  'apps/runner-agent/src/hooks.mjs (runner.mjs 위치)',
  'apps/runner-agent/src/cli.ts (훅 등록)',
  'apps/runner-agent/src/resources.ts (resources/ 위치)',
  'packages/device-layer/src/android/android-backend.ts (개발용 APK 경로, 번들에선 존재하지 않는 경로가 되어 무시됨)',
  'apps/runner-agent/src/helper-apk.ts (개발용 리포 빌드 경로, isBundled() 가 접혀 번들에서는 쓰이지 않음)',
  'apps/control-plane/src/config.ts (resources/console 위치 — 설치본의 Console 정적 파일, dist/ 의 형제)',
];
function guardBundles(dir) {
  const problems = [];
  let importMetaUrlUses = 0;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.mjs') || name === 'hooks.mjs') continue;
    const text = readFileSync(path.join(dir, name), 'utf8');
    if (text.includes(root)) problems.push(`${name}: 리포 절대 경로(${root}) 포함`);
    if (/\b__dirname\b|\b__filename\b/.test(text)) problems.push(`${name}: __dirname/__filename 사용(ESM 번들에서 ReferenceError)`);
    importMetaUrlUses += (text.match(/import\.meta\.url/g) ?? []).length;
  }
  const allowed = IMPORT_META_URL_ALLOWED.length - 1; // hooks.mjs 는 검사에서 뺐다
  if (importMetaUrlUses > allowed) problems.push(`import.meta.url 사용처가 ${importMetaUrlUses}곳(허용 ${allowed}): 새 파일 자산 참조가 생겼다. IMPORT_META_URL_ALLOWED 와 배포본 구성을 갱신`);
  if (problems.length) throw new Error(`번들 가드 실패:\n  ${problems.join('\n  ')}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { outputs } = await buildBundles();
  console.log(`bundled → ${path.relative(root, outdir)}/: ${outputs.filter((o) => o.endsWith('.mjs')).join(', ')}`);
}
