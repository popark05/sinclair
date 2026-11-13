// 녹화 재생(recording-cache 02): 녹화한 액션을 모델 없이 다시 한다. 대상은 녹화한 정체 필드(역할·이름 또는 글자·testId·placeholder)가
// 모두 같은 노드가 현재 화면에 정확히 하나일 때만 실행한다(가중치 점수 없음 — 비슷한 노드를 잘못 누르지 않게). 없으면 잠시 기다리고, 둘 이상이면 곧바로 멈춘다.
// 끝에는 녹화한 끝 anchor 가 모두 보이고 재생 전과 화면이 달라졌는지 본다. 어긋나면 이유와 이미 한 액션을 돌려준다 — 이어받기는 호출자(러너) 몫.
import { EngineError, type CacheEntry, type CacheTarget, type Engine, type SemanticNode } from '@sinclair/protocol';
import { ACTIONS } from './action-spec.ts';
import { appPackageOf } from './incidents.ts';
import { SecretBox } from './secrets.ts';

export interface ReplayOptions {
  /** act 의 목표(비밀값은 목표에 나온 이름만 채운다 — 라이브 act 와 같은 규칙) */
  goal: string;
  secrets?: SecretBox;
  /** 대상이 0개일 때 기다리는 상한(기본 3초, 100·300·600·1000ms 간격) */
  findTimeoutMs?: number;
  /** 끝 anchor 를 기다리는 상한(기본 5초) */
  endTimeoutMs?: number;
}
export type ReplayResult =
  | { outcome: 'replayed'; executed: number; total: number; done: string[] }
  /** 첫 액션 전에 멈춤: 아무것도 하지 않았다 — 호출자는 처음부터 라이브로 */
  | { outcome: 'missed'; executed: 0; total: number; done: []; reason: string }
  /** 액션을 하나 이상 한 뒤 멈춤: 그 화면부터 이어받아야 한다 */
  | { outcome: 'diverged'; executed: number; total: number; done: string[]; reason: string };

const BACKOFF_MS = [100, 300, 600, 1000];
const END_POLL_MS = 200;
const labelOf = (n: SemanticNode): string | undefined => n.name ?? n.text;
function* walk(n: SemanticNode): Generator<SemanticNode> { yield n; for (const c of n.children ?? []) yield* walk(c); }
const sameField = (a: string | undefined, b: string | undefined): boolean => (a ?? undefined) === (b ?? undefined);

/** 녹화한 정체 필드가 모두 같은 노드들(녹화에 없는 필드는 현재 노드에도 없어야 한다) */
export function exactMatches(target: CacheTarget, root: SemanticNode): SemanticNode[] {
  const out: SemanticNode[] = [];
  for (const n of walk(root)) {
    if (n.role !== target.role) continue;
    if (sameField(labelOf(n), target.label) && sameField(n.testId, target.testId) && sameField(n.placeholder, target.placeholder)) out.push(n);
  }
  return out;
}

const describe = (t: CacheTarget): string => `${t.role}${t.label ? ` "${t.label}"` : t.placeholder ? ` [${t.placeholder}]` : ''}`;
/** 화면 정체: 노드마다 역할·이름(글자)·testId — 재생이 화면을 바꿨는지 볼 때 */
const signature = (root: SemanticNode): string => [...walk(root)].map((n) => `${n.role}|${labelOf(n) ?? ''}|${n.testId ?? ''}`).join('\n');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function replayRecording(engine: Engine, entry: CacheEntry, opts: ReplayOptions): Promise<ReplayResult> {
  const total = entry.actions.length;
  const done: string[] = [];
  const stop = (reason: string): ReplayResult => (done.length === 0 ? { outcome: 'missed', executed: 0, total, done: [], reason } : { outcome: 'diverged', executed: done.length, total, done: [...done], reason });
  const findTimeoutMs = opts.findTimeoutMs ?? 3_000;
  const goalSecrets = new Set(SecretBox.mentioned(opts.goal));

  const first = await engine.observe();
  const app = appPackageOf(first.root);
  if (entry.start.app && app && entry.start.app !== app) return stop(`시작 앱이 다름(녹화 ${entry.start.app}, 지금 ${app})`);
  const startSig = signature(first.root);

  for (const [i, a] of entry.actions.entries()) {
    const at = `${i + 1}/${total} ${a.summary}`;
    let ref: string | undefined;
    if (a.target) {
      const deadline = Date.now() + findTimeoutMs;
      for (let k = 0; ; k++) {
        const m = exactMatches(a.target, (await engine.observe()).root);
        if (m.length === 1) { ref = m[0]!.ref; break; }
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
    try {
      await ACTIONS[a.tool].run(engine, input);
    } catch (err) {
      // 기기 문제는 재생이 고칠 수 없다: 그대로 던져 러너가 blocked 로 다룬다
      if (err instanceof EngineError && (err.code === 'device-unavailable' || err.code === 'engine-closed')) throw err;
      return stop(`${at}: 실행 오류 — ${err instanceof Error ? err.message : String(err)}`);
    }
    done.push(a.summary);
  }

  // 끝 확인: anchor 가 모두 보이고(각각 하나 이상), 재생 전과 화면이 달라졌다
  const endDeadline = Date.now() + (opts.endTimeoutMs ?? 5_000);
  let missing: CacheTarget | undefined;
  for (;;) {
    const root = (await engine.observe()).root;
    missing = entry.end.anchors.find((t) => exactMatches(t, root).length === 0);
    const changed = signature(root) !== startSig;
    if (!missing && changed) return { outcome: 'replayed', executed: total, total, done };
    if (Date.now() >= endDeadline) return stop(missing ? `끝 화면에 ${describe(missing)} 이 없음` : '재생 뒤 화면이 바뀌지 않음');
    await sleep(END_POLL_MS);
  }
}
