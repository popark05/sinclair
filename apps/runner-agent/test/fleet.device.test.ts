// @vitest-environment node
/**
 * 실기기(opt-in): mobile 데몬이 디바이스 백엔드를 소유해 꽂힌 기기를 Fleet 에 보고하고, 같은 백엔드로 Run 하나를 끝낸다.
 *   adb kill-server && SINCLAIR_TEST_USB=1 npx vitest run apps/runner-agent/test/fleet.device.test.ts
 * 전제: 기기 잠금 해제, 헬퍼 APK(리포 빌드 또는 SINCLAIR_AGENT_HELPER_APK), 설정 앱 제목이 "설정".
 * 증거: .scratch/device-fleet/evidence/02-device-lease-device-latest.json (시리얼·경로 마스킹; 티켓 01 의 증거 01-fleet-device-*.json 은 그대로 둔다)
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { startControlPlane, type CycleView, type FleetView } from '@sinclair/control-plane';
import { runDaemon, EXIT } from '../src/index.ts';

const target = process.env.SINCLAIR_TEST_USB;
const REPO = path.resolve(import.meta.dirname, '../../..');
/** 리포·홈 경로와 시리얼을 지운다. 시리얼은 Fleet 이 알려 준 실제 값으로 지우고(대소문자·길이 무관), 정규식은 혹시 모를 나머지를 위한 보조다.
 *  보조 정규식은 대문자+숫자 토큰만 본다: run id(UUID, 소문자 16진)를 망가뜨리지 않게 */
const mask = (line: string, serials: string[] = []): string => serials.reduce((l, id) => l.split(id).join(`…${id.slice(-4)}`), line.split(REPO).join('<repo>').split(os.homedir()).join('<home>')).replace(/\b(?=[A-Z0-9]*\d)(?=[A-Z0-9]*[A-Z])[A-Z0-9]{8,}\b/g, (t) => `…${t.slice(-4)}`);

describe.skipIf(!target)('실기기 Fleet 인벤토리', () => {
  it('mobile 데몬이 꽂힌 기기를 idle 로 보고하고, 그 기기를 lease 받아 같은 백엔드로 Run 을 끝낸 뒤 idle 로 돌아온다', async () => {
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
      const view = (await (await fetch(`${url}/cycles/fleet-device`)).json()) as CycleView & { warnings?: string[] };
      const runView = (await (await fetch(`${url}/runs/${view.runs[0]!.runId}`)).json()) as { deviceId?: string };
      const node = fleet.nodes.find((n) => n.agentId === 'device-node');
      const dir = path.join(REPO, '.scratch/device-fleet/evidence');
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, '02-device-lease-device-latest.json'), JSON.stringify({
        at: new Date().toISOString(), nodeTtlMs: fleet.nodeTtlMs,
        node: node && { agentId: node.agentId, online: node.online, devices: node.devices.map((d) => ({ id: `…${d.id.slice(-4)}`, platform: d.platform, model: d.model, osVersion: d.osVersion, connection: d.connection, helper: d.helper, locked: d.locked, state: d.state, reason: d.reason })) },
        run: { exitCode: summary.runs[0]?.exitCode, cycle: { state: view.state, verdict: view.verdict, warnings: view.warnings }, leasedDevice: view.runs[0]?.lease?.deviceId && `…${view.runs[0].lease.deviceId.slice(-4)}`, startedOnLeasedDevice: !!runView.deviceId && runView.deviceId === view.runs[0]?.lease?.deviceId }, log: logs.map((l) => mask(l, node?.devices.map((d) => d.id) ?? [])),
      }, null, 2) + '\n');
      expect(node?.devices.length).toBeGreaterThan(0);
      // 실패 메시지에 시리얼이 찍히지 않도록 id 를 뺀 값으로 비교한다
      const { id: _id, ...first } = node!.devices[0]!;
      expect(first).toMatchObject({ platform: 'android', connection: 'device', helper: 'ready', locked: false, state: 'idle' });
      expect(summary.runs[0]?.exitCode).toBe(EXIT.ok);
      expect(view).toMatchObject({ state: 'finished', verdict: 'verified' });
      // 기기 lease(device-fleet 02): Run 이 꽂힌 그 기기를 lease 받아 그 기기에서 돌았고, 끝난 뒤 기기는 idle 로 돌아왔다
      expect(view.runs[0]?.lease?.deviceId === node!.devices[0]!.id).toBe(true);
      expect(runView.deviceId === view.runs[0]?.lease?.deviceId).toBe(true);
      expect(view.warnings).toBeUndefined();
      expect(logs.filter((l) => /헬퍼 온보딩.*헬퍼 준비됨/.test(l)).length).toBeLessThanOrEqual(1); // 백엔드를 한 번만 열었다(run 이 다시 열지 않음)
    } finally {
      await cp.close();
    }
  }, 180_000);
});
