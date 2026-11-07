// 제한 범위 전수 검사: RpcDispatcher 의 기기별 직렬화가 "모든" 도착·완료 인터리빙에서 지켜지는지 실제 코드로 확인한다.
// 모델이 아니라 실제 RpcDispatcher 를 경로마다 새로 만들어 실행하고, 핸들러 완료 시점만 테스트가 고른다.
// 범위와 갱신 절차는 .claude/skills/verify-rpc-serialization/SKILL.md 를 본다.
import { describe, it, expect } from 'vitest';
import { RpcDispatcher, RPC_ERRORS } from '../src/index.ts';

const MAX_REQUESTS = 3;
const DEVICES = ['A', 'B', undefined] as const; // undefined = deviceId 없는 호출 (직렬화 대상 아님)

type Choice = { kind: 'arrive' } | { kind: 'settle'; idx: number; ok: boolean };

interface Deferred { resolve: (v: unknown) => void; reject: (e: unknown) => void }

interface Observed {
  started: number[];            // 핸들러가 실제로 호출된 순서
  settled: Set<number>;
  arrived: number;
  responses: Map<number, Promise<unknown>>;
  deferred: Map<number, Deferred>;
  dispatcher: RpcDispatcher;
}

const flush = async () => { for (let i = 0; i < 3; i++) await new Promise((r) => setImmediate(r)); };

/** prefix 의 선택을 실제 코드에 그대로 재생하고 관찰 결과를 돌려준다 */
async function replay(devices: readonly (string | undefined)[], prefix: Choice[]): Promise<Observed> {
  const o: Observed = { started: [], settled: new Set(), arrived: 0, responses: new Map(), deferred: new Map(), dispatcher: new RpcDispatcher() };
  o.dispatcher.register('device.io.tap', (params) => {
    const i = params['i'] as number;
    o.started.push(i);
    return new Promise((resolve, reject) => o.deferred.set(i, { resolve, reject }));
  });
  for (const c of prefix) {
    if (c.kind === 'arrive') {
      const i = o.arrived++;
      const params: Record<string, unknown> = { i };
      if (devices[i] !== undefined) params['deviceId'] = devices[i];
      const p = o.dispatcher.handle({ jsonrpc: '2.0', id: i, method: 'device.io.tap', params });
      o.responses.set(i, p);
    } else {
      const d = o.deferred.get(c.idx)!;
      if (c.ok) d.resolve(`ok${c.idx}`); else d.reject(new Error(`fail${c.idx}`));
      o.settled.add(c.idx);
    }
    await flush();
  }
  return o;
}

/** 매 스텝 성립해야 하는 불변식 */
function checkStep(devices: readonly (string | undefined)[], o: Observed, path: Choice[]): void {
  const where = `경로 ${JSON.stringify(path)} devices=${JSON.stringify(devices)} started=${JSON.stringify(o.started)}`;
  // 1. 중복 호출 없음
  expect(new Set(o.started).size, `핸들러 중복 호출: ${where}`).toBe(o.started.length);
  for (const dev of ['A', 'B']) {
    const arrivedHere = [...Array(o.arrived).keys()].filter((i) => devices[i] === dev);
    const startedHere = o.started.filter((i) => devices[i] === dev);
    // 2. 같은 기기의 시작 순서 = 도착 순서 (도착 목록의 접두사)
    expect(startedHere, `FIFO 위반(${dev}): ${where}`).toEqual(arrivedHere.slice(0, startedHere.length));
    const running = startedHere.filter((i) => !o.settled.has(i));
    // 3. 같은 기기에서 동시에 실행 중인 핸들러는 최대 1개
    expect(running.length, `겹침(${dev}): ${where}`).toBeLessThanOrEqual(1);
    // 4. 진행: 대기 중인 요청이 있는데 실행 중인 것이 없으면 교착 (다른 기기의 상태와 무관해야 한다 = 격리)
    if (startedHere.length < arrivedHere.length) expect(running.length, `교착/격리 위반(${dev}): ${where}`).toBe(1);
  }
  // 5. deviceId 없는 호출은 도착 즉시 실행
  for (let i = 0; i < o.arrived; i++) if (devices[i] === undefined) expect(o.started, `기기 없는 호출 미실행: ${where}`).toContain(i);
}

/** 모든 요청이 도착하고 완료된 뒤 성립해야 하는 불변식 */
async function checkTerminal(o: Observed, prefix: Choice[]): Promise<void> {
  for (const [i, p] of o.responses) {
    const r = (await p) as { result?: unknown; error?: { code: number; message: string } };
    const ok = prefix.some((c) => c.kind === 'settle' && c.idx === i && c.ok);
    if (ok) expect(r.result, `응답 불일치 #${i}`).toBe(`ok${i}`);
    else { expect(r.error?.code).toBe(RPC_ERRORS.internal); expect(r.error?.message).toBe(`fail${i}`); }
  }
  // 6. 잠금 맵이 비어 있어야 한다 (누수 없음)
  const locks = (o.dispatcher as unknown as { locks: Map<string, unknown> }).locks;
  expect(locks.size, `잠금 누수: ${JSON.stringify(prefix)}`).toBe(0);
}

async function explore(devices: readonly (string | undefined)[], prefix: Choice[], stats: { paths: number }): Promise<void> {
  const o = await replay(devices, prefix);
  checkStep(devices, o, prefix);
  const running = o.started.filter((i) => !o.settled.has(i));
  const options: Choice[] = [];
  if (o.arrived < devices.length) options.push({ kind: 'arrive' });
  for (const idx of running) { options.push({ kind: 'settle', idx, ok: true }); options.push({ kind: 'settle', idx, ok: false }); }
  if (options.length === 0) { stats.paths++; await checkTerminal(o, prefix); return; }
  for (const c of options) await explore(devices, [...prefix, c], stats);
}

function* assignments(n: number): Generator<(string | undefined)[]> {
  if (n === 0) { yield []; return; }
  for (const rest of assignments(n - 1)) for (const d of DEVICES) yield [...rest, d];
}

describe('RpcDispatcher 기기별 직렬화 (제한 범위 전수 검사)', () => {
  it(`요청 ${MAX_REQUESTS}개 이하, 기기 ${DEVICES.filter(Boolean).join('/')} + 기기 없음, 모든 도착·완료 인터리빙과 성공·실패 조합`, async () => {
    const stats = { paths: 0 };
    let scenarios = 0;
    for (let n = 1; n <= MAX_REQUESTS; n++) {
      for (const devices of assignments(n)) { scenarios++; await explore(devices, [], stats); }
    }
    // 탐색 범위가 줄어들면 검사도 약해진 것이므로 숫자를 고정한다
    expect(scenarios).toBe(3 + 9 + 27);
    expect(stats.paths).toBeGreaterThan(1000);
    console.log(`직렬화 전수 검사: 시나리오 ${scenarios}, 완료 경로 ${stats.paths}`);
  }, 120_000);
});
