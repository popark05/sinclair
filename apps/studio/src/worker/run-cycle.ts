// Cycle 로 실행(studio-console 04): 내보낸 테스트를 테스트 폴더/<이름>/<이름>.sinclair.ts 에 쓰고(한 테스트 = 한 suite 폴더 — Cycle 이 그 테스트만 돈다),
// 고른 기기(deviceId 조건 타깃)로 Cycle 과 Run 을 등록한다. 같은 머신의 데몬이 Fleet 보고로 그 기기를 알고 Run 을 가져간다.
import { mkdir, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';

export interface RunCycleInput { controlPlane: string; testsDir: string; testName: string; code: string; deviceId: string; deviceLabel: string }
export interface CycleStatusView { state: string; verdict: string; runState?: string }

/** 파일·폴더 이름으로 안전하게: 경로 구분자·예약 문자를 공백으로, 상위 경로(.. 등 앞쪽 점) 제거 */
export function testSlug(name: string): string {
  // eslint-disable-next-line no-control-regex -- 파일 이름에 쓸 수 없는 제어 문자를 지운다
  const s = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().replace(/^[.\s]+/, '').slice(0, 80).trim();
  return s || 'studio-test';
}

async function call(controlPlane: string, p: string, init?: RequestInit): Promise<unknown> {
  let res: Response;
  try { res = await fetch(`${controlPlane.replace(/\/+$/, '')}${p}`, init); }
  catch (err) { throw new Error(`control-plane 에 닿지 않음(${controlPlane}): ${err instanceof Error ? err.message : String(err)}`); }
  const text = await res.text();
  if (!res.ok) throw new Error(`control-plane ${p}: HTTP ${res.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

export async function runAsCycle(input: RunCycleInput): Promise<{ cycleId: string; consoleUrl: string; file: string }> {
  const slug = testSlug(input.testName);
  const dir = path.resolve(input.testsDir, slug);
  if (!dir.startsWith(path.resolve(input.testsDir) + path.sep)) throw new Error('테스트 폴더 밖으로 쓸 수 없음');
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${slug}.sinclair.ts`);
  await writeFile(file, input.code, 'utf8');
  const now = new Date();
  const stamp = now.toISOString().slice(0, 19).replace(/[-:T]/g, '');
  const cycleId = `studio-${stamp}-${randomBytes(2).toString('hex')}`;
  const target = { id: input.deviceLabel || input.deviceId, platform: 'android', deviceId: input.deviceId };
  await call(input.controlPlane, '/cycles', { method: 'POST', body: JSON.stringify({ cycleId, build: 'studio', targets: [target], suite: { tests: dir } }) });
  await call(input.controlPlane, `/cycles/${encodeURIComponent(cycleId)}/runs`, { method: 'POST', body: JSON.stringify({ targetId: target.id }) });
  return { cycleId, consoleUrl: `${input.controlPlane.replace(/\/+$/, '')}/console/cycles/${encodeURIComponent(cycleId)}`, file };
}

export async function cycleStatus(input: { controlPlane: string; cycleId: string }): Promise<CycleStatusView> {
  const v = await call(input.controlPlane, `/cycles/${encodeURIComponent(input.cycleId)}`) as { state: string; verdict: string; runs?: Array<{ state: string; replacedBy?: string }> };
  const live = (v.runs ?? []).filter((r) => !r.replacedBy).at(-1);
  return { state: v.state, verdict: v.verdict, ...(live ? { runState: live.state } : {}) };
}
