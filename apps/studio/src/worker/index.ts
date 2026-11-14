// Studio 작업 프로세스(ADR 0005): plain Node 로 돌아 기기·러너·에이전트를 맡는다. 지금(studio 01)은 IPC 왕복만.
// Electron 의 Node(BoringSSL)가 아니라 순정 Node 라 TLS·사내망 CA·네이티브 모듈(node-usb) 경로가 runner-agent 와 같다.
import type { FromWorker, ToWorker } from '../shared/studio-ipc.ts';

const send = (m: FromWorker): void => { process.send?.(m); };

process.on('message', (raw: unknown) => {
  const m = raw as ToWorker;
  if (m?.type === 'ping' && typeof m.id === 'string') {
    const reply = () => send({ type: 'pong', id: m.id, node: process.version, pid: process.pid });
    if (m.delayMs) setTimeout(reply, m.delayMs); else reply();
  }
});
// 메인이 사라지면(IPC 끊김) 곧바로 끝난다 — 고아로 남아 기기를 잡고 있지 않게
process.on('disconnect', () => process.exit(0));
send({ type: 'ready', node: process.version, pid: process.pid });
