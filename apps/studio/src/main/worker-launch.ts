// 작업 프로세스 실행 방식(studio-packaging 01). 리포: 시스템 node 로 electron-vite 가 만든 worker.js(워크스페이스 TS 원본을 변환하며 불러온다).
// 설치본: Resources/node/node(고정 버전) 로 Resources/worker/worker.mjs(esbuild 단일 번들, usb 는 옆 node_modules). asar 밖 — plain Node 는 asar 를 못 읽는다.
import * as path from 'node:path';
import { resolveWorkerNode, WORKER_EXEC_ARGV } from './worker-host.ts';

export interface WorkerLaunchInput {
  packaged: boolean;
  /** 메인 번들 폴더(out/main) */
  mainDir: string;
  /** process.resourcesPath */
  resourcesPath: string;
  env: NodeJS.ProcessEnv;
  /** 설치본에 동봉한 헬퍼 APK 파일 이름(Resources/helper/) */
  helperApk?: string;
}
export interface WorkerLaunch { node: string; script: string; execArgv: string[]; env: Record<string, string> }

export function workerLaunch(i: WorkerLaunchInput): WorkerLaunch {
  if (!i.packaged) return { node: resolveWorkerNode(i.env), script: path.join(i.mainDir, 'worker.js'), execArgv: WORKER_EXEC_ARGV, env: {} };
  const node = path.join(i.resourcesPath, 'node', process.platform === 'win32' ? 'node.exe' : 'node');
  return {
    node: i.env.SINCLAIR_STUDIO_NODE || node,
    script: path.join(i.resourcesPath, 'worker', 'worker.mjs'),
    execArgv: ['--no-warnings=ExperimentalWarning'],
    env: i.helperApk && !i.env.SINCLAIR_STUDIO_HELPER_APK ? { SINCLAIR_STUDIO_HELPER_APK: path.join(i.resourcesPath, 'helper', i.helperApk) } : {},
  };
}
