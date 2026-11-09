// @vitest-environment node
/**
 * 실기기 에이전트 종단(opt-in, agent-layer 08): fixtures/agent-device.sinclair.ts 를 engine-mobile 로 실제 Android 기기에서 돌린다.
 *   실제 모델: adb kill-server && SINCLAIR_TEST_USB=1 SINCLAIR_AGENT_LIVE=1 ANTHROPIC_API_KEY=… npx vitest run packages/runner/test/agent.device.test.ts
 *   배관만(모델 없이, 화면 글자를 읽는 대본 실행기): adb kill-server && SINCLAIR_TEST_USB=1 npx vitest run packages/runner/test/agent.device.test.ts
 * 사내망은 NODE_EXTRA_CA_CERTS. 전제: 잠금 해제(화면 켜짐 유지), 한국어 UI 의 삼성 설정 앱.
 * 증거: .scratch/agent-layer/evidence/08-agent-device-<live|scripted>-latest.json — 시리얼 마스킹, 키·비밀값·화면 글자(모델 근거 문구) 없음.
 */
import { describe, it, expect as vexpect } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createAndroidBackend, createDeviceServer } from '@sinclair/device-layer';
import { createMobileEngine, rpcOverDispatcher } from '@sinclair/engine-mobile';
import { agentFromEnv, createClaudeExecutor, claudeOptionsFromEnv, probeClaude, type StepExecutor } from '@sinclair/agent';
import { runTests } from '../src/index.ts';

const usb = process.env.SINCLAIR_TEST_USB;
const hasKey = !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_PROFILE);
const live = process.env.SINCLAIR_AGENT_LIVE === '1' && hasKey;
const SECRET = 'qaZ9srch';
const EMAIL = /[A-Za-z0-9._%+*-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}/;
const TERMS = (process.env.SINCLAIR_AGENT_PII_TERMS ?? '').split(',').map((t) => t.trim()).filter((t) => t.length >= 2);
const APPROVAL_WAIT_MS = 60_000;

/** 모델 없이 배관을 보는 대본 실행기: 관찰 글자로 목표별 다음 툴을 고르고, 판정은 화면 글자로. 실제 모델 증명이 아니다 */
function screenReadingExecutor(): StepExecutor {
  const refOf = (obs: string, re: RegExp) => obs.split('\n').find((l) => re.test(l))?.trim().split(' ')[0];
  const scroll = (obs: string) => ({ call: { name: 'scroll', input: { ref: refOf(obs, / list /) ?? refOf(obs, /^@\S+ /)!, direction: 'down' } } });
  return {
    async next(req) {
      const did = (name: string) => req.history.some((h) => h.call?.name === name && h.result === 'ok');
      if (/휴대전화 정보/.test(req.goal)) {
        if (did('tap')) return { call: { name: 'done', input: { summary: '휴대전화 정보를 눌렀다' } } };
        const ref = refOf(req.observation, /"휴대전화 정보"/);
        return ref ? { call: { name: 'tap', input: { ref } } } : scroll(req.observation);
      }
      if (/검색창/.test(req.goal)) {
        if (did('type')) return { call: { name: 'done', input: { summary: '검색어를 입력했다' } } };
        const box = refOf(req.observation, / (textbox|searchbox) /);
        if (box) return { call: { name: 'type', input: { ref: box, text: '{{secret:QA_SEARCH}}' } } };
        const btn = refOf(req.observation, /"설정 검색"/);
        return btn ? { call: { name: 'tap', input: { ref: btn } } } : scroll(req.observation);
      }
      return scroll(req.observation);
    },
    async judge(req) {
      const pass = /휴대전화 정보/.test(req.question) ? /"휴대전화 정보"/.test(req.observation) : /secret:QA_SEARCH/.test(req.observation);
      return { answer: { pass, reason: pass ? '화면 글자로 확인' : '화면에 없음' } };
    },
  };
}

