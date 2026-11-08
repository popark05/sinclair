// @vitest-environment node
/**
 * 실기기(opt-in): mobile 데몬이 디바이스 백엔드를 소유해 꽂힌 기기를 Fleet 에 보고하고, 같은 백엔드로 Run 하나를 끝낸다.
 *   adb kill-server && SINCLAIR_TEST_USB=1 npx vitest run apps/runner-agent/test/fleet.device.test.ts
 * 전제: 기기 잠금 해제, 헬퍼 APK(리포 빌드 또는 SINCLAIR_AGENT_HELPER_APK), 설정 앱 제목이 "설정".
 * 증거: .scratch/device-fleet/evidence/01-fleet-device-latest.json (시리얼·경로 마스킹)
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { startControlPlane, type CycleView, type FleetView } from '@sinclair/control-plane';
import { runDaemon, EXIT } from '../src/index.ts';

const target = process.env.SINCLAIR_TEST_USB;
const REPO = path.resolve(import.meta.dirname, '../../..');
const mask = (line: string): string => line.split(REPO).join('<repo>').split(os.homedir()).join('<home>').replace(/\b[A-Z0-9]{8,}\b/g, (s) => `…${s.slice(-4)}`);

describe.skipIf(!target)('실기기 Fleet 인벤토리', () => {
  it('mobile 데몬이 꽂힌 기기를 idle 로 보고하고, 같은 백엔드로 Run 을 끝낸다', async () => {
    const cp = await startControlPlane({ host: '127.0.0.1', port: 0, store: 'memory', db: 'unused-in-memory-mode', leaseTtlMs: 6_000 });
    const url = `http://127.0.0.1:${cp.server.port}`;
    const logs: string[] = [];
    const spool = path.join(REPO, '.e2e/agent-spool-fleet');
    try {
      await fetch(`${url}/cycles`, { method: 'POST', body: JSON.stringify({ cycleId: 'fleet-device', build: 'b', targets: ['android'], suite: { tests: path.join(REPO, 'apps/runner-agent/test/fixtures/device') } }) });
      await fetch(`${url}/cycles/fleet-device/runs`, { method: 'POST', body: JSON.stringify({ targetId: 'android' }) });
      const summary = await runDaemon(
        { controlPlane: url, targets: ['android'], tests: path.join(REPO, 'apps/runner-agent/test/fixtures/device'), engine: 'mobile', app: 'com.android.settings', spool, helperCache: path.join(REPO, '.e2e/helper-cache'), agent: 'device-node', pollMs: 200, ...(target !== '1' ? { device: target! } : {}) },
        { log: (l) => logs.push(l), maxRuns: 1 },
      );
      const fleet = (await (await fetch(`${url}/fleet`)).json()) as FleetView;
      const view = (await (await fetch(`${url}/cycles/fleet-device`)).json()) as CycleView;
      const node = fleet.nodes.find((n) => n.agentId === 'device-node');
      const dir = path.join(REPO, '.scratch/device-fleet/evidence');
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, '01-fleet-device-latest.json'), JSON.stringify({
        at: new Date().toISOString(), nodeTtlMs: fleet.nodeTtlMs,
        node: node && { agentId: node.agentId, online: node.online, devices: node.devices.map((d) => ({ id: `…${d.id.slice(-4)}`, platform: d.platform, model: d.model, osVersion: d.osVersion, connection: d.connection, helper: d.helper, locked: d.locked, state: d.state, reason: d.reason })) },
        run: { exitCode: summary.runs[0]?.exitCode, cycle: { state: view.state, verdict: view.verdict } }, log: logs.map(mask),
      }, null, 2) + '\n');
      expect(node?.devices.length).toBeGreaterThan(0);
      // 실패 메시지에 시리얼이 찍히지 않도록 id 를 뺀 값으로 비교한다
      const { id: _id, ...first } = node!.devices[0]!;
      expect(first).toMatchObject({ platform: 'android', connection: 'device', helper: 'ready', locked: false, state: 'idle' });
      expect(summary.runs[0]?.exitCode).toBe(EXIT.ok);
      expect(view).toMatchObject({ state: 'finished', verdict: 'verified' });
      expect(logs.filter((l) => /헬퍼 온보딩.*헬퍼 준비됨/.test(l)).length).toBeLessThanOrEqual(1); // 백엔드를 한 번만 열었다(run 이 다시 열지 않음)
    } finally {
      await cp.close();
    }
  }, 180_000);
});
