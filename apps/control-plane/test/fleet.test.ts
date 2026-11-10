// Fleet: 노드 보고 → 기기 상태(idle/untrusted/offline) 규칙과 저장소 계약(memory·SQLite).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { NodeReport } from '@sinclair/protocol';
import { deviceStatus, buildFleetView, createMemoryFleetStore, createSqliteFleetStore, openSqlite, type FleetStore } from '../src/index.ts';

const T0 = Date.parse('2026-11-08T00:00:00.000Z');
const TTL = 60_000;
const dev = (over: Partial<NodeReport['devices'][number]> = {}): NodeReport['devices'][number] => ({ id: 'SER1', platform: 'android', model: 'SM-N981N', osVersion: '13', connection: 'device', helper: 'ready', locked: false, ...over });

describe('deviceStatus', () => {
  it('연결·승인·헬퍼 ready·잠금 없음이면 idle', () => {
    expect(deviceStatus(dev(), T0, T0, TTL)).toEqual({ state: 'idle' });
  });
  it('미승인·연결 끊김·헬퍼 미준비·잠김은 untrusted 와 사유', () => {
    expect(deviceStatus(dev({ connection: 'unauthorized' }), T0, T0, TTL)).toEqual({ state: 'untrusted', reason: 'USB 디버깅 미승인' });
    expect(deviceStatus(dev({ connection: 'offline' }), T0, T0, TTL)).toEqual({ state: 'untrusted', reason: '기기 연결 응답 없음(adb offline)' });
    expect(deviceStatus(dev({ helper: 'disabled' }), T0, T0, TTL)).toEqual({ state: 'untrusted', reason: '헬퍼 준비 안 됨(disabled)' });
    expect(deviceStatus(dev({ locked: true }), T0, T0, TTL)).toEqual({ state: 'untrusted', reason: '화면 잠김' });
  });
  it('헬퍼·잠금 정보가 없으면(그 플랫폼에 개념이 없거나 확인 못 함) 막지 않는다', () => {
    const { helper: _h, locked: _l, ...bare } = dev();
    expect(deviceStatus(bare, T0, T0, TTL)).toEqual({ state: 'idle' });
  });
  it('노드 보고가 TTL 을 넘기면 기기 상태와 무관하게 offline', () => {
    expect(deviceStatus(dev(), T0, T0 + TTL - 1, TTL)).toEqual({ state: 'idle' });
    expect(deviceStatus(dev(), T0, T0 + TTL, TTL)).toEqual({ state: 'offline', reason: '노드 보고 끊김' });
  });
});

