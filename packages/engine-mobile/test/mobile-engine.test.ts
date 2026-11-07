// engine-mobile 고유 동작: ref 재매핑, rect 안정화 대기, 액션 → 디바이스 RPC 매핑, 오류 변환, pixels 요청 시에만 snapshot.
import { describe, it, expect } from 'vitest';
import { createDeviceServer } from '@sinclair/device-layer';
import { createMobileEngine, rpcOverDispatcher } from '../src/index.ts';
import { ScenarioBackend } from './scenario-backend.ts';

function setup(opts: { stabilityTimeoutMs?: number } = {}) {
  const backend = new ScenarioBackend();
  const engine = createMobileEngine(rpcOverDispatcher(createDeviceServer([backend])), { deviceId: 'PHONE1', appId: 'com.example.app', ...opts });
  return { backend, engine };
}

describe('createMobileEngine', () => {
  it('observe 는 기본적으로 dump.ui 만 쓰고, pixels 를 요청하면 snapshot 으로 atomic 을 함께 준다', async () => {
    const { backend, engine } = setup();
    const plain = await engine.observe();
    expect(plain.pixels).toBeUndefined();
    expect(backend.calls).toEqual([]);
    const px = await engine.observe({ pixels: true });
    expect(Array.from(px.pixels!.subarray(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect(px.atomic).toBe(true);
  });

  it('perform tap 은 노드 rect 의 중심을 device.io.tap 으로 보내고, type 은 탭해 포커스한 뒤 device.io.text 를 보낸다', async () => {
    const { backend, engine } = setup();
    const [tb] = await engine.locate({ testId: 'username' });
    await engine.perform(tb!.ref, 'type', 'popark');
    expect(backend.calls).toEqual(['tap 540,360', 'text popark']);
    const [after] = await engine.locate({ testId: 'username' });
    expect(after!.value).toBe('popark');
  });

  it('ref 는 dump 마다 바뀔 수 있으므로 perform 은 기억한 기술자(role/testId/name)로 노드를 다시 찾는다', async () => {
    const { backend, engine } = setup();
    const [btn] = await engine.locate({ role: 'button', name: '로그인' });
    // 화면 앞쪽에 노드가 끼어들어 DFS 번호가 밀린 상황을 흉내 낸다: 같은 노드의 ref 가 바뀐다
    const launchTree = await backend.dumpUi();
    launchTree.children!.unshift({ ref: '@banner', role: 'text', text: '광고', rect: { x: 0, y: 0, width: 1080, height: 50 } });
    backend.setScreen(launchTree);
    await engine.perform(btn!.ref, 'tap');
    expect(backend.calls.at(-1)).toBe('tap 540,700');
    expect((await engine.locate({ text: '환영합니다' })).length).toBe(1);
  });

  it('노드 rect 가 움직이는 동안(애니메이션) 탭하지 않고 두 번 연속 같은 rect 가 될 때까지 기다린다', async () => {
    const { backend, engine } = setup();
    const [btn] = await engine.locate({ role: 'button', name: '로그인' });
    backend.animateButtonFor = 3;
    await engine.perform(btn!.ref, 'tap');
    expect(backend.calls.at(-1)).toBe('tap 540,700');
    expect(backend.dumps).toBeGreaterThanOrEqual(5); // locate 1 + 애니메이션 3 + 안정 확인 2
  });

  it('안정화 기한 안에 rect 가 멈추지 않으면 not-actionable 이다', async () => {
    const { backend, engine } = setup({ stabilityTimeoutMs: 100 });
    const [btn] = await engine.locate({ role: 'button', name: '로그인' });
    backend.animateButtonFor = 1_000;
    await expect(engine.perform(btn!.ref, 'tap')).rejects.toMatchObject({ code: 'not-actionable' });
  });

  it('scroll 은 노드 안에서 swipe 하고, press 는 키코드로, keyboard/session capability 는 해당 RPC 로 간다', async () => {
    const { backend, engine } = setup();
    const [root] = await engine.locate({ role: 'root' });
    await engine.perform(root!.ref, 'scroll', 'down');
    await engine.perform(root!.ref, 'press', 'Enter');
    await engine.keyboard!.type('abc');
    await engine.keyboard!.press('Back');
    await engine.keyboard!.dismiss();
    await engine.session!.open();
    await engine.session!.restart();
    expect(backend.calls).toEqual([
      'swipe 540,2160->540,240 300', 'keys KEYCODE_ENTER', 'text abc', 'keys KEYCODE_BACK', 'button back',
      'launch com.example.app', 'terminate com.example.app', 'launch com.example.app',
    ]);
    await expect(engine.session!.reset()).rejects.toMatchObject({ code: 'unsupported-action' });
  });

  it('디바이스 레이어 오류는 EngineError 로 바뀌고 기기 id 가 남는다', async () => {
    const engine = createMobileEngine(rpcOverDispatcher(createDeviceServer([new ScenarioBackend('OTHER')])), { deviceId: 'MISSING' });
    await expect(engine.observe()).rejects.toMatchObject({ code: 'device-unavailable', message: expect.stringContaining('MISSING') });
  });

  it('헬퍼 없음(-32002)도 device-unavailable 이고, 화면이 바뀌어 사라진 ref 는 not-found 다', async () => {
    const noHelper = createMobileEngine({ call: async () => { throw new (await import('../src/index.ts')).DeviceRpcError(-32002, '헬퍼 사용 불가(not-installed)'); } }, { deviceId: 'PHONE1' });
    await expect(noHelper.locate({ role: 'button' })).rejects.toMatchObject({ code: 'device-unavailable', message: expect.stringContaining('PHONE1') });

    const { engine } = setup();
    const [login] = await engine.locate({ role: 'button', name: '로그인' });
    await engine.perform(login!.ref, 'tap'); // 홈 화면으로 전환
    await expect(engine.perform(login!.ref, 'tap')).rejects.toMatchObject({ code: 'not-found', message: expect.stringContaining(login!.ref) });
  });

  it('그 밖의 디바이스 레이어 실패는 device-error 이고, 모르는 키 이름은 unsupported-action 이다', async () => {
    const { engine } = setup();
    const [root] = await engine.locate({ role: 'root' });
    await expect(engine.perform(root!.ref, 'press', 'NoSuchKey')).rejects.toMatchObject({ code: 'unsupported-action' });
    const broken = createMobileEngine({ call: async () => { throw new (await import('../src/index.ts')).DeviceRpcError(-32603, '내부 오류'); } }, { deviceId: 'PHONE1' });
    await expect(broken.observe()).rejects.toMatchObject({ code: 'device-error', message: expect.stringContaining('내부 오류') });
  });
});
