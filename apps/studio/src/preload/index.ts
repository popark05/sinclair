// preload(CJS, 샌드박스): 렌더러에 StudioApi 만 노출한다. ipcRenderer 자체는 넘기지 않는다.
import { contextBridge, ipcRenderer } from 'electron';
import { STUDIO_CHANNELS, type ConnectionInfo, type StudioApi, type StudioDevice, type WorkerStatus } from '../shared/studio-ipc.ts';

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
};
contextBridge.exposeInMainWorld('sinclair', api);
