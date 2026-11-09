// 엔진 계약 스위트: 어떤 Engine 구현이든 같은 시나리오로 "러너가 기대하는 대로 동작하는가" 를 검사한다.
// 사용자 경로(observe → locate → perform → 재관찰)로만 검증하고 엔진 내부를 보지 않는다.
import { describe, it, expect, afterEach } from 'vitest';
import { capabilitiesOf, EngineError, NODE_ACTIONS, type Engine, type LocatorQuery, type SemanticNode } from '../engine.ts';

/**
 * 엔진이 열렸을 때 보이는 화면에 대한 기대. 실제 엔진은 샘플 앱의 한 화면으로, FakeEngine 은 메모리 트리로 만족시킨다.
 * 모든 질의는 정확히 하나의 노드에 맞아야 한다(LocatorQuery 로 적는다).
 */
export interface ContractScenario {
  /** 탭하면 화면이 바뀌는 노드 */
  navButton: LocatorQuery;
  /** 바뀐 화면에서만 맞는 질의(전환 확인용) */
  afterNav: LocatorQuery;
  /** 글자를 넣을 수 있는 입력 필드. typeText 는 그 필드가 받는 글자(기본 영문+숫자, 전화 번호 필드는 숫자만 등) */
  textbox: LocatorQuery & { typeText?: string };
  /** 비활성 노드(있으면 not-actionable 검사) */
  disabled?: LocatorQuery;
  /** secure 입력 필드(있으면 내용 제거 검사) */
  secure?: LocatorQuery;
  /** 편집할 수 없는 노드(type → not-actionable) */
  nonEditable: LocatorQuery;
}

/** scenario 의 질의에서 typeText 같은 부가 필드를 뺀 순수 LocatorQuery */
function stripTypeText(query: LocatorQuery & { typeText?: string }): LocatorQuery {
  const { typeText: _t, ...rest } = query;
  return rest;
}

export interface EngineContractOptions {
  /** 매 테스트마다 새 엔진(시작 화면 상태)을 만든다 */
  makeEngine: () => Promise<Engine> | Engine;
  scenario: ContractScenario;
  /** 탭 뒤 화면 전환을 기다리는 상한(ms). 기본 10초: 실기기 앱 전환은 보통 1~3초, 콜드 스타트는 그 이상. FakeEngine 은 즉시 */
  navTimeoutMs?: number;
}

/** 전환 대기 중 재조회 간격. 실기기 observe 비용(수십~수백 ms)과 반응성의 절충 */
const NAV_POLL_MS = 200;

async function only(engine: Engine, query: Parameters<Engine['locate']>[0], label: string): Promise<SemanticNode> {
  const found = await engine.locate(query);
  expect(found.length, `${label}: 정확히 하나여야 함 (${found.length}개)`).toBe(1);
  return found[0]!;
}

