// control-plane 를 띄운다. 사용: node --experimental-transform-types serve.ts <RUN_DIR>
// 저장소: SINCLAIR_INGEST_STORE=memory(기본) | sqlite (파일은 <RUN_DIR>/control-plane.db, SINCLAIR_INGEST_DB 로 바꿀 수 있다)
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createMemoryEventStore, createSqliteEventStore, serveControlPlane } from '../../../../apps/control-plane/src/index.ts';

const runDir = process.argv[2];
if (!runDir) { console.error('RUN_DIR 필요'); process.exit(1); }
fs.mkdirSync(path.join(runDir, 'evidence'), { recursive: true });
const kind = process.env.SINCLAIR_INGEST_STORE === 'sqlite' ? 'sqlite' : 'memory';
const dbFile = process.env.SINCLAIR_INGEST_DB ?? path.join(runDir, 'control-plane.db');
const store = kind === 'sqlite' ? createSqliteEventStore(dbFile) : createMemoryEventStore();
const server = await serveControlPlane(store);
fs.writeFileSync(path.join(runDir, 'server.json'), JSON.stringify({ port: server.port, pid: process.pid, store: kind, ...(kind === 'sqlite' ? { db: dbFile } : {}) }));
console.log(`READY port=${server.port} store=${kind}${kind === 'sqlite' ? ` db=${dbFile}` : ''} runDir=${runDir}`);
const stop = async () => { await server.close(); await store.close?.(); process.exit(0); };
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
