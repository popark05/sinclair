// 서버 엔트리: 설정 → 저장소 → HTTP → READY 로그 → 신호에 정상 종료. bin/sinclair-control-plane.mjs 가 부른다.
// 종료 코드: 0 정상, 2 설정 오류·DB 열기 실패(스키마 버전 등).
import { parseConfig, ConfigError, HELP, type ControlPlaneConfig } from './config.ts';
import { createMemoryEventStore } from './store.ts';
import { createMemoryCycleStore } from './cycle-store.ts';
import { createSqliteCycleStore, createSqliteEventStore, createSqliteFleetStore, openSqlite, SQLITE_SCHEMA_VERSION } from './sqlite-store.ts';
import { createMemoryFleetStore } from './fleet.ts';
import { serveControlPlane, type ControlPlaneServer } from './http.ts';

export interface RunningControlPlane { server: ControlPlaneServer; config: ControlPlaneConfig; close(): Promise<void> }

/** 설정대로 저장소를 열고 서버를 띄운다. 테스트와 bin 이 같이 쓴다 */
export async function startControlPlane(config: ControlPlaneConfig): Promise<RunningControlPlane> {
  const db = config.store === 'sqlite' ? openSqlite(config.db) : undefined;
  const events = db ? createSqliteEventStore(db) : createMemoryEventStore();
  const cycles = db ? createSqliteCycleStore(db) : createMemoryCycleStore();
  const fleet = db ? createSqliteFleetStore(db) : createMemoryFleetStore();
  const server = await serveControlPlane(events, { host: config.host, port: config.port, cycles, fleet, ...(config.leaseTtlMs !== undefined ? { leaseTtlMs: config.leaseTtlMs } : {}), ...(config.consoleDir ? { consoleDir: config.consoleDir } : {}) });
  let closed = false;
  return {
    server, config,
    async close() {
      if (closed) return;
      closed = true;
      await server.close();
      await events.close?.();
    },
  };
}

export async function main(argv = process.argv.slice(2), env = process.env): Promise<number> {
  let config: ControlPlaneConfig;
  try {
    const parsed = parseConfig(argv, env);
    if ('help' in parsed) { process.stdout.write(HELP); return 0; }
    config = parsed;
  } catch (err) {
    if (err instanceof ConfigError) { console.error(`설정 오류: ${err.message}\n\n${HELP}`); return 2; }
    throw err;
  }

  let running: RunningControlPlane;
  try {
    running = await startControlPlane(config);
  } catch (err) {
    console.error(`기동 실패: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }
  const storeDesc = config.store === 'sqlite' ? `sqlite db=${config.db} schema=${SQLITE_SCHEMA_VERSION}` : 'memory';
  // verify-ingest 의 start.sh 가 이 줄을 파싱한다: READY 로 시작, port=<n>
  console.log(`READY http://${config.host}:${running.server.port} port=${running.server.port} store=${storeDesc} pid=${process.pid}`);

  return new Promise<number>((resolve) => {
    let stopping = false;
    const stop = (signal: string) => {
      if (stopping) { console.log(`${signal} 두 번째 수신, 즉시 종료`); resolve(130); return; }
      stopping = true;
      console.log(`${signal} 수신, 종료 중`);
      void running.close().then(() => { console.log('종료 완료(연결·DB 닫힘)'); resolve(0); }, (err: unknown) => { console.error(`종료 중 오류: ${err instanceof Error ? err.message : String(err)}`); resolve(1); });
    };
    // Windows 에는 SIGTERM 이 없고 SIGINT(Ctrl-C)만 온다. bin 셸이 자식을 kill 하면 정상 close 없이 끝난다
    process.on('SIGTERM', () => stop('SIGTERM'));
    process.on('SIGINT', () => stop('SIGINT'));
  });
}
