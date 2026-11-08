// 자산(헬퍼 APK 등) 위치 규칙. 설치본: 실행 파일 옆 ../resources. 개발: 소스 트리. 환경변수 SINCLAIR_RESOURCES_DIR 가 최우선.
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

/** esbuild define 으로 번들에서는 "1" 로 고정된다 */
export const isBundled = (): boolean => process.env.SINCLAIR_BUNDLED === '1';

/** 번들이면 <dist>/../resources, 개발이면 apps/runner-agent/resources */
export function resourcesDir(moduleUrl: string = import.meta.url, env: NodeJS.ProcessEnv = process.env): string {
  if (env.SINCLAIR_RESOURCES_DIR) return env.SINCLAIR_RESOURCES_DIR;
  const here = path.dirname(fileURLToPath(moduleUrl));
  return isBundled() ? path.resolve(here, '..', 'resources') : path.resolve(here, '..', 'resources');
}
