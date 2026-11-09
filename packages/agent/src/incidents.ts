// Incident 감지·복구 규칙표: 목표와 무관하게 끼어드는 화면(권한 요청·앱 오류 다이얼로그·런처로 튕김)을 트리 특징으로 알아보고 결정적 복구를 고른다.
// 감지는 Android resource-id(testId, "패키지:id/이름") 에 기댄다 — 문구는 언어·제조사마다 달라 보조로만 쓴다.
// 키보드·같은 호출의 연속 실패는 화면이 아니라 액션 결과로 알 수 있어 루프(loop.ts)가 다룬다.
import type { SemanticNode } from '@sinclair/protocol';

export type IncidentKind = 'permission' | 'app-error' | 'left-app' | 'keyboard' | 'action-failed';
export type IncidentRecovery =
  | { kind: 'tap'; ref: string; label: string }
  | { kind: 'tap-then-reopen'; ref: string; label: string }
  | { kind: 'reopen' }
  | { kind: 'dismiss-keyboard' };
export interface Incident {
  kind: IncidentKind;
  /** 같은 상황이면 같은 값(되풀이 = 루프 감지) */
  signature: string;
  /** 모델·기록용 한 줄 */
  summary: string;
  /** 결정적 복구. 없으면 모델에게 알리고 한 번 묻는다 */
  recovery?: IncidentRecovery;
}
export interface IncidentPolicy {
  /** 권한 요청에 누를 버튼. 기본 allow("앱 사용 중에만 허용", 없으면 "허용"): 기능 테스트가 카메라·위치 권한 때문에 막히지 않게 */
  permission?: 'allow' | 'deny';
}
export interface IncidentContext { appPackage?: string; policy?: IncidentPolicy }

const PERMISSION_PACKAGES = new Set(['com.android.permissioncontroller', 'com.google.android.permissioncontroller', 'com.android.packageinstaller']);
const LAUNCHERS = new Set(['com.sec.android.app.launcher', 'com.google.android.apps.nexuslauncher', 'com.android.launcher3', 'com.android.launcher', 'com.miui.home', 'com.huawei.android.launcher', 'com.oppo.launcher']);
/** 시스템 창(다이얼로그 틀·상태 표시줄)은 앱이 바뀐 것으로 치지 않는다 */
const SYSTEM_PACKAGES = new Set(['android', 'com.android.systemui']);
/** 권한 버튼: 앞의 것부터. "이번만 허용" 은 다음 실행에 다시 물어 테스트가 매번 달라지므로 고르지 않는다 */
const ALLOW_IDS = ['permission_allow_foreground_only_button', 'permission_allow_button', 'permission_allow_always_button'];
const DENY_IDS = ['permission_deny_button', 'permission_deny_and_dont_ask_again_button'];
const ALLOW_NAMES = ['앱 사용 중에만 허용', '허용', 'while using the app', 'allow'];
const DENY_NAMES = ['허용 안함', '거부', "don't allow", 'deny'];

function* nodes(n: SemanticNode): Generator<SemanticNode> {
  yield n;
  for (const c of n.children ?? []) yield* nodes(c);
}
const pkgOf = (testId: string | undefined): string | undefined => (testId && testId.includes(':id/') ? testId.slice(0, testId.indexOf(':id/')) : undefined);
const idOf = (testId: string | undefined): string | undefined => (testId && testId.includes(':id/') ? testId.slice(testId.indexOf(':id/') + 4) : undefined);
const labelOf = (n: SemanticNode): string => n.name ?? n.text ?? '';

/** 화면의 resource-id 패키지 중 가장 많은 것(시스템 창 제외). resource-id 가 없으면 undefined(웹·iOS 등 — 패키지로 판단하지 않는다) */
export function packageOf(root: SemanticNode): string | undefined {
  const count = new Map<string, number>();
  for (const n of nodes(root)) { const p = pkgOf(n.testId); if (p && !SYSTEM_PACKAGES.has(p)) count.set(p, (count.get(p) ?? 0) + 1); }
  return [...count].sort((a, b) => b[1] - a[1])[0]?.[0];
}

