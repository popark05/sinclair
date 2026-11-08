// 자산(헬퍼 APK 등) 위치 규칙. 환경변수 SINCLAIR_RESOURCES_DIR 가 최우선, 아니면 "이 모듈이 든 디렉터리의 형제 resources/".
// 두 배치가 같은 모양이라 식 하나로 된다: 설치본 <install>/dist/*.mjs → <install>/resources, 개발 apps/runner-agent/src/*.ts → apps/runner-agent/resources.
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

/** esbuild define 으로 번들에서는 "1" 로 고정된다 */
export const isBundled = (): boolean => process.env.SINCLAIR_BUNDLED === '1';

export function resourcesDir(): string {
  return process.env.SINCLAIR_RESOURCES_DIR || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'resources');
}
