// @vitest-environment node
// 작업 프로세스 번들(studio-packaging 01): 단일 ESM 파일을 리포 밖 임시 폴더에 두고 변환 플래그 없이 띄워도 ready·ping. 번들에 리포 경로가 없다.
import { describe, it, expect, afterAll, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildStudioWorker } from '../../../scripts/build-studio-worker.mjs';
import { createWorkerHost } from '../src/main/worker-host.ts';

vi.setConfig({ testTimeout: 60_000 });
const dir = mkdtempSync(path.join(os.tmpdir(), 'studio-worker-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('buildStudioWorker', () => {
  it('리포 밖에서 플래그 없이 ready, ping 은 그 Node; 리포 절대 경로 없음', async () => {
    const out = await buildStudioWorker(path.join(dir, 'worker'));
    expect(readFileSync(out, 'utf8')).not.toContain(path.resolve(import.meta.dirname, '../../..'));
    const host = createWorkerHost({ node: process.execPath, script: out, execArgv: ['--no-warnings=ExperimentalWarning'], env: { HOME: dir, PATH: process.env.PATH ?? '' } });
    try {
      await host.ready();
      expect((await host.ping()).node).toBe(process.version);
    } finally { await host.stop(); }
  });
});
