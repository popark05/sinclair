// @vitest-environment node
// 통합: 러너(FakeEngine)가 만든 실제 이벤트를 Ingest 에 넣고 GET /runs/:id 가 러너의 RunReport 와 일치하는지 본다.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import { FakeEngine, HOME_SCREEN, LOGIN_SCREEN } from '@sinclair/protocol/testing';
import { runTests } from '@sinclair/runner';
import { createMemoryEventStore, serveControlPlane, type ControlPlaneServer, type RunView } from '../src/index.ts';

let server: ControlPlaneServer;
beforeEach(async () => { server = await serveControlPlane(createMemoryEventStore()); });
afterEach(async () => { await server.close(); });

describe('러너 → Ingest → 조회', () => {
  it('RunReport 의 테스트·결과·스텝·아티팩트·요약이 투영과 일치한다', async () => {
    const engine = new FakeEngine({ root: LOGIN_SCREEN, onTap: (n) => (n.name === '로그인' ? HOME_SCREEN : undefined) });
    const report = await runTests([path.resolve(import.meta.dirname, 'fixtures/mixed.sinclair.ts')], { engine, timeoutMs: 200, cycleId: 'c1', deviceId: 'fake-1' });
    expect(report.summary).toEqual({ passed: 1, failed: 1, blocked: 0, skipped: 1 });

    const res = await fetch(`http://127.0.0.1:${server.port}/ingest`, { method: 'POST', body: JSON.stringify(report.events) });
    expect(await res.json()).toEqual({ accepted: report.events.length, duplicate: 0, rejected: [] });

    const view = (await (await fetch(`http://127.0.0.1:${server.port}/runs/${report.runId}`)).json()) as RunView;
    expect(view).toMatchObject({ runId: report.runId, state: 'finished', cycleId: 'c1', targetId: 'fake', deviceId: 'fake-1' });
    expect(view.attempts.map((a) => [a.testId, a.result, a.steps.length, a.artifacts.length, a.errorCode]))
      .toEqual(report.tests.map((t) => [t.name, t.result, t.steps.length, t.artifacts.length, t.errorCode]));
    expect(view.attempts[1]!.steps[0]!.instruction).toContain('없는 문구');
  });
});
