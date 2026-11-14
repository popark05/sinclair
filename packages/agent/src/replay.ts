// 녹화 재생(recording-cache 02): 녹화한 액션을 모델 없이 다시 한다. 대상은 녹화한 정체 필드(역할·이름 또는 글자·testId·placeholder)가
// 모두 같은 노드가 현재 화면에 정확히 하나일 때만 실행한다(가중치 점수 없음 — 비슷한 노드를 잘못 누르지 않게). 없으면 잠시 기다리고, 둘 이상이면 곧바로 멈춘다.
// 끝에는 녹화한 끝 anchor 가 모두 보이고 재생 전과 화면이 달라졌는지 본다. 어긋나면 이유와 이미 한 액션을 돌려준다 — 이어받기는 호출자(러너) 몫.
import { EngineError, type CacheEntry, type CacheTarget, type Engine, type SemanticNode } from '@sinclair/protocol';
import { ACTIONS, type ActionContext } from './action-spec.ts';
import { appPackageOf } from './incidents.ts';
import { SecretBox } from './secrets.ts';
import { cacheLabelOf } from './recording.ts';

export interface ReplayOptions {
  /** act 의 목표(비밀값은 목표에 나온 이름만 채운다 — 라이브 act 와 같은 규칙) */
  goal: string;
  secrets?: SecretBox;
  /** 대상이 0개일 때 기다리는 상한(기본 3초, 100·300·600·1000ms 간격) */
  findTimeoutMs?: number;
  /** 끝 anchor 를 기다리는 상한(기본 5초) */
  endTimeoutMs?: number;
  /** 끝 확인 뒤 화면이 이만큼 바뀌지 않아야 끝낸다(기본 1.5초, 상한 settleCapMs) — 늦게 채워지는 목록(검색 결과)을 기다린다 */
  quietMs?: number;
  settleCapMs?: number;
}
export type ReplayResult =
  | { outcome: 'replayed'; executed: number; total: number; done: string[] }
  /** 첫 액션 전에 멈춤: 아무것도 하지 않았다 — 호출자는 처음부터 라이브로 */
  | { outcome: 'missed'; executed: 0; total: number; done: []; reason: string }
  /** 액션을 하나 이상 한 뒤 멈춤: 그 화면부터 이어받아야 한다 */
  | { outcome: 'diverged'; executed: number; total: number; done: string[]; reason: string; startRoot?: SemanticNode };

const BACKOFF_MS = [100, 300, 600, 1000];
const END_POLL_MS = 200;
/** 재생 끝 대기 상한. 자동재생 영상·광고가 도는 화면은 구조째 계속 바뀌어 조용해지지 않으므로 상한이 곧 비용이다 — 실기 YouTube 검색 결과는 Enter 뒤 1.2~2.3초에 마지막 변화라 4초면 덮는다(2026-11-14, 8초에서 낮춤) */
export const DEFAULT_SETTLE_CAP_MS = 4_000;
const labelOf = (n: SemanticNode): string | undefined => n.name ?? n.text;
function* walk(n: SemanticNode): Generator<SemanticNode> { yield n; for (const c of n.children ?? []) yield* walk(c); }
const sameField = (a: string | undefined, b: string | undefined): boolean => (a ?? undefined) === (b ?? undefined);

/** 녹화한 정체 필드가 모두 같은 노드들(녹화에 없는 필드는 현재 노드에도 없어야 한다) */
export function exactMatches(target: CacheTarget, root: SemanticNode, opts: { ignoreLabel?: boolean } = {}): SemanticNode[] {
  const out: SemanticNode[] = [];
  for (const n of walk(root)) {
    if (n.role !== target.role) continue;
    if (opts.ignoreLabel) { if (sameField(n.testId, target.testId)) out.push(n); continue; }
    if (sameField(cacheLabelOf(n)?.slice(0, 300), target.label) && sameField(n.testId, target.testId) && sameField(n.placeholder, target.placeholder)) out.push(n);
  }
  return out;
}

const describe = (t: CacheTarget): string => `${t.role}${t.label ? ` "${t.label}"` : t.placeholder ? ` [${t.placeholder}]` : ''}`;
/** 화면 정체: 노드마다 역할·이름(글자)·testId — 재생이 화면을 바꿨는지 볼 때 */
const signature = (root: SemanticNode): string => [...walk(root)].map((n) => `${n.role}|${labelOf(n) ?? ''}|${n.testId ?? ''}`).join('\n');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 화면이 quietMs 동안 바뀌지 않을 때까지(상한 capMs) 기다린다. 재생은 모델이 생각하는 시간이 없어 라이브보다 훨씬 빨리 끝나므로,
 * 검색 결과처럼 늦게 채워지는 화면을 뒤 스텝(판정)이 비어 있는 채로 보지 않게 한다(2026-11-14 실기기 YouTube). 상한에 닿아도 실패가 아니다
 */
async function settleQuiet(engine: Engine, sig: string, quietMs: number, capMs: number): Promise<void> {
  const start = Date.now();
  let last = sig, since = Date.now();
  while (Date.now() - since < quietMs && Date.now() - start < capMs) {
    await sleep(END_POLL_MS);
    const now = signature((await engine.observe()).root);
    if (now !== last) { last = now; since = Date.now(); }
  }
}

