// 작업 프로세스 실행 방식(studio-packaging 01): 리포는 시스템 node + TS 원본(변환 플래그), 설치본은 동봉 Node + 단일 번들(플래그 없음)·동봉 헬퍼 APK.
import { describe, it, expect } from 'vitest';
import { workerLaunch } from '../src/main/worker-launch.ts';

describe('workerLaunch', () => {
  it('리포 실행: SINCLAIR_STUDIO_NODE 또는 node, out/main/worker.js, --experimental-transform-types', () => {
    expect(workerLaunch({ packaged: false, mainDir: '/repo/apps/studio/out/main', resourcesPath: '/x', env: {} })).toEqual({
      node: 'node', script: '/repo/apps/studio/out/main/worker.js', execArgv: ['--experimental-transform-types', '--no-warnings=ExperimentalWarning'], env: {},
    });
    expect(workerLaunch({ packaged: false, mainDir: '/m', resourcesPath: '/x', env: { SINCLAIR_STUDIO_NODE: '/opt/node' } }).node).toBe('/opt/node');
  });

  it('설치본: Resources/node/node, Resources/worker/worker.mjs, 변환 플래그 없음, 동봉 헬퍼 APK(이미 지정됐으면 그대로)', () => {
    const r = workerLaunch({ packaged: true, mainDir: '/A/app.asar/out/main', resourcesPath: '/A/Resources', env: {}, helperApk: 'sinclair-helper-0.1.0.apk' });
    expect(r).toEqual({ node: '/A/Resources/node/node', script: '/A/Resources/worker/worker.mjs', execArgv: ['--no-warnings=ExperimentalWarning'], env: { SINCLAIR_STUDIO_HELPER_APK: '/A/Resources/helper/sinclair-helper-0.1.0.apk' } });
    expect(workerLaunch({ packaged: true, mainDir: '/m', resourcesPath: '/A/Resources', env: { SINCLAIR_STUDIO_HELPER_APK: '/mine.apk' }, helperApk: 'h.apk' }).env).toEqual({});
  });
});
