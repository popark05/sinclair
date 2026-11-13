// 녹화 캐시(recording-cache 01): 성공한 act 가 실제로 한 액션을 재생할 수 있는 기술자로 남긴다.
// ref·위치는 화면마다 바뀌므로 넣지 않고, 정체 필드(역할·이름 또는 글자·testId·placeholder)만. 재생은 이 필드가 모두 같은 노드가 정확히 하나일 때만 실행한다.
import { CACHE_LIMITS, type CacheAction, type CacheTarget, type SemanticNode } from '@sinclair/protocol';
import type { TargetDescriptor } from './relocate.ts';

const labelOf = (n: SemanticNode): string | undefined => n.name ?? n.text;

/**
 * 녹화·재생이 같은 규칙으로 쓰는 대상 라벨: 이름, 없으면 글자, 그것도 없으면 첫 자손의 글자(문서 순서).
 * 이름 없는 줄 버튼(검색 기록 줄처럼 글자를 자식으로 가진 것)이 testId 만으로는 여럿이라 재생이 애매해지는 것을 막는다(2026-11-14 실기기 YouTube).
 */
export function cacheLabelOf(n: SemanticNode): string | undefined {
  const own = labelOf(n);
  if (own) return own;
  for (const c of n.children ?? []) { const d = cacheLabelOf(c); if (d) return d; }
  return undefined;
}

/** 녹화 기술자: 그 노드의 역할·라벨(cacheLabelOf)·testId·placeholder */
export function cacheTargetOf(n: SemanticNode): CacheTarget {
  return toCacheTarget({ role: n.role, ...(cacheLabelOf(n) ? { label: cacheLabelOf(n)!.slice(0, CACHE_LIMITS.label) } : {}), ...(n.testId ? { testId: n.testId } : {}), ...(n.placeholder ? { placeholder: n.placeholder } : {}) });
}

export function toCacheTarget(d: Pick<TargetDescriptor, 'role' | 'label' | 'testId' | 'placeholder'>): CacheTarget {
  return { role: d.role, ...(d.label ? { label: d.label } : {}), ...(d.testId ? { testId: d.testId } : {}), ...(d.placeholder ? { placeholder: d.placeholder } : {}) };
}

/** 재생 보고·이어받기 안내에 쓰는 한 줄. 입력 글자는 넣지 않는다 */
export function actionSummary(a: Pick<CacheAction, 'tool' | 'target' | 'direction'>): string {
  const t = a.target;
  const what = t ? `${t.role}${t.label ? ` "${t.label}"` : t.placeholder ? ` [${t.placeholder}]` : ''}` : '';
  return `${a.tool}${what ? ` ${what}` : ''}${a.direction ? ` ${a.direction}` : ''}`.slice(0, CACHE_LIMITS.summary);
}

/** 기술자가 가림(비밀값·개인정보)에 걸리는가 — 걸리면 그 녹화는 저장하지 않는다(가린 글자로는 재생할 수 없고, 원문은 저장소에 남기지 않는다) */
export function targetLeaks(t: CacheTarget, hide: (s: string) => string): boolean {
  return [t.label, t.testId, t.placeholder].some((v) => v !== undefined && hide(v) !== v);
}

const key = (n: SemanticNode): string => `${n.role}|${labelOf(n) ?? ''}|${n.testId ?? ''}`;
function* walk(n: SemanticNode): Generator<SemanticNode> { yield n; for (const c of n.children ?? []) yield* walk(c); }

/**
 * 끝 anchor: 결과 화면에 새로 나타난(시작 화면에 없던) 이름 있는 노드, 문서 순서로 최대 8개.
 * 바뀌는 값(두 자리 이상 숫자 — 시각·개수·날짜), 가림에 걸리는 글자, secure 노드, 결과 화면에서 같은 기술자가 둘 이상인 노드는 뺀다(재생 확인이 흔들리지 않게).
 */
export function endAnchors(start: SemanticNode | undefined, end: SemanticNode, hide: (s: string) => string): CacheTarget[] {
  const before = new Set(start ? [...walk(start)].map(key) : []);
  const counts = new Map<string, number>();
  for (const n of walk(end)) counts.set(key(n), (counts.get(key(n)) ?? 0) + 1);
  const out: CacheTarget[] = [];
  for (const n of walk(end)) {
    const label = labelOf(n);
    if (!label || n.states?.secure || before.has(key(n)) || counts.get(key(n))! > 1) continue;
    if (/\d{2,}/.test(label) || label.length > CACHE_LIMITS.label || hide(label) !== label) continue;
    const t = toCacheTarget({ role: n.role, label, ...(n.testId ? { testId: n.testId } : {}) });
    if (targetLeaks(t, hide)) continue;
    out.push(t);
    if (out.length >= CACHE_LIMITS.anchors) break;
  }
  return out;
}
