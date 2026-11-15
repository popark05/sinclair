// iOS 러너 실동작 확인(ios-backend 04): 떠 있는 러너(시뮬레이터는 호스트 127.0.0.1, 실기기는 포워드 포트)에 계약 경로를 차례로 친다.
//   node --experimental-transform-types packages/device-layer/scripts/ios-runner-check.ts --port 22087 --token <토큰> [--app com.apple.Preferences]
// 화면 내용(글자)은 출력하지 않는다(실기기 개인정보) — 개수·역할·크기만.
import { IosRunnerClient } from '../src/ios/runner-client.ts';
import type { SemanticNode } from '@sinclair/protocol';

const arg = (k: string, d?: string): string => { const i = process.argv.indexOf(`--${k}`); const v = i >= 0 ? process.argv[i + 1] : d; if (v === undefined) throw new Error(`--${k} 필요`); return v; };
const port = Number(arg('port', '22087'));
const token = arg('token');
const appId = arg('app', 'com.apple.Preferences');
const c = new IosRunnerClient(port, token);

const nodes = (n: SemanticNode): SemanticNode[] => [n, ...(n.children ?? []).flatMap(nodes)];
const roles = (n: SemanticNode): string => { const m = new Map<string, number>(); for (const x of nodes(n)) m.set(x.role, (m.get(x.role) ?? 0) + 1); return [...m].map(([r, k]) => `${r}:${k}`).join(' '); };
const results: Array<[string, boolean, string]> = [];
const check = async (name: string, f: () => Promise<string>): Promise<void> => {
  const t = Date.now();
  try { results.push([name, true, `${await f()} (${Date.now() - t}ms)`]); } catch (e) { results.push([name, false, (e as Error).message]); }
};

await check('ping', async () => { const p = await c.ping(); return `v${p.version} iOS ${p.iosVersion} ${p.model} ${p.screen.width}x${p.screen.height}@${p.scale}`; });
await check('잘못된 토큰은 401', async () => { try { await new IosRunnerClient(port, 'wrong').ping(); } catch (e) { if (/401/.test((e as Error).message)) return '거부됨'; throw e; } throw new Error('통과돼 버림'); });
await check('앱 종료 후 실행', async () => { await c.app('terminate', appId); await c.app('launch', appId); return appId; });
await check('앞 화면 앱', async () => { const f = await c.foreground(); if (f !== appId) throw new Error(`앞 화면 ${f}`); return f; });
let tree: SemanticNode | undefined;
await check('dump', async () => { tree = await c.dump(); return `${nodes(tree).length}개 · ${roles(tree)}`; });
await check('snapshot(트리+PNG)', async () => { const s = await c.snapshot(); const png = Buffer.from(s.screenshot.base64, 'base64'); if (png.subarray(1, 4).toString() !== 'PNG') throw new Error('PNG 아님'); return `${nodes(s.root).length}개 · png ${png.readUInt32BE(16)}x${png.readUInt32BE(20)} · atomic ${s.atomic}`; });
const center = (n: SemanticNode): { x: number; y: number } => ({ x: n.rect!.x + n.rect!.width / 2, y: n.rect!.y + n.rect!.height / 2 });
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 1500));
// 설정 앱: 남아 있는 모달(로그인 시트 등)을 닫고, 목록 화면에서 '일반'(push 화면)으로 들어간다
await check('버튼 탭 → push 화면', async () => {
  let t = await c.dump();
  const close = nodes(t).find((n) => n.role === 'button' && /^(닫기|Close|취소|Cancel)$/.test(n.name ?? '') && n.rect);
  if (close) { await c.tap(center(close)); await settle(); t = await c.dump(); }
  // iOS 26 은 버튼, iOS 17 은 목록 셀(group)에 이름이 있다
  const target = nodes(t).find((n) => (n.role === 'button' || n.role === 'group') && /^(일반|General)$/.test(n.name ?? '') && n.rect);
  if (!target) throw new Error("'일반' 버튼이 없음(설정 앱 목록 화면이 아님)");
  await c.tap(center(target));
  await settle();
  const after = await c.dump();
  if (JSON.stringify(after) === JSON.stringify(t)) throw new Error('화면이 그대로');
  return `${nodes(t).length} → ${nodes(after).length}개`;
});
await check('뒤로(왼쪽 가장자리 스와이프)', async () => {
  const p = await c.ping();
  const before = JSON.stringify(await c.dump());
  const h = p.screen.height * p.scale, w = p.screen.width * p.scale;
  await c.swipe({ x: p.scale, y: h / 2 }, { x: (w * 2) / 3, y: h / 2 }, 300);
  await settle();
  if (JSON.stringify(await c.dump()) === before) throw new Error('화면이 그대로');
  return '바뀜';
});
await check('입력칸 탭 → 입력 → 값', async () => {
  let box = nodes(await c.dump()).find((n) => n.role === 'textbox' && n.rect && n.rect.width > 0);
  if (!box) {
    // iOS 17 설정 앱은 검색창이 목록을 아래로 당겨야 나온다
    const p = await c.ping();
    const w = p.screen.width * p.scale, h = p.screen.height * p.scale;
    await c.swipe({ x: w / 2, y: h * 0.3 }, { x: w / 2, y: h * 0.6 }, 400);
    await settle();
    box = nodes(await c.dump()).find((n) => n.role === 'textbox' && n.rect && n.rect.width > 0);
  }
  if (!box) throw new Error('입력칸이 없음');
  await c.tap(center(box));
  await settle();
  await c.type('sinclair');
  await settle();
  const v = nodes(await c.dump()).find((n) => n.role === 'textbox' && n.value === 'sinclair');
  if (!v) throw new Error('입력한 값이 트리에 없음');
  await c.key('delete');
  await settle();
  const after = nodes(await c.dump()).find((n) => n.role === 'textbox' && n.value === 'sinclai');
  if (!after) throw new Error('delete 키가 한 글자를 지우지 않음');
  return '값 확인 · delete 확인';
});
await check('지원하지 않는 키는 400(러너는 계속 돎)', async () => { try { await c.key('upArrow'); } catch (e) { if (/400/.test((e as Error).message)) { await c.ping(); return '거부 후 ping 성공'; } throw e; } return '입력됨(포커스 있음)'; });
await check('홈 버튼', async () => { await c.button('home'); await new Promise((r) => setTimeout(r, 1000)); const f = await c.foreground(); return `앞 화면 ${f ?? '홈'}`; });

for (const [n, ok, d] of results) console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}: ${d}`);
console.log(`${results.filter((r) => r[1]).length}/${results.length}`);
process.exit(results.every((r) => r[1]) ? 0 : 1);
