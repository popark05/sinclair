// @vitest-environment node
// createEngine(mobile): 헬퍼 APK 를 어디서도 찾지 못하면 USB 를 건드리기 전에 HelperApkError 로 실패한다(executeRun 은 이를 blocked 로 보고).
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createEngine, HelperApkError } from '../src/index.ts';

describe('createEngine(mobile) 헬퍼 APK 해석', () => {
  it('플래그 파일 없음 + 번들·리포 빌드 없음 + 릴리스 URL 없음 → 모든 사유가 든 HelperApkError, 기기 접근 전', async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'sinclair-noapk-'));
    const saved = { apk: process.env.SINCLAIR_AGENT_HELPER_APK, url: process.env.SINCLAIR_AGENT_HELPER_URL };
    delete process.env.SINCLAIR_AGENT_HELPER_APK; delete process.env.SINCLAIR_AGENT_HELPER_URL;
    const logs: string[] = [];
    const started = Date.now();
    try {
      await expect(createEngine(
        { controlPlane: 'http://127.0.0.1:1', cycle: 'c', target: 'android', tests: 'x', engine: 'mobile', spool: path.join(empty, 's'), helperApk: path.join(empty, 'none.apk'), helperCache: path.join(empty, 'cache') },
        (l) => logs.push(l), { bundledDir: path.join(empty, 'bundled'), repoBuild: path.join(empty, 'repo.apk') },
      )).rejects.toThrow(HelperApkError);
      expect(Date.now() - started).toBeLessThan(2000); // USB 승인 대기(60초)에 들어가지 않았다
      try { await createEngine({ controlPlane: 'http://127.0.0.1:1', cycle: 'c', target: 'android', tests: 'x', engine: 'mobile', spool: empty, helperApk: path.join(empty, 'none.apk'), helperCache: empty }, () => {}, { bundledDir: path.join(empty, 'b'), repoBuild: path.join(empty, 'r.apk') }); }
      catch (e) { expect((e as Error).message).toMatch(/flag: .*none\.apk 없음[\s\S]*bundled: [\s\S]*repo-build: [\s\S]*download: 릴리스 URL 없음/); }
    } finally {
      if (saved.apk !== undefined) process.env.SINCLAIR_AGENT_HELPER_APK = saved.apk;
      if (saved.url !== undefined) process.env.SINCLAIR_AGENT_HELPER_URL = saved.url;
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });
});
