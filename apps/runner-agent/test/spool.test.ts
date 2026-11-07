// @vitest-environment node
// 스풀 Reporter: 파일에 먼저 쓰고 보낸다. 서버가 없으면 스풀만 남고, resume 이 이어 보내며, 재전송은 Ingest 가 duplicate 로 흡수한다.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { RunEvent } from '@sinclair/protocol';
import { startControlPlane, type RunningControlPlane } from '@sinclair/control-plane';
import { createSpoolReporter, resumeSpool, spoolFiles, writeAck, readAck } from '../src/index.ts';

const at = (s: number) => `2026-11-08T00:00:${String(s % 60).padStart(2, '0')}.000Z`;
const base = (id: string, s: number, runId = 'r1') => ({ schema: 1 as const, eventId: id, runId, at: at(s) });
const RUN: RunEvent[] = [
  { ...base('e0', 0), type: 'run.started', targetId: 'android', cycleId: 'c1' },
  { ...base('e1', 1), type: 'attempt.started', attemptId: 'a1', testId: 'T', attemptNo: 1 },
  { ...base('e2', 2), type: 'step.recorded', attemptId: 'a1', stepIndex: 0, kind: 'assert', modelCalls: 0, durationMs: 3 },
  { ...base('e3', 3), type: 'attempt.finished', attemptId: 'a1', result: 'passed', artifacts: [] },
  { ...base('e4', 4), type: 'run.finished', state: 'finished' },
];
const fast = { batchSize: 2, flushIntervalMs: 20, backoffMs: 5, maxBackoffMs: 20, maxRetryMs: 150 };

let dir: string;
let cp: RunningControlPlane | undefined;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sinclair-spool-')); });
afterEach(async () => { await cp?.close(); cp = undefined; fs.rmSync(dir, { recursive: true, force: true }); });
const startCp = async () => { cp = await startControlPlane({ host: '127.0.0.1', port: 0, store: 'memory', db: '(무시)' }); return `http://127.0.0.1:${cp.server.port}`; };
const viewOf = async (url: string, runId = 'r1') => (await fetch(`${url}/runs/${runId}`)).text();
/** 같은 이벤트를 한 번만 직접 넣은 별도 Ingest 의 투영(비교 기준) */
const directView = async (events: RunEvent[], runId = 'r1') => {
  const once = await startControlPlane({ host: '127.0.0.1', port: 0, store: 'memory', db: '(무시)' });
  try { await fetch(`http://127.0.0.1:${once.server.port}/ingest`, { method: 'POST', body: JSON.stringify(events) }); return await viewOf(`http://127.0.0.1:${once.server.port}`, runId); }
  finally { await once.close(); }
};

