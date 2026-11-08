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
import { readFileSync, readdirSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
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
  writeFileSync(path.join(dir, 'hooks.mjs'), HOOKS);
  // 가드: 소스 트리 절대 경로가 번들에 남아 있으면 리포 밖에서 깨진다
  const leaked = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.mjs')) continue;
    const text = readFileSync(path.join(dir, name), 'utf8');
    if (text.includes(root)) leaked.push(name);
  }
  if (leaked.length) throw new Error(`번들에 리포 절대 경로(${root})가 남음: ${leaked.join(', ')} — import.meta.url/__dirname 로 소스 트리를 가리키는 자산 참조를 resourcesDir() 로 바꾼다`);
  return { outdir: dir, outputs: Object.keys(result.metafile.outputs).map((p) => path.basename(p)) };
}

const HOOKS = `// node:module resolve 훅: 사용자 테스트 파일의 '@sinclair/runner' 를 번들의 runner.mjs 로 넘긴다(에이전트와 같은 모듈 인스턴스).
const RUNNER = new URL('./runner.mjs', import.meta.url).href;
export async function resolve(specifier, context, next) {
  if (specifier === '@sinclair/runner') return { url: RUNNER, shortCircuit: true };
  return next(specifier, context);
}
`;

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { outputs } = await buildBundles();
  console.log(`bundled → ${path.relative(root, outdir)}/: ${outputs.filter((o) => o.endsWith('.mjs')).join(', ')}`);
}
