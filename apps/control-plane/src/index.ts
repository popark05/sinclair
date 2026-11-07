// control-plane: Ingest(이벤트 멱등 저장)와 Run 조회. 구현은 specs/0001-architecture.md 의 백엔드 절을 따른다.
export { projectRun, type RunView, type AttemptView, type StepView } from './projection.ts';
export { createMemoryEventStore, type EventStore, type AppendOutcome } from './store.ts';
export { ingestBatch, type IngestResponse } from './ingest.ts';
export { serveControlPlane, summarizeRun, type ControlPlaneOptions, type ControlPlaneServer, type RunSummary } from './http.ts';
