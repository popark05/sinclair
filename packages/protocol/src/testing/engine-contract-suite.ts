// 엔진 계약 스위트: 어떤 Engine 구현이든 같은 시나리오로 "러너가 기대하는 대로 동작하는가" 를 검사한다.
// 사용자 경로(observe → locate → perform → 재관찰)로만 검증하고 엔진 내부를 보지 않는다.
import { describe, it, expect, afterEach } from 'vitest';
import { capabilitiesOf, EngineError, type Engine, type SemanticNode } from '../engine.ts';

/**
 * 엔진이 열렸을 때 보이는 화면에 대한 기대. 실제 엔진은 샘플 앱의 한 화면으로, FakeEngine 은 메모리 트리로 만족시킨다.
 * 모든 질의는 정확히 하나의 노드에 맞아야 한다.
 */
export interface ContractScenario {
  /** 탭하면 화면이 바뀌는 버튼과, 바뀐 화면에서만 보이는 텍스트 */
  navButton: { role: string; name: string };
  afterNavText: string;
  /** 글자를 넣을 수 있는 입력 필드 */
  textbox: { testId: string };
  /** 비활성 노드(있으면 not-actionable 검사) */
  disabled?: { role: string; name: string };
  /** secure 입력 필드(있으면 내용 제거 검사) */
  secure?: { testId: string };
  /** 편집할 수 없는 노드(type → not-actionable) */
  nonEditable: { role: string; name?: string; text?: string };
}

export interface EngineContractOptions {
  /** 매 테스트마다 새 엔진(시작 화면 상태)을 만든다 */
  makeEngine: () => Promise<Engine> | Engine;
  scenario: ContractScenario;
}

async function only(engine: Engine, query: Parameters<Engine['locate']>[0], label: string): Promise<SemanticNode> {
  const found = await engine.locate(query);
  expect(found.length, `${label}: 정확히 하나여야 함 (${found.length}개)`).toBe(1);
  return found[0]!;
}