export async function replayRecording(engine: Engine, entry: CacheEntry, opts: ReplayOptions): Promise<ReplayResult> {
  const total = entry.actions.length;
  const done: string[] = [];
  let startRoot: SemanticNode | undefined;
  const stop = (reason: string): ReplayResult => (done.length === 0 ? { outcome: 'missed', executed: 0, total, done: [], reason } : { outcome: 'diverged', executed: done.length, total, done: [...done], reason, ...(startRoot ? { startRoot } : {}) });
  const findTimeoutMs = opts.findTimeoutMs ?? 3_000;
  const goalSecrets = new Set(SecretBox.mentioned(opts.goal));

  const first = await engine.observe();
  const app = appPackageOf(first.root);
  if (entry.start.app && app && entry.start.app !== app) return stop(`시작 앱이 다름(녹화 ${entry.start.app}, 지금 ${app})`);
  startRoot = first.root;
  const startSig = signature(first.root);

  for (const [i, a] of entry.actions.entries()) {
    const at = `${i + 1}/${total} ${a.summary}`;
    let ref: string | undefined;
    if (a.target) {
      const deadline = Date.now() + findTimeoutMs;
      for (let k = 0; ; k++) {
        const root = (await engine.observe()).root;
        const m = exactMatches(a.target, root);
        if (m.length === 1) { ref = m[0]!.ref; break; }
        // enter_secret 의 키패드: 라벨이 자식 글자(첫 키)라 섞이는 키패드에서 매번 다르다 — 역할·testId 로 하나면 그것, 아니면 화면 전체에서 키를 찾는다
        if (a.tool === 'enter_secret' && m.length === 0) {
          const loose = exactMatches({ role: a.target.role, ...(a.target.testId ? { testId: a.target.testId } : {}) }, root, { ignoreLabel: true });
          ref = loose.length === 1 ? loose[0]!.ref : '';
          if (ref || Date.now() >= deadline) break;
        }
        if (m.length > 1) return stop(`${at}: 대상 ${describe(a.target)} 이 애매함(${m.length}개)`);
        if (Date.now() >= deadline) return stop(`${at}: 대상 ${describe(a.target)} 을 찾지 못함`);
        await sleep(Math.min(BACKOFF_MS[Math.min(k, BACKOFF_MS.length - 1)]!, Math.max(0, deadline - Date.now())));
      }
    }
    const input: Record<string, string> = { ...(ref ? { ref } : {}), ...(a.direction ? { direction: a.direction } : {}) };
    if (a.tool === 'type') {
      let text = a.text ?? '';
      if (text.includes('{{secret:')) {
        const revealed = opts.secrets ? opts.secrets.reveal(text, goalSecrets) : { ok: false as const, error: '이 테스트에는 비밀값이 없음' };
        if (!revealed.ok) return stop(`${at}: 비밀값을 채울 수 없음 — ${revealed.error}`);
        text = revealed.text;
      }
      input.text = text;
    }
    // enter_secret: 녹화의 자리표시 이름으로 값을 실행 문맥에만(목표에 주어진 이름만 — 라이브와 같은 규칙)
    let ctx: ActionContext | undefined;
    if (a.tool === 'enter_secret') {
      const name = SecretBox.mentioned(a.text ?? '')[0] ?? '';
      const revealed = opts.secrets ? opts.secrets.reveal(a.text ?? '', goalSecrets) : { ok: false as const, error: '이 테스트에는 비밀값이 없음' };
      if (!revealed.ok) return stop(`${at}: 비밀값을 채울 수 없음 — ${revealed.error}`);
      input.name = name;
      ctx = { secret: (n) => (n === name ? revealed.text : undefined) };
    }
    try {
      await ACTIONS[a.tool].run(engine, input, ctx);
    } catch (err) {
      // 기기 문제는 재생이 고칠 수 없다: 그대로 던져 러너가 blocked 로 다룬다
      if (err instanceof EngineError && (err.code === 'device-unavailable' || err.code === 'engine-closed')) throw err;
      return stop(`${at}: 실행 오류 — ${err instanceof Error ? err.message : String(err)}`);
    }
    done.push(a.summary);
  }

  // 끝 확인: anchor 의 과반이 보이고(각각 하나 이상), 재생 전과 화면이 달라졌다.
  // 과반인 까닭: 끝 화면에는 자동재생 영상 버튼·광고처럼 그때그때 다른 UI 가 섞여 anchor 가 되기도 한다(2026-11-14 실기기 YouTube)
  const endDeadline = Date.now() + (opts.endTimeoutMs ?? 5_000);
  const anchors = entry.end.anchors;
  const need = Math.ceil(anchors.length / 2);
  for (;;) {
    const root = (await engine.observe()).root;
    const missing = anchors.filter((t) => exactMatches(t, root).length === 0);
    const changed = signature(root) !== startSig;
    if (anchors.length - missing.length >= need && changed) {
      await settleQuiet(engine, signature(root), opts.quietMs ?? 1_500, opts.settleCapMs ?? DEFAULT_SETTLE_CAP_MS);
      return { outcome: 'replayed', executed: total, total, done };
    }
    if (Date.now() >= endDeadline) return stop(anchors.length - missing.length < need ? `끝 화면에 ${missing.slice(0, 3).map(describe).join(', ')} 이 없음(${anchors.length - missing.length}/${anchors.length} 보임)` : '재생 뒤 화면이 바뀌지 않음');
    await sleep(END_POLL_MS);
  }
}
