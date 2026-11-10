// 아티팩트 저장소: run 이 신고한(attempt.finished.artifacts) 파일 — 실패 스크린샷·화면 트리 — 의 바이트. 메모리 또는 디렉터리.
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export interface ArtifactStore {
  put(runId: string, key: string, bytes: Uint8Array): Promise<void>;
  get(runId: string, key: string): Promise<Uint8Array | undefined>;
}

/** 키: 러너가 만드는 `<attemptId>.<kind>.<ext>` 모양. 경로 문자·숨김 파일은 받지 않는다 */
export const ARTIFACT_KEY = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,199}$/;
/** 기본 크기 상한: 폰 스크린샷 PNG(수 MB)와 화면 트리 JSON 에 넉넉하고, 인증 없는 서버에서 디스크를 한 번에 채우지 못하게 */
export const DEFAULT_MAX_ARTIFACT_BYTES = 20 * 1024 * 1024;

export const ARTIFACT_MIME: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.json': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.mp4': 'video/mp4' };

export function createMemoryArtifactStore(): ArtifactStore {
  const m = new Map<string, Uint8Array>();
  return {
    async put(runId, key, bytes) { m.set(`${runId}\u0000${key}`, bytes); },
    async get(runId, key) { return m.get(`${runId}\u0000${key}`); },
  };
}

/** <dir>/<runId 를 encodeURIComponent 한 이름>/<key>. run id 의 ':'(retry:…) 를 Windows 파일 이름에서도 쓸 수 있게 인코딩한다 */
export function createFileArtifactStore(dir: string): ArtifactStore {
  const fileOf = (runId: string, key: string) => path.join(dir, encodeURIComponent(runId).replace(/:/g, '%3A'), key);
  return {
    async put(runId, key, bytes) {
      const file = fileOf(runId, key);
      await fs.mkdir(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      await fs.writeFile(tmp, bytes);
      await fs.rename(tmp, file); // 쓰는 도중의 파일을 GET 이 읽지 않게
    },
    async get(runId, key) {
      try { return new Uint8Array(await fs.readFile(fileOf(runId, key))); } catch { return undefined; }
    },
  };
}
