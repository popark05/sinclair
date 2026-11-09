// Incident 감지·복구 규칙표: 트리 특징(resource-id 의 패키지·id)으로 권한 요청·앱 오류·런처로 튕김을 알아보고 결정적 복구를 고른다.
import { describe, it, expect } from 'vitest';
import { detectIncident, packageOf } from '../src/index.ts';
import { APP, PERMISSION, CRASH, ANR, LAUNCHER, node, tree } from './fixtures/incident-screens.ts';

describe('packageOf', () => {
  it('resource-id 의 패키지 중 가장 많은 것', () => {
    expect(packageOf(APP)).toBe('com.shop');
    expect(packageOf(tree({ ref: '@x', role: 'text', text: '아이디 없음' }))).toBeUndefined();
  });
});

describe('detectIncident', () => {
  const ctx = { appPackage: 'com.shop' };
  it('평소 앱 화면은 Incident 가 아니다', () => {
    expect(detectIncident(APP, ctx)).toBeUndefined();
  });

  it('권한 요청: 기본은 "앱 사용 중에만 허용", 정책 deny 면 "허용 안함"', () => {
    expect(detectIncident(PERMISSION, ctx)).toMatchObject({ kind: 'permission', recovery: { kind: 'tap', ref: '@p2', label: '앱 사용 중에만 허용' } });
    expect(detectIncident(PERMISSION, { ...ctx, policy: { permission: 'deny' } })).toMatchObject({ recovery: { kind: 'tap', ref: '@p4' } });
    const plain = tree(node('@q1', 'button', 'com.android.permissioncontroller:id/permission_allow_button', '허용'), node('@q2', 'button', 'com.android.permissioncontroller:id/permission_deny_button', '거부'));
    expect(detectIncident(plain, ctx)).toMatchObject({ recovery: { kind: 'tap', ref: '@q1' } });
  });

  it('앱 오류: 충돌은 닫고 다시 열기, ANR 은 대기', () => {
    expect(detectIncident(CRASH, ctx)).toMatchObject({ kind: 'app-error', recovery: { kind: 'tap-then-reopen', ref: '@c2' } });
    expect(detectIncident(ANR, ctx)).toMatchObject({ kind: 'app-error', recovery: { kind: 'tap', ref: '@n3', label: '대기' } });
  });

  it('런처로 튕기면 다시 열기, 다른 앱(브라우저 로그인 등)은 결정적 복구 없이 알리기만', () => {
    expect(detectIncident(LAUNCHER, ctx)).toMatchObject({ kind: 'left-app', recovery: { kind: 'reopen' } });
    const browser = tree(node('@b1', 'textbox', 'com.android.chrome:id/url_bar', 'accounts.example.com'));
    const other = detectIncident(browser, ctx)!;
    expect(other).toMatchObject({ kind: 'left-app' });
    expect(other).not.toHaveProperty('recovery');
    expect(detectIncident(browser, {})).toBeUndefined(); // 시작 앱을 모르면 다른 앱인지 알 수 없다
  });

  it('같은 상황은 같은 signature(되풀이 감지용)', () => {
    expect(detectIncident(PERMISSION, ctx)!.signature).toBe(detectIncident(structuredClone(PERMISSION), ctx)!.signature);
    expect(detectIncident(PERMISSION, ctx)!.signature).not.toBe(detectIncident(CRASH, ctx)!.signature);
  });
});
