// 러너(FakeEngine 샘플)를 HTTP Reporter 로 띄운 Ingest 에 흘려보낸다. 사용: node --experimental-transform-types run-sample.ts <RUN_DIR> [batchSize]
// 출력: 리포트 요약과 Reporter 통계. 증거는 <RUN_DIR>/evidence/run-sample.json
import * as fs from 'node:fs';
import * as path from 'node:path';
// testing/index.ts 는 vitest 계약 스위트를 함께 내보내므로(vitest 밖에서 import 불가) 파일을 직접 가져온다
import { FakeEngine } from '../../../../packages/protocol/src/testing/fake-engine.ts';
import { HOME_SCREEN, LOGIN_SCREEN } from '../../../../packages/protocol/src/testing/login-scenario.ts';
import { runTests, createHttpReporter } from '../../../../packages/runner/src/index.ts';

const runDir = process.argv[2];
if (!runDir) { console.error('RUN_DIR 필요'); process.exit(1); }
const batchSize = Number(process.argv[3] ?? 3);
const { port } = JSON.parse(fs.readFileSync(path.join(runDir, 'server.json'), 'utf8')) as { port: number };
const engine = new FakeEngine({ root: LOGIN_SCREEN, onTap: (n) => (n.name === '로그인' ? HOME_SCREEN : undefined) });
const reporter = createHttpReporter({ url: `http://127.0.0.1:${port}/ingest`, batchSize, flushIntervalMs: 50, backoffMs: 50 });
const fixture = path.resolve(import.meta.dirname, '../../../../apps/control-plane/test/fixtures/mixed.sinclair.ts');
const report = await runTests([fixture], { engine, timeoutMs: 500, reporter, cycleId: 'verify-cycle', deviceId: 'VERIFY1' });
const out = { runId: report.runId, summary: report.summary, events: report.events.length, stats: reporter.stats, warnings: report.warnings ?? [] };
fs.mkdirSync(path.join(runDir, 'evidence'), { recursive: true });
fs.writeFileSync(path.join(runDir, 'evidence', 'run-sample.json'), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out));