export function engineContractSuite(name: string, { makeEngine, scenario, navTimeoutMs = 10_000 }: EngineContractOptions): void {
  describe(`엔진 계약: ${name}`, () => {
    const engines: Engine[] = [];
    /**
     * 시작 화면이 준비된 엔진. session 이 있으면 restart(없거나 미지원이면 open)로 앱을 처음 상태로 돌리고,
     * 전환 노드가 보일 때까지 기다린다(실기기 앱 기동은 수백 ms~수 초). 테스트끼리 화면 상태를 물려받지 않게 한다.
     */
    const fresh = async (): Promise<Engine> => {
      const e = await makeEngine();
      engines.push(e);
      if (e.session) {
        // restart 는 appId 가 없으면 unsupported-action 이다. 그 경우에만 open 으로 대신하고, 기기 문제는 그대로 드러낸다
        await e.session.restart().catch((err: unknown) => {
          if (err instanceof EngineError && err.code === 'unsupported-action') return e.session!.open();
          throw err;
        });
        const deadline = Date.now() + navTimeoutMs;
        while ((await e.locate(scenario.navButton)).length === 0 && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, NAV_POLL_MS));
        }
      }
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

    it('locate 는 시나리오의 전환 노드를 정확히 하나 찾고, 없는 것은 빈 배열이다', async () => {
      const e = await fresh();
      const btn = await only(e, scenario.navButton, 'navButton');
      if (scenario.navButton.role) expect(btn.role).toBe(scenario.navButton.role);
      expect(await e.locate({ ...scenario.navButton, name: 'sinclair-없는-이름-' + Date.now() })).toEqual([]);
    });

    it('locate 매칭 규칙(엔진 경로): 정규식 name/text, within 루트, nth 는 문서 순서, exact 는 정확 일치', async () => {
      const e = await fresh();
      const nav = await only(e, scenario.navButton, 'navButton');
      const label = nav.name ?? nav.text;
      if (typeof label === 'string' && label.length > 0) {
        const field = nav.name !== undefined ? 'name' : 'text';
        const byExact = await only(e, { role: nav.role, [field]: label, exact: true }, 'exact');
        const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        expect((await e.locate({ role: nav.role, [field]: new RegExp(`^${escaped}$`) })).map((n) => n.ref)).toEqual([byExact.ref]);
      }
      const root = (await e.observe()).root;
      const all = await e.locate({ role: nav.role });
      expect((await e.locate({ role: nav.role, within: root.ref })).map((n) => n.ref)).toEqual(all.filter((n) => n.ref !== root.ref).map((n) => n.ref));
      for (let i = 0; i < Math.min(all.length, 3); i++) {
        expect((await e.locate({ role: nav.role, nth: i })).map((n) => n.ref), `nth ${i}`).toEqual([all[i]!.ref]);
      }
      expect(await e.locate({ role: nav.role, nth: all.length })).toEqual([]);
    });

    it('locate 는 입력 필드를 정확히 하나 찾는다', async () => {
      const e = await fresh();
      const tb = await only(e, stripTypeText(scenario.textbox), 'textbox');
      expect(tb.rect ?? { width: 1 }).toBeTruthy();
    });

    it('perform type 뒤 재조회하면 value 에 글자가 들어 있다', async () => {
      const e = await fresh();
      const tb = await only(e, stripTypeText(scenario.textbox), 'textbox');
      const text = scenario.textbox.typeText ?? 'sinclair' + (Date.now() % 1000);
      await e.perform(tb.ref, 'type', text);
      // 실기기는 입력 뒤 트리에 반영되기까지 수백 ms 걸린다. 기한 안에 한 번이라도 보이면 된다.
      const deadline = Date.now() + navTimeoutMs;
      let after = await only(e, stripTypeText(scenario.textbox), 'textbox(after type)');
      while (!(after.value ?? '').includes(text) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, NAV_POLL_MS));
        after = await only(e, stripTypeText(scenario.textbox), 'textbox(after type)');
      }
      expect(after.value ?? '').toContain(text);
    });

    it('perform tap 으로 화면이 바뀌면 재관찰에서 전환 뒤 노드가 보인다', async () => {
      const e = await fresh();
      const btn = await only(e, scenario.navButton, 'navButton');
      await e.perform(btn.ref, 'tap');
      const deadline = Date.now() + navTimeoutMs;
      let found: SemanticNode[] = [];
      while (found.length === 0 && Date.now() < deadline) {
        found = await e.locate(scenario.afterNav);
        if (found.length === 0) await new Promise((r) => setTimeout(r, NAV_POLL_MS));
      }
      expect(found.length, `탭 뒤 ${JSON.stringify(scenario.afterNav)} 가 보여야 함`).toBeGreaterThan(0);
    });

    it('편집할 수 없는 노드에 type 하면 not-actionable 이다', async () => {
      const e = await fresh();
      const n = await only(e, scenario.nonEditable, 'nonEditable');
      await expect(e.perform(n.ref, 'type', 'x')).rejects.toMatchObject({ code: 'not-actionable' });
    });

    it('역할이 맞지 않는 노드에 check/select 하면 not-actionable 이다(전환 노드에 check, select)', async () => {
      const e = await fresh();
      const btn = await only(e, scenario.navButton, 'navButton');
      for (const action of ['check', 'select'] as const) {
        if (!e.actions.includes(action)) continue; // unsupported-action 은 별도 케이스가 검사한다
        await expect(e.perform(btn.ref, action, action === 'select' ? 'x' : undefined), action).rejects.toMatchObject({ code: 'not-actionable' });
      }
    });

    it('현재 화면에 없는 ref 는 not-found 다', async () => {
      const e = await fresh();
      await expect(e.perform('@no-such-ref', 'tap')).rejects.toMatchObject({ code: 'not-found' });
    });

    it('actions 에 없는 액션은 unsupported-action 이고, actions 에 있는 액션은 그 코드로 거부되지 않는다', async () => {
      const e = await fresh();
      const btn = await only(e, scenario.navButton, 'navButton');
      const unsupported = NODE_ACTIONS.filter((a) => !e.actions.includes(a));
      for (const a of unsupported) await expect(e.perform(btn.ref, a)).rejects.toMatchObject({ code: 'unsupported-action' });
      // 광고한 액션은 전제(역할 등) 때문에 거부될 수는 있어도 unsupported-action 이어서는 안 된다
      for (const a of e.actions) {
        const r = await e.perform(btn.ref, a, a === 'type' ? 'x' : undefined).then(() => undefined, (err: unknown) => err);
        if (r instanceof EngineError) expect(r.code, `액션 ${a}`).not.toBe('unsupported-action');
        if (e.session) await e.session.back();
      }
    });

    if (!scenario.disabled) it.skip('비활성 노드를 탭하면 not-actionable 이다 (scenario.disabled 없음: 검사 생략)', () => {});
    if (scenario.disabled) {
      const disabled = scenario.disabled;
      it('비활성 노드를 탭하면 not-actionable 이다', async () => {
        const e = await fresh();
        const n = await only(e, disabled, 'disabled');
        expect(n.states?.disabled).toBe(true);
        await expect(e.perform(n.ref, 'tap')).rejects.toMatchObject({ code: 'not-actionable' });
      });
    }

    if (!scenario.secure) it.skip('secure 노드는 observe/locate 어디서도 text/value 를 주지 않는다 (scenario.secure 없음: 검사 생략)', () => {});
    if (scenario.secure) {
      const secure = scenario.secure;
      it('secure 노드는 observe/locate 어디서도 text/value 를 주지 않는다', async () => {
        const e = await fresh();
        const n = await only(e, secure, 'secure');
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

    it('keyboard.shown 이 있으면 불리언을 돌려주고, dismiss 뒤에는 false 다', async () => {
      const e = await fresh();
      if (!e.keyboard?.shown) return; // 선택: 키보드 상태를 모르는 엔진은 구현하지 않는다(에이전트는 그러면 키보드 복구를 하지 않는다)
      expect(typeof (await e.keyboard.shown())).toBe('boolean');
      await e.keyboard.dismiss();
      expect(await e.keyboard.shown()).toBe(false);
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