function pick(all: SemanticNode[], ids: string[], names: string[]): SemanticNode | undefined {
  for (const id of ids) { const n = all.find((x) => idOf(x.testId) === id); if (n) return n; }
  for (const name of names) { const n = all.find((x) => labelOf(x).toLowerCase() === name); if (n) return n; }
  return undefined;
}
const sig = (kind: string, all: SemanticNode[]): string => `${kind}:${all.map((n) => n.testId ?? '').filter(Boolean).sort().join(',')}`;

export function detectIncident(root: SemanticNode, ctx: IncidentContext): Incident | undefined {
  const all = [...nodes(root)];
  // 권한 요청: 시스템 권한 창의 패키지
  if (all.some((n) => PERMISSION_PACKAGES.has(pkgOf(n.testId) ?? ''))) {
    const allow = (ctx.policy?.permission ?? 'allow') === 'allow';
    const button = allow ? pick(all, ALLOW_IDS, ALLOW_NAMES) : pick(all, DENY_IDS, DENY_NAMES);
    const message = all.find((n) => idOf(n.testId) === 'permission_message');
    return {
      // 권한마다(카메라·마이크) 다른 창으로 센다: 버튼 id 는 같고 문구만 다르다
      kind: 'permission', signature: `${sig('permission', all)}|${message ? labelOf(message) : ''}`, summary: `권한 요청${message ? ` "${labelOf(message)}"` : ''}`,
      ...(button ? { recovery: { kind: 'tap' as const, ref: button.ref, label: labelOf(button) } } : {}),
    };
  }
  // 앱 오류 다이얼로그(android:id/aerr_*): 응답 없음(ANR)은 대기, 충돌은 닫고 앱을 다시 연다
  const aerr = all.filter((n) => pkgOf(n.testId) === 'android' && idOf(n.testId)?.startsWith('aerr_'));
  if (aerr.length) {
    const title = all.find((n) => idOf(n.testId) === 'alertTitle');
    const wait = aerr.find((n) => idOf(n.testId) === 'aerr_wait');
    const close = aerr.find((n) => idOf(n.testId) === 'aerr_close');
    const recovery: IncidentRecovery | undefined = wait ? { kind: 'tap', ref: wait.ref, label: labelOf(wait) } : close ? { kind: 'tap-then-reopen', ref: close.ref, label: labelOf(close) } : undefined;
    return { kind: 'app-error', signature: sig('app-error', aerr), summary: `앱 오류${title ? ` "${labelOf(title)}"` : ''}`, ...(recovery ? { recovery } : {}) };
  }
  // 앱을 벗어남: 런처면 확실히 튕긴 것이라 다시 연다. 다른 앱(브라우저 로그인·공유 시트)은 목표의 일부일 수 있어 모델에게 알리기만
  const pkg = packageOf(root);
  if (ctx.appPackage && pkg && pkg !== ctx.appPackage) {
    if (LAUNCHERS.has(pkg)) return { kind: 'left-app', signature: `left-app:${pkg}`, summary: `앱을 벗어나 홈 화면(${pkg})`, recovery: { kind: 'reopen' } };
    return { kind: 'left-app', signature: `left-app:${pkg}`, summary: `다른 앱(${pkg})으로 넘어감 — 목표에 필요한 이동이 아니면 돌아가라` };
  }
  return undefined;
}

/** act 시작 때의 앱 패키지: 권한 창·런처·시스템 창이면 모른다고 본다 */
export function appPackageOf(root: SemanticNode): string | undefined {
  const p = packageOf(root);
  return p && !PERMISSION_PACKAGES.has(p) && !LAUNCHERS.has(p) ? p : undefined;
}
