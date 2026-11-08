// @vitest-environment node
/**
 * 실기기(opt-in): 헬퍼를 지운 기기에서 `run` 이 APK 해석 → 설치 → 접근성 활성화 → 테스트 통과까지 혼자 가는지 본다.
 *   adb kill-server && SINCLAIR_TEST_USB=1 SINCLAIR_TEST_REINSTALL=1 npx vitest run apps/runner-agent/test/helper-reinstall.device.test.ts
 * 전제: 기기 잠금 해제, 리포 디버그 빌드(android-helper README) 또는 SINCLAIR_AGENT_HELPER_APK.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { Dadb } from '@sinclair/device-layer'; // 백엔드는 셸을 공개하지 않으므로 직접 ADB 로 지운다
import { startControlPlane, type CycleView } from '@sinclair/control-plane';
import { runOnce, createEngine, helperApkFileName, DEFAULT_REPO_BUILD, EXIT } from '../src/index.ts';

const target = process.env.SINCLAIR_TEST_USB;
const reinstall = process.env.SINCLAIR_TEST_REINSTALL;
/** 처음 보는 호스트 키면 "USB 디버깅 허용" 승인 대기 60초 */
const APPROVAL_WAIT_MS = 60_000;

describe.skipIf(!target || !reinstall)('실기기 헬퍼 재설치', () => {
  it('헬퍼를 지운 뒤 run 이 릴리스 URL 에서 APK 를 받아(sha256 검증) 설치·온보딩하고 설정 앱 샘플이 통과한다', async () => {
    // 1) 헬퍼 제거(직접 USB). 출력은 증거에 남긴다
    const devices = await Dadb.list({ includeEmulators: false, authTimeoutMs: APPROVAL_WAIT_MS });
    const dadb = target === '1' ? devices[0]! : devices.find((d) => d.serial === target)!;
    const serial = dadb.serial;
    let uninstallOutput: string;
    try {
      uninstallOutput = (await dadb.shell('pm uninstall io.sinclair.helper')).allOutput.trim();
      expect(uninstallOutput).toMatch(/^Success/);
      expect((await dadb.shell("pm path 'io.sinclair.helper'")).allOutput).not.toContain('package:');
    } finally { await dadb.close(); }

    // 2) 리포 디버그 빌드를 "릴리스 서버" 로 흉내 내어 다운로드 경로를 실제로 탄다(sha256 사이드카 포함)
    const apk = fsSync.readFileSync(DEFAULT_REPO_BUILD);
    const sha = createHash('sha256').update(apk).digest('hex');
    const release = http.createServer((req, res) => {
      if (req.url === `/release/${helperApkFileName()}.sha256`) { res.writeHead(200).end(`${sha}  ${helperApkFileName()}\n`); return; }
      if (req.url === `/release/${helperApkFileName()}`) { res.writeHead(200, { 'content-type': 'application/vnd.android.package-archive' }).end(apk); return; }
      res.writeHead(404).end();
    });
    await new Promise<void>((r) => release.listen(0, '127.0.0.1', r));
    const releaseUrl = `http://127.0.0.1:${(release.address() as { port: number }).port}/release`;
    const cache = fsSync.mkdtempSync(path.join(os.tmpdir(), 'sinclair-helper-cache-'));
    const savedEnv = { apk: process.env.SINCLAIR_AGENT_HELPER_APK, url: process.env.SINCLAIR_AGENT_HELPER_URL };
    delete process.env.SINCLAIR_AGENT_HELPER_APK; process.env.SINCLAIR_AGENT_HELPER_URL = releaseUrl;

    // 3) 에이전트 run (mobile): APK 다운로드 → 온보딩(설치·활성화) → 테스트
    const cp = await startControlPlane({ host: '127.0.0.1', port: 0, store: 'memory', db: 'unused-in-memory-mode' });
    const url = `http://127.0.0.1:${cp.server.port}`;
    const logs: string[] = [];
    try {
      await fetch(`${url}/cycles`, { method: 'POST', body: JSON.stringify({ cycleId: 'reinstall', build: 'b', targets: ['android'] }) });
      const code = await runOnce({
        controlPlane: url, cycle: 'reinstall', target: 'android', engine: 'mobile', app: 'com.android.settings', tests: path.resolve(import.meta.dirname, 'fixtures/device'),
        spool: path.resolve(import.meta.dirname, '../../../.e2e/agent-spool'), helperCache: cache, ...(target !== '1' ? { device: target! } : {}),
      }, { log: (l) => logs.push(l), createEngine: (a, l) => createEngine(a, l, { bundledDir: path.join(cache, 'no-bundle'), repoBuild: path.join(cache, 'no-repo.apk') }) });
      const view = (await (await fetch(`${url}/cycles/reinstall`)).json()) as CycleView;
      const dir = path.resolve(import.meta.dirname, '../../../.scratch/runner-agent/evidence');
      await fs.mkdir(dir, { recursive: true });
      const repoRoot = path.resolve(import.meta.dirname, '../../..');
      const mask = (l: string) => l.replaceAll(serial, `…${serial.slice(-4)}`).replaceAll(repoRoot, '<repo>').replaceAll(os.homedir(), '<home>').replaceAll(cache, '<cache>'); // 시리얼·홈 디렉터리·임시 경로 마스킹
      await fs.writeFile(path.join(dir, '05-helper-reinstall-device-latest.json'), JSON.stringify({
        at: new Date().toISOString(), exitCode: code, uninstall: uninstallOutput, cycle: { state: view.state, verdict: view.verdict }, log: logs.map(mask),
      }, null, 2) + '\n');
      expect(logs.some((l) => /헬퍼 APK: .*\(download\)/.test(l))).toBe(true); // 릴리스 서버에서 받았다
      expect(logs.some((l) => /헬퍼 온보딩.*헬퍼 설치됨/.test(l))).toBe(true);
      expect(logs.some((l) => /헬퍼 온보딩.*접근성 서비스 활성화됨/.test(l))).toBe(true);
      expect(logs.some((l) => /헬퍼 ready/.test(l))).toBe(true);
      expect(code).toBe(EXIT.ok);
      expect(view).toMatchObject({ state: 'finished', verdict: 'verified' });
    } finally {
      await cp.close();
      await new Promise<void>((r) => release.close(() => r()));
      if (savedEnv.apk !== undefined) process.env.SINCLAIR_AGENT_HELPER_APK = savedEnv.apk;
      if (savedEnv.url !== undefined) process.env.SINCLAIR_AGENT_HELPER_URL = savedEnv.url; else delete process.env.SINCLAIR_AGENT_HELPER_URL;
      fsSync.rmSync(cache, { recursive: true, force: true });
    }
  }, 240_000); // 승인 60초 + 설치·접근성 활성화·헬퍼 기동(~20초) + 테스트 + 여유
});
