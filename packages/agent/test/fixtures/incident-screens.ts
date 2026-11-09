// Incident 테스트용 Android 모양 화면(resource-id 가 testId): 앱·권한 요청·충돌·응답 없음·런처.
import type { SemanticNode } from '@sinclair/protocol';

export const node = (ref: string, role: string, testId: string, name?: string): SemanticNode => ({ ref, role, testId, ...(name ? { name } : {}) });
export const tree = (...children: SemanticNode[]): SemanticNode => ({ ref: '@r', role: 'root', children });
export const APP = tree(node('@a1', 'text', 'com.shop:id/title', '장바구니'), node('@a2', 'button', 'com.shop:id/pay', '결제'));
export const PERMISSION = tree(
  node('@p1', 'text', 'com.android.permissioncontroller:id/permission_message', '카메라 권한을 허용하시겠습니까?'),
  node('@p2', 'button', 'com.android.permissioncontroller:id/permission_allow_foreground_only_button', '앱 사용 중에만 허용'),
  node('@p3', 'button', 'com.android.permissioncontroller:id/permission_allow_one_time_button', '이번만 허용'),
  node('@p4', 'button', 'com.android.permissioncontroller:id/permission_deny_button', '허용 안함'),
);
export const CRASH = tree(node('@c1', 'text', 'android:id/alertTitle', '쇼핑이 계속 중단됨'), node('@c2', 'button', 'android:id/aerr_close', '앱 닫기'));
export const ANR = tree(node('@n1', 'text', 'android:id/alertTitle', '쇼핑이 응답하지 않음'), node('@n2', 'button', 'android:id/aerr_close', '앱 닫기'), node('@n3', 'button', 'android:id/aerr_wait', '대기'));
export const LAUNCHER = tree(node('@l1', 'button', 'com.sec.android.app.launcher:id/icon', '카메라'), node('@l2', 'button', 'com.sec.android.app.launcher:id/icon', '쇼핑'));

