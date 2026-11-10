// @vitest-environment node
// 아티팩트: run 이벤트(attempt.finished.artifacts)에 신고된 키만 PUT 으로 받아 저장하고 GET 으로 준다. 키 검사·크기 상한·content-type, 파일 저장소는 재기동 뒤에도 남는다.
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createMemoryEventStore, serveControlPlane, createFileArtifactStore, parseConfig, type ControlPlaneServer } from '../src/index.ts';

let server: ControlPlaneServer | undefined;
afterEach(async () => { await server?.close(); server = undefined; });
const url = (p: string) => `http://127.0.0.1:${server!.port}${p}`;
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const events = [
  { schema: 1, eventId: 'e1', runId: 'r1', at: '2026-11-10T00:00:00.000Z', type: 'run.started', targetId: 'android' },
  { schema: 1, eventId: 'e2', runId: 'r1', at: '2026-11-10T00:00:01.000Z', type: 'attempt.started', attemptId: 'a1', testId: 't', attemptNo: 1 },
  { schema: 1, eventId: 'e3', runId: 'r1', at: '2026-11-10T00:00:02.000Z', type: 'attempt.finished', attemptId: 'a1', result: 'failed', artifacts: [{ kind: 'screenshot', key: 'a1.screenshot.png' }, { kind: 'screen-tree', key: 'a1.screen-tree.json' }] },
];
const put = (p: string, body: Uint8Array | string) => fetch(url(p), { method: 'PUT', body });

describe('아티팩트 API', () => {
  it('신고된 키만 받아 저장하고, 확장자에 맞는 content-type 으로 준다', async () => {
    server = await serveControlPlane(createMemoryEventStore());
    await fetch(url('/ingest'), { method: 'POST', body: JSON.stringify(events) });
    expect((await put('/artifacts/r1/a1.screenshot.png', PNG)).status).toBe(201);
    expect((await put('/artifacts/r1/a1.screen-tree.json', '{"root":{}}')).status).toBe(201);
    const got = await fetch(url('/artifacts/r1/a1.screenshot.png'));
    expect(got.headers.get('content-type')).toBe('image/png');
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(PNG);
    expect((await fetch(url('/artifacts/r1/a1.screen-tree.json'))).headers.get('content-type')).toMatch(/application\/json/);
    expect((await fetch(url('/artifacts/r1/nope.png'))).status).toBe(404);
  });

  it('신고되지 않은 키·모르는 run 은 409·404, 키에 경로 문자는 400, 상한을 넘으면 413', async () => {
    server = await serveControlPlane(createMemoryEventStore(), { maxArtifactBytes: 16 });
    await fetch(url('/ingest'), { method: 'POST', body: JSON.stringify(events) });
    expect((await put('/artifacts/r1/other.png', PNG)).status).toBe(409);
    expect((await put('/artifacts/r9/a1.screenshot.png', PNG)).status).toBe(404);
    for (const bad of ['..%2fx.png', '.hidden', '%5cx.png']) expect((await put(`/artifacts/r1/${bad}`, PNG)).status, bad).toBe(400);
    expect((await put('/artifacts/r1/a1.screenshot.png', new Uint8Array(17))).status).toBe(413);
  });

  it('파일 저장소는 서버를 다시 띄워도 남는다', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sinclair-artifacts-'));
    const store = createMemoryEventStore();
    server = await serveControlPlane(store, { artifacts: createFileArtifactStore(dir) });
    await fetch(url('/ingest'), { method: 'POST', body: JSON.stringify(events) });
    await put('/artifacts/r1/a1.screenshot.png', PNG);
    await server.close();
    server = await serveControlPlane(store, { artifacts: createFileArtifactStore(dir) });
    expect(new Uint8Array(await (await fetch(url('/artifacts/r1/a1.screenshot.png'))).arrayBuffer())).toEqual(PNG);
    expect(fs.readdirSync(dir)).toEqual(['r1']);
  });
});

describe('설정 --artifacts-dir', () => {
  it('SQLite 저장소면 기본은 데이터 디렉터리/artifacts, 메모리면 없음(메모리 저장), 플래그·환경변수로 바꾼다', () => {
    expect(parseConfig([], { HOME: '/h' }, 'linux')).toMatchObject({ artifactsDir: path.join('/h', '.local', 'share', 'sinclair', 'artifacts') });
    expect(parseConfig(['--store', 'memory'], { HOME: '/h' }, 'linux')).not.toHaveProperty('artifactsDir');
    expect(parseConfig(['--artifacts-dir', '/data/a'], {}, 'linux')).toMatchObject({ artifactsDir: path.resolve('/data/a') });
    expect(parseConfig([], { SINCLAIR_CP_ARTIFACTS_DIR: '/data/b' }, 'linux')).toMatchObject({ artifactsDir: path.resolve('/data/b') });
  });
});