function fleetStoreSuite(name: string, make: () => FleetStore | Promise<FleetStore>): void {
  describe(`FleetStore 계약: ${name}`, () => {
    let store: FleetStore;
    beforeEach(async () => { store = await make(); });
    afterEach(async () => { await store.close?.(); });

    it('노드 보고가 기기 목록을 바꾸고, 보고에서 빠진 기기는 마지막 모습과 빠진 시각으로 남으며, 노드는 처음 보고한 순서로 나온다', async () => {
      await store.reportNode('node-b', { devices: [dev({ id: 'B1' })] }, T0);
      await store.reportNode('node-a', { devices: [dev({ id: 'A1' }), dev({ id: 'A2' })] }, T0 + 1);
      await store.reportNode('node-b', { devices: [dev({ id: 'B2', locked: true })] }, T0 + 2); // B1 은 빠진다
      expect(await store.listNodes()).toEqual([
        { agentId: 'node-b', reportedAt: new Date(T0 + 2).toISOString(), devices: [dev({ id: 'B2', locked: true })], missing: [{ ...dev({ id: 'B1' }), missingSince: new Date(T0 + 2).toISOString() }] },
        { agentId: 'node-a', reportedAt: new Date(T0 + 1).toISOString(), devices: [dev({ id: 'A1' }), dev({ id: 'A2' })], missing: [] },
      ]);
      // 다시 보고되면 빠진 목록에서 나온다; 계속 빠져 있으면 처음 빠진 시각을 유지한다
      await store.reportNode('node-b', { devices: [dev({ id: 'B2' })] }, T0 + 3);
      expect((await store.listNodes())[0]!.missing).toEqual([{ ...dev({ id: 'B1' }), missingSince: new Date(T0 + 2).toISOString() }]);
      await store.reportNode('node-b', { devices: [dev({ id: 'B1' }), dev({ id: 'B2' })] }, T0 + 4);
      expect((await store.listNodes())[0]!.missing).toEqual([]);
    });

    it('deleteNode: 마지막 보고가 기준 시각보다 이르면 지우고, 그 사이 다시 보고했으면 recent 로 남긴다; 모르는 노드는 no-node. 지운 노드가 다시 보고하면 새로 나타난다', async () => {
      await store.reportNode('a', { devices: [dev({ id: 'A1' })] }, T0);
      await store.reportNode('b', { devices: [dev({ id: 'B1' })] }, T0 + 10);
      expect(await store.deleteNode('b', new Date(T0 + 10).toISOString())).toBe('recent'); // 같은 시각은 지우지 않는다
      expect(await store.deleteNode('a', new Date(T0 + 10).toISOString())).toBe('deleted');
      expect(await store.deleteNode('a', new Date(T0 + 10).toISOString())).toBe('no-node');
      expect((await store.listNodes()).map((x) => x.agentId)).toEqual(['b']);
      await store.reportNode('a', { devices: [dev({ id: 'A1' })] }, T0 + 20);
      expect(await store.listNodes()).toEqual([
        expect.objectContaining({ agentId: 'b' }),
        { agentId: 'a', reportedAt: new Date(T0 + 20).toISOString(), devices: [dev({ id: 'A1' })], missing: [] }, // 이전 기록(빠진 기기)은 남지 않는다
      ]);
    });

    it('pruneNodes: 마지막 보고가 기준 시각보다 이른 노드를 모두 지우고 그 id 를 돌려준다', async () => {
      await store.reportNode('old1', { devices: [] }, T0);
      await store.reportNode('new', { devices: [] }, T0 + 100);
      await store.reportNode('old2', { devices: [] }, T0 + 50);
      expect((await store.pruneNodes(new Date(T0 + 100).toISOString())).sort()).toEqual(['old1', 'old2']);
      expect((await store.listNodes()).map((x) => x.agentId)).toEqual(['new']);
      expect(await store.pruneNodes(new Date(T0 + 100).toISOString())).toEqual([]);
    });

    it('같은 보고를 반복해도 결과가 같다(멱등)', async () => {
      await store.reportNode('n', { devices: [dev()] }, T0);
      await store.reportNode('n', { devices: [dev()] }, T0);
      expect(await store.listNodes()).toHaveLength(1);
    });
  });
}

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sinclair-fleet-')); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
let n = 0;
fleetStoreSuite('memory', () => createMemoryFleetStore());
fleetStoreSuite('sqlite', () => createSqliteFleetStore(openSqlite(path.join(dir, `fleet-${n++}.db`))));

describe('buildFleetView', () => {
  it('보고에서 빠진 기기는 offline(보고에서 빠짐)으로, 꽂힌 기기 뒤에 나온다', () => {
    const v = buildFleetView([{ agentId: 'n', reportedAt: new Date(T0).toISOString(), devices: [dev({ id: 'A' })], missing: [{ ...dev({ id: 'B' }), missingSince: new Date(T0).toISOString() }] }], T0 + 1, TTL);
    expect(v.nodes[0]!.devices.map((d) => [d.id, d.state, d.reason])).toEqual([['A', 'idle', undefined], ['B', 'offline', '보고에서 빠짐']]);
  });
});

describe('SQLite Fleet 영속', () => {
  it('재시작 뒤에도 노드 보고가 남는다', async () => {
    const file = path.join(dir, 'cp.db');
    const a = createSqliteFleetStore(openSqlite(file));
    await a.reportNode('n', { devices: [dev()] }, T0);
    await a.close!();
    const b = createSqliteFleetStore(openSqlite(file));
    expect((await b.listNodes())[0]).toMatchObject({ agentId: 'n', devices: [{ id: 'SER1' }] });
    await b.close!();
  });
});