export function engineContractSuite(name: string, { makeEngine, scenario }: EngineContractOptions): void {
  describe(`엔진 계약: ${name}`, () => {
    const engines: Engine[] = [];
    const fresh = async (): Promise<Engine> => {
      const e = await makeEngine();
      engines.push(e);
      if (e.session) await e.session.open();
      return e;
    };
    afterEach(async () => {
      for (const e of engines.splice(0)) await e.dispose?.();
    });

    it('observe 는 ref 를 가진 루트와 그 아래 노드들을 준다', async () => {
      const e = await fresh();
      const o = await e.observe();
      expect(o.root.ref).toMatch(/^@/);
      expect(o.root.role).toBeTruthy();
      expect(o.root.children?.length ?? 0).toBeGreaterThan(0);
    });

    it('locate 는 role/name 으로 시나리오의 버튼을 정확히 하나 찾고, 없는 것은 빈 배열이다', async () => {
      const e = await fresh();
      const btn = await only(e, { role: scenario.navButton.role, name: scenario.navButton.name }, 'navButton');
      expect(btn.role).toBe(scenario.navButton.role);
      expect(await e.locate({ role: scenario.navButton.role, name: 'sinclair-없는-이름-' + Date.now() })).toEqual([]);
    });

    it('locate 는 testId 로 입력 필드를 찾는다', async () => {
      const e = await fresh();
      const tb = await only(e, { testId: scenario.textbox.testId }, 'textbox');
      expect(tb.rect ?? { width: 1 }).toBeTruthy();
    });

    it('perform type 뒤 재조회하면 value 에 글자가 들어 있다', async () => {
      const e = await fresh();
      const tb = await only(e, { testId: scenario.textbox.testId }, 'textbox');
      const text = 'sinclair' + (Date.now() % 1000);
      await e.perform(tb.ref, 'type', text);
      const after = await only(e, { testId: scenario.textbox.testId }, 'textbox(after type)');
      expect(after.value ?? '').toContain(text);
    });

    it('perform tap 으로 화면이 바뀌면 재관찰에서 새 텍스트가 보인다', async () => {
      const e = await fresh();
      const btn = await only(e, { role: scenario.navButton.role, name: scenario.navButton.name }, 'navButton');
      await e.perform(btn.ref, 'tap');
      const deadline = Date.now() + 10_000;
      let found: SemanticNode[] = [];
      while (found.length === 0 && Date.now() < deadline) {
        found = await e.locate({ text: scenario.afterNavText });
        if (found.length === 0) await new Promise((r) => setTimeout(r, 200));
      }
      expect(found.length, `탭 뒤 "${scenario.afterNavText}" 가 보여야 함`).toBeGreaterThan(0);
    });

    it('편집할 수 없는 노드에 type 하면 not-actionable 이다', async () => {
      const e = await fresh();
      const n = await only(e, scenario.nonEditable, 'nonEditable');
      await expect(e.perform(n.ref, 'type', 'x')).rejects.toMatchObject({ code: 'not-actionable' });
    });

    it('현재 화면에 없는 ref 는 not-found 이고, 지원하지 않는 액션은 unsupported-action 이다', async () => {
      const e = await fresh();
      await expect(e.perform('@no-such-ref', 'tap')).rejects.toMatchObject({ code: 'not-found' });
      const btn = await only(e, { role: scenario.navButton.role, name: scenario.navButton.name }, 'navButton');
      const unsupported = (['drag', 'scroll_to', 'select', 'check', 'press', 'double_tap', 'long_press', 'scroll'] as const).find((a) => !e.actions.includes(a));
      if (unsupported) await expect(e.perform(btn.ref, unsupported)).rejects.toMatchObject({ code: 'unsupported-action' });
    });

    if (scenario.disabled) {
      const disabled = scenario.disabled;
      it('비활성 노드를 탭하면 not-actionable 이다', async () => {
        const e = await fresh();
        const n = await only(e, disabled, 'disabled');
        expect(n.states?.disabled).toBe(true);
        await expect(e.perform(n.ref, 'tap')).rejects.toMatchObject({ code: 'not-actionable' });
      });
    }

    if (scenario.secure) {
      const secure = scenario.secure;
      it('secure 노드는 observe/locate 어디서도 text/value 를 주지 않는다', async () => {
        const e = await fresh();
        const n = await only(e, { testId: secure.testId }, 'secure');
        expect(n.states?.secure).toBe(true);
        expect(n).not.toHaveProperty('value');
        expect(n).not.toHaveProperty('text');
        const o = await e.observe();
        const walk = (x: SemanticNode): SemanticNode | undefined => x.ref === n.ref ? x : x.children?.map(walk).find(Boolean);
        const inTree = walk(o.root);
        expect(inTree).toBeDefined();
        expect(inTree).not.toHaveProperty('value');
        expect(inTree).not.toHaveProperty('text');
      });
    }

    it('capability 는 구현한 선택 메서드로만 결정되고, 있으면 호출이 된다', async () => {
      const e = await fresh();
      const caps = capabilitiesOf(e);
      expect(caps.includes('keyboard')).toBe(!!e.keyboard);
      expect(caps.includes('session')).toBe(!!e.session);
      expect(caps.includes('pointer')).toBe(!!e.performAt);
      if (e.keyboard) await e.keyboard.dismiss();
      if (e.session) await e.session.back();
    });

    it('dispose 뒤의 호출은 engine-closed 다', async () => {
      const e = await makeEngine();
      await e.dispose?.();
      if (e.dispose) {
        try {
          await e.observe();
          throw new Error('engine-closed 가 아님');
        } catch (err) {
          expect(err).toBeInstanceOf(EngineError);
          expect((err as EngineError).code).toBe('engine-closed');
        }
      }
    });
  });
}
