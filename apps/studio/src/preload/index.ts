// preload(CJS, 샌드박스): 렌더러에 StudioApi 만 노출한다. ipcRenderer 자체는 넘기지 않는다.
import { contextBridge, ipcRenderer } from 'electron';
import { STUDIO_CHANNELS, type ConnectionInfo, type StudioApi, type StudioDevice, type StudioSnapshot, type WorkerStatus, type AgentStatus, type JudgeView, type StudioEvent } from '../shared/studio-ipc.ts';

const api: StudioApi = {
  getWorkerStatus: () => ipcRenderer.invoke(STUDIO_CHANNELS.workerStatus) as Promise<WorkerStatus>,
  onWorkerStatus: (cb) => {
    const listener = (_e: unknown, s: WorkerStatus) => cb(s);
    ipcRenderer.on(STUDIO_CHANNELS.workerStatusChanged, listener);
    return () => { ipcRenderer.removeListener(STUDIO_CHANNELS.workerStatusChanged, listener); };
  },
  ping: () => ipcRenderer.invoke(STUDIO_CHANNELS.ping) as Promise<{ roundTripMs: number; node: string }>,
  connection: () => ipcRenderer.invoke(STUDIO_CHANNELS.request, { kind: 'connection' }) as Promise<ConnectionInfo>,
  listDevices: () => ipcRenderer.invoke(STUDIO_CHANNELS.request, { kind: 'devices' }) as Promise<StudioDevice[]>,
  foregroundApp: (deviceId) => ipcRenderer.invoke(STUDIO_CHANNELS.request, { kind: 'foreground-app', deviceId }) as Promise<string | null>,
  snapshot: (deviceId) => ipcRenderer.invoke(STUDIO_CHANNELS.request, { kind: 'snapshot', deviceId }) as Promise<StudioSnapshot>,
  tap: async (deviceId, x, y) => { await ipcRenderer.invoke(STUDIO_CHANNELS.request, { kind: 'tap', deviceId, x, y }); },
  swipe: async (deviceId, a, b, durationMs) => { await ipcRenderer.invoke(STUDIO_CHANNELS.request, { kind: 'swipe', deviceId, fromX: a.x, fromY: a.y, toX: b.x, toY: b.y, durationMs }); },
  text: async (deviceId, text) => { await ipcRenderer.invoke(STUDIO_CHANNELS.request, { kind: 'text', deviceId, text }); },
  key: async (deviceId, key) => { await ipcRenderer.invoke(STUDIO_CHANNELS.request, { kind: 'key', deviceId, key }); },
  button: async (deviceId, button) => { await ipcRenderer.invoke(STUDIO_CHANNELS.request, { kind: 'button', deviceId, button }); },
  agentStatus: () => ipcRenderer.invoke(STUDIO_CHANNELS.request, { kind: 'agent-status' }) as Promise<AgentStatus>,
  startSession: (deviceId, goal, opts) => ipcRenderer.invoke(STUDIO_CHANNELS.request, { kind: 'session-start', deviceId, goal, ...(opts?.restartApp ? { restartApp: opts.restartApp } : {}), ...(opts?.secrets && Object.keys(opts.secrets).length ? { secrets: opts.secrets } : {}) }) as Promise<{ sessionId: string }>,
  stopSession: async (sessionId) => { await ipcRenderer.invoke(STUDIO_CHANNELS.request, { kind: 'session-stop', sessionId }); },
  assertNow: (deviceId, statement) => ipcRenderer.invoke(STUDIO_CHANNELS.request, { kind: 'session-assert', deviceId, statement }) as Promise<JudgeView>,
  expectCheck: (deviceId, query, matcher, expected) => ipcRenderer.invoke(STUDIO_CHANNELS.request, { kind: 'expect-check', deviceId, query, matcher, ...(expected !== undefined ? { expected } : {}) }) as Promise<JudgeView>,
  runAsCycle: (input) => ipcRenderer.invoke(STUDIO_CHANNELS.request, { kind: 'run-cycle', ...input }),
  cycleStatus: (cycleId) => ipcRenderer.invoke(STUDIO_CHANNELS.request, { kind: 'cycle-status', cycleId }),
  openRequests: (devices) => ipcRenderer.invoke(STUDIO_CHANNELS.request, { kind: 'open-requests', devices }),
  openAck: (id) => ipcRenderer.invoke(STUDIO_CHANNELS.request, { kind: 'open-ack', id }),
  onOpenLink: (cb) => {
    const listener = (_e: unknown, id: string) => cb(id);
    ipcRenderer.on(STUDIO_CHANNELS.openLink, listener);
    return () => { ipcRenderer.removeListener(STUDIO_CHANNELS.openLink, listener); };
  },
  openConsole: (url) => ipcRenderer.invoke(STUDIO_CHANNELS.openConsole, url),
  getSettings: () => ipcRenderer.invoke(STUDIO_CHANNELS.getSettings),
  setSettings: (settings) => ipcRenderer.invoke(STUDIO_CHANNELS.setSettings, settings),
  saveRecording: (input) => ipcRenderer.invoke(STUDIO_CHANNELS.request, { kind: 'save-recording', ...input }) as Promise<{ key: string }>,
  saveTestFile: (suggestedName, content) => ipcRenderer.invoke(STUDIO_CHANNELS.saveTestFile, suggestedName, content) as Promise<string | null>,
  onEvent: (cb) => {
    const listener = (_e: unknown, ev: StudioEvent) => cb(ev);
    ipcRenderer.on(STUDIO_CHANNELS.event, listener);
    return () => { ipcRenderer.removeListener(STUDIO_CHANNELS.event, listener); };
  },
};
contextBridge.exposeInMainWorld('sinclair', api);
