// 설치본 환경(studio-packaging 01): Finder·Dock 으로 띄운 앱은 셸 환경변수(API 키·사내망 CA)가 없다.
// CLI 와 같은 ~/.config/sinclair/env(또는 SINCLAIR_ENV_FILE)에서 허용한 이름만 작업 프로세스에 싣는다 — PATH·DYLD_*·NODE_OPTIONS 같은 실행을 바꾸는 이름은 받지 않는다.
// 프로세스 환경이 이긴다. 메인 프로세스 모듈이라 워크스페이스 패키지를 import 하지 않는다.
import * as path from 'node:path';

export const ENV_FILE_DEFAULT = (home: string): string => path.join(home, '.config', 'sinclair', 'env');
const ALLOWED = /^(ANTHROPIC_[A-Z0-9_]+|SINCLAIR_[A-Z0-9_]+|NODE_EXTRA_CA_CERTS)$/;

export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(raw);
    if (!m || !ALLOWED.test(m[1]!)) continue;
    let v = m[2]!.trim();
    if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) v = v.slice(1, -1);
    out[m[1]!] = v;
  }
  return out;
}

/** 작업 프로세스 환경: 파일 값 위에 프로세스 환경 */
export function workerEnv(env: NodeJS.ProcessEnv, fileText: string | undefined): NodeJS.ProcessEnv {
  return { ...(fileText ? parseEnvFile(fileText) : {}), ...env };
}
