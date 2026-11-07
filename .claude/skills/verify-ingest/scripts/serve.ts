// control-plane 를 인메모리 저장소로 띄운다. 사용: node --experimental-transform-types serve.ts <RUN_DIR>
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createMemoryEventStore, serveControlPlane } from '../../../../apps/control-plane/src/index.ts';

const runDir = process.argv[2];
if (!runDir) { console.error('RUN_DIR 필요'); process.exit(1); }
fs.mkdirSync(path.join(runDir, 'evidence'), { recursive: true });
const server = await serveControlPlane(createMemoryEventStore());
fs.writeFileSync(path.join(runDir, 'server.json'), JSON.stringify({ port: server.port, pid: process.pid, store: 'memory' }));
console.log(`READY port=${server.port} store=memory runDir=${runDir}`);
const stop = async () => { await server.close(); process.exit(0); };
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
