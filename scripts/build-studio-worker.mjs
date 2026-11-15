/**
 * Studio 작업 프로세스 번들(studio-packaging 01): apps/studio/src/worker/index.ts → <outDir>/worker.mjs 단일 ESM 파일.
 * 설치본은 이 파일을 동봉 Node 로 변환 플래그 없이 띄운다. external: `usb`(네이티브, 옆 node_modules 에서 해석).
 * 가드: 리포 절대 경로·__dirname/__filename 이 남으면 실패(build-bundles.mjs 와 같은 목적).
 *
 * 사용: node scripts/build-studio-worker.mjs [--out <dir>]
 */
import { build } from 'esbuild';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export async function buildStudioWorker(outDir) {
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const outfile = path.join(outDir, 'worker.mjs');
  await build({
    entryPoints: [path.join(root, 'apps/studio/src/worker/index.ts')],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    external: ['usb'],
    // CJS 의존성(require)이 ESM 번들에서 돌도록
    banner: { js: "import { createRequire as __sinclairCreateRequire } from 'node:module'; const require = __sinclairCreateRequire(import.meta.url);" },
    define: { 'process.env.SINCLAIR_BUNDLED': '"1"' },
    logLevel: 'warning',
  });
  const text = readFileSync(outfile, 'utf8');
  const problems = [];
  if (text.includes(root)) problems.push(`리포 절대 경로(${root}) 포함`);
  if (/\b__dirname\b|\b__filename\b/.test(text)) problems.push('__dirname/__filename 사용(ESM 번들에서 ReferenceError)');
  if (problems.length) throw new Error(`작업 프로세스 번들 가드 실패: ${problems.join(', ')}`);
  return outfile;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf('--out');
  const out = path.resolve(root, i >= 0 ? process.argv[i + 1] : 'apps/studio/dist-worker');
  console.log(await buildStudioWorker(out));
}