describe('createSpoolReporter', () => {
  it('이벤트는 발생 즉시 jsonl 에 쌓이고, flush 뒤 ack 가 끝까지 전진하며 투영은 직접 전송과 같다', async () => {
    const url = await startCp();
    const r = createSpoolReporter({ dir, runId: 'r1', controlPlane: url, ...fast });
    for (const e of RUN) r.onEvent(e);
    expect(fs.readFileSync(r.files.events, 'utf8').split('\n').filter(Boolean)).toHaveLength(5); // 전송 전에 이미 디스크에
    await r.flush();
    expect(readAck(r.files.ack)).toBe(5);
    await r.close();
    expect(r.stats).toMatchObject({ written: 5, acked: 5, accepted: 5, duplicate: 0 });
    expect(r.warnings).toEqual([]);
    expect(await viewOf(url)).toBe(await directView(RUN));
    expect(fs.readdirSync(dir)).toEqual([]); // 다 보낸 스풀은 close 가 치운다
  });

  it('meta 에 control-plane 주소가 남는다', async () => {
    const dead = await startCp(); await cp!.close(); cp = undefined;
    const r = createSpoolReporter({ dir, runId: 'r1', controlPlane: dead, cycleId: 'c1', targetId: 'android', ...fast });
    r.onEvent(RUN[0]!);
    await r.flush(); await r.close();
    expect(JSON.parse(fs.readFileSync(r.files.meta, 'utf8'))).toMatchObject({ runId: 'r1', controlPlane: dead, cycleId: 'c1', targetId: 'android' });
  });

  it('서버가 없으면 재시도 예산 뒤 경고와 함께 돌아오고 스풀에 전부 남는다; 서버를 띄우고 resume 하면 투영이 같고 파일이 지워진다', async () => {
    const dead = await startCp(); await cp!.close(); cp = undefined; // 닫힌 포트
    const r = createSpoolReporter({ dir, runId: 'r1', controlPlane: dead, ...fast });
    for (const e of RUN) r.onEvent(e);
    const started = Date.now();
    await r.flush(); await r.close();
    expect(Date.now() - started).toBeLessThan(2000);
    expect(r.warnings).toEqual([expect.stringMatching(/미전송 5건.*resume/)]);
    expect(readAck(r.files.ack)).toBe(0);
    expect(r.stats.retries).toBeGreaterThan(0);

    const url = await startCp();
    const log: string[] = [];
    const result = await resumeSpool({ dir, controlPlane: url, maxRetryMs: 500, backoffMs: 5, log: (l) => log.push(l) });
    expect(result).toEqual({ resumed: ['r1'], pending: [], warnings: [] });
    expect(log[0]).toMatch(/r1: 완료 \(ack 0 → 5/);
    expect(await viewOf(url)).toBe(await directView(RUN));
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('ack 가 뒤처진 채 resume 하면 재전송되지만 Ingest 가 duplicate 로 흡수해 투영이 같다 (resume 은 meta 의 주소를 쓴다)', async () => {
    const url = await startCp();
    const r = createSpoolReporter({ dir, runId: 'r1', controlPlane: url, ...fast });
    for (const e of RUN) r.onEvent(e);
    await r.flush(); // close 없이 프로세스가 죽은 상황(close 는 다 보낸 스풀을 치운다)
    writeAck(r.files.ack, 2); // 전송 중 죽어 ack 가 못 따라온 상황
    const result = await resumeSpool({ dir, maxRetryMs: 500, backoffMs: 5 });
    expect(result.resumed).toEqual(['r1']);
    expect(await viewOf(url)).toBe(await directView(RUN));
  });

  it('손상된 마지막 줄(부분 쓰기)은 건너뛰고 경고하며 나머지는 보낸다', async () => {
    const url = await startCp();
    const files = spoolFiles(dir, 'r1');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(files.events, RUN.slice(0, 4).map((e) => JSON.stringify(e)).join('\n') + '\n' + '{"schema":1,"eventId":"e4","runId":"r1","at":"2026-11-08T00:00:04.000Z","type":"run.fin');
    fs.writeFileSync(files.meta, JSON.stringify({ runId: 'r1', controlPlane: url, createdAt: at(0) }));
    const result = await resumeSpool({ dir, maxRetryMs: 500, backoffMs: 5 });
    expect(result.resumed).toEqual(['r1']);
    expect(result.warnings).toEqual([expect.stringMatching(/5번째 줄 건너뜀\(마지막 줄, 부분 쓰기로 보임\)/)]);
    expect(JSON.parse(await viewOf(url))).toMatchObject({ state: 'running', attempts: [{ result: 'passed' }] }); // run.finished 는 유실(경고로 드러남)
  });

  it('서버가 run 도중에 내려갔다 올라오면 flush 가 이어 보낸다 (같은 포트 재기동)', async () => {
    const url = await startCp();
    const port = cp!.server.port;
    const r = createSpoolReporter({ dir, runId: 'r1', controlPlane: url, ...fast, maxRetryMs: 5_000 });
    r.onEvent(RUN[0]!); r.onEvent(RUN[1]!);
    for (let i = 0; i < 200 && r.stats.acked < 2; i++) await new Promise((x) => setTimeout(x, 10)); // 첫 배치 ack
    expect(r.stats.acked).toBe(2);
    await cp!.close(); cp = undefined;
    r.onEvent(RUN[2]!); r.onEvent(RUN[3]!); r.onEvent(RUN[4]!);
    for (let i = 0; i < 200 && r.stats.retries === 0; i++) await new Promise((x) => setTimeout(x, 10)); // 연결 거부를 겪는다
    cp = await startControlPlane({ host: '127.0.0.1', port, store: 'memory', db: '(무시)' });
    await r.flush();
    expect(r.warnings).toEqual([]);
    expect(readAck(r.files.ack)).toBe(5);
    await r.close();
    expect(JSON.parse(await viewOf(url))).toMatchObject({ state: 'finished', attempts: [{ result: 'passed' }] }); // 재기동 전 배치는 새 서버에 없다(메모리) — 그래도 이후 배치는 도착
  });
});