describe.skipIf(!usb)(`실기기 agent.act·assert (${live ? '실제 모델' : '대본 실행기 — 배관만'})`, () => {
  it('목표 달성 + 판정, 비밀값 입력, 이룰 수 없는 목표의 실패가 스텝·증거에 남는다', async (ctx) => {
    if (process.env.SINCLAIR_AGENT_LIVE === '1' && !hasKey) throw new Error('SINCLAIR_AGENT_LIVE=1 인데 Claude API 자격 증명이 없음 — ANTHROPIC_API_KEY 를 설정');
    // 네트워크가 없으면(사내망 CA 미설정 포함) 분명하게 건너뛴다 — 모델 호출 실패를 테스트 실패로 보이지 않게
    if (live && (await probeClaude(claudeOptionsFromEnv(process.env))) === 'unreachable') { console.log('건너뜀: Claude API 에 닿지 않음(네트워크·NODE_EXTRA_CA_CERTS 확인)'); ctx.skip(); return; }
    const backend = createAndroidBackend({ dadb: { includeEmulators: false, authTimeoutMs: APPROVAL_WAIT_MS }, probeWaitMs: APPROVAL_WAIT_MS });
    const bodies: string[] = [];
    const scriptedRequests: string[] = [];
    try {
      const [device] = await backend.listDevices();
      const deviceId = usb === '1' ? device!.id : usb!;
      let info = await backend.info(deviceId);
      for (let i = 0; i < 40 && info.helper?.state === 'pending'; i++) { await new Promise((r) => setTimeout(r, 250)); info = await backend.info(deviceId); }
      vexpect(info.helper?.state).toBe('ready');
      await backend.keys(deviceId, ['KEYCODE_WAKEUP']);
      const engine = createMobileEngine(rpcOverDispatcher(createDeviceServer([backend])), { deviceId, appId: 'com.android.settings' });

      // 실제 모델이면 요청 본문을 기록하는 fetch 로(비밀값이 모델에 가지 않았음을 본문으로 확인)
      const recording: typeof fetch = async (input, init) => { if (typeof init?.body === 'string') bodies.push(init.body); return fetch(input, init); };
      const base = agentFromEnv(process.env);
      let executor: StepExecutor;
      if (live) executor = createClaudeExecutor({ ...claudeOptionsFromEnv(process.env), fetch: recording });
      else {
        const inner = screenReadingExecutor();
        executor = { next: (r, s) => { scriptedRequests.push(JSON.stringify(r)); return inner.next(r, s); }, judge: (r, s) => { scriptedRequests.push(JSON.stringify(r)); return inner.judge!(r, s); } };
      }
      const artifactsDir = path.resolve(import.meta.dirname, '../../../.e2e/agent-artifacts');
      await fs.rm(artifactsDir, { recursive: true, force: true });
      const started = Date.now();
      const report = await runTests([path.resolve(import.meta.dirname, 'fixtures/agent-device.sinclair.ts')], {
        engine, artifactsDir, timeoutMs: 10_000, deviceId: `…${deviceId.slice(-4)}`,
        agent: { ...base, executor, maxTurns: 12 }, ...(base.pii ? { pii: base.pii } : {}), secrets: { get: (n) => (n === 'QA_SEARCH' ? SECRET : undefined) },
      });

      // 증거: 스텝 종류·호출 수·토큰·시간. 판정 근거 문구는 화면 글자(계정 이름 등)를 옮길 수 있어 싣지 않는다
      const steps = (t: (typeof report.tests)[number]) => t.steps.map((s) => ({ kind: s.kind, instruction: (s.instruction ?? '').replace(/ → 참: .*$/, ' → 참').replace(/ → 실패: .*$/, ' → 실패'), modelCalls: s.modelCalls, ...(s.usage ? { usage: s.usage } : {}), durationMs: s.durationMs }));
      const trees = (await fs.readdir(artifactsDir).catch(() => [] as string[])).filter((f) => f.endsWith('.json'));
      const treeText = (await Promise.all(trees.map((f) => fs.readFile(path.join(artifactsDir, f), 'utf8')))).join('');
      const haystacks = { report: JSON.stringify(report), modelRequests: (live ? bodies : scriptedRequests).join('\n'), screenTrees: treeText };
      const evidence = {
        at: new Date().toISOString(), mode: live ? `실제 모델(${claudeOptionsFromEnv(process.env).model ?? 'claude-sonnet-5-5'})` : '대본 실행기(배관만 — 실제 모델 증명 아님)',
        device: `${info.model} (…${deviceId.slice(-4)}) Android ${info.osVersion}`, durationMs: Date.now() - started, summary: report.summary,
        totals: { modelCalls: report.tests.flatMap((t) => t.steps).reduce((a, s) => a + s.modelCalls, 0), requests: live ? bodies.length : scriptedRequests.length },
        tests: report.tests.map((t) => ({ name: t.name, result: t.result, errorCode: t.errorCode, durationMs: t.durationMs, artifacts: t.artifacts.map((a) => a.kind), steps: steps(t), ...(t.errorCode === 'agent' ? { reason: /턴 한도 \d+/.exec(t.error ?? '')?.[0] } : {}) })),
        secret: Object.fromEntries(Object.entries(haystacks).map(([k, v]) => [k, { scanned: v.length > 0, valueFound: v.includes(SECRET) }])),
        // 화면 개인정보(설정 첫 화면의 계정 이메일·SINCLAIR_AGENT_PII_TERMS 의 이름): 값은 싣지 않고 찾았는지만
        pii: Object.fromEntries(Object.entries(haystacks).map(([k, v]) => [k, { emailFound: EMAIL.test(v), termsFound: TERMS.some((t) => v.includes(t)), placeholder: v.includes('<이메일>') }])),
      };
      const text = JSON.stringify(evidence, null, 2);
      vexpect(text).not.toContain(SECRET);
      for (const t of TERMS) vexpect(text).not.toContain(t);
      for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']) if (process.env[k]) vexpect(text).not.toContain(process.env[k]);
      const dir = path.resolve(import.meta.dirname, '../../../.scratch/agent-layer/evidence');
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, `08-agent-device-${live ? 'live' : 'scripted'}-latest.json`), text + '\n');

      vexpect(report.tests.map((t) => [t.result, t.errorCode])).toEqual([['passed', undefined], ['passed', undefined], ['failed', 'agent']]);
      vexpect(report.tests[2]!.error).toMatch(/턴 한도 12/);
      vexpect(report.tests[2]!.artifacts.map((a) => a.kind).sort()).toEqual(['screen-tree', 'screenshot']);
      for (const [k, v] of Object.entries(haystacks)) { vexpect(v.length, `${k} 가 비어 있음`).toBeGreaterThan(0); vexpect(v.includes(SECRET), `${k} 에 비밀값`).toBe(false); }
      vexpect(report.tests[0]!.steps.map((s) => s.kind)).toEqual(['act', 'assert']);
      for (const [k, v] of Object.entries(haystacks)) { vexpect(EMAIL.test(v), `${k} 에 이메일`).toBe(false); for (const t of TERMS) vexpect(v.includes(t), `${k} 에 목록의 개인정보`).toBe(false); }
      vexpect(haystacks.modelRequests).toContain('<이메일>'); // 설정 첫 화면의 계정 이메일이 자리표시로 갔다
    } finally {
      await backend.terminateApp((await backend.listDevices())[0]?.id ?? '', 'com.android.settings').catch(() => undefined);
      await backend.button((await backend.listDevices())[0]?.id ?? '', 'home').catch(() => undefined);
      await backend.close();
    }
  }, 600_000);
});
