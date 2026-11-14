// Studio 메인 프로세스: 창 하나와 작업 프로세스 하나(ADR 0005). 기기·러너·에이전트는 작업 프로세스가 맡고, 메인은 중계만 한다.
import { app, BrowserWindow, ipcMain } from 'electron';
import * as path from 'node:path';
import { parseStudioRequest, STUDIO_CHANNELS } from '../shared/studio-ipc.ts';
import { createWorkerHost, resolveWorkerNode } from './worker-host.ts';

let win: BrowserWindow | undefined;
const worker = createWorkerHost({
  node: resolveWorkerNode(process.env),
  script: path.join(import.meta.dirname, 'worker.js'),
  onStatus: (s) => win?.webContents.send(STUDIO_CHANNELS.workerStatusChanged, s),
});

ipcMain.handle(STUDIO_CHANNELS.workerStatus, () => worker.status());
ipcMain.handle(STUDIO_CHANNELS.ping, () => worker.ping());
// 렌더러는 믿지 않는다: 닫힌 요청 집합만 작업 프로세스로
ipcMain.handle(STUDIO_CHANNELS.request, (_e, raw: unknown) => {
  const req = parseStudioRequest(raw);
  if (!req) throw new Error('알 수 없는 요청');
  return worker.request(req as never);
});

function createWindow(): void {
  win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 960, minHeight: 600, title: 'Sinclair Studio',
    webPreferences: { preload: path.join(import.meta.dirname, '../preload/index.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  win.on('closed', () => { win = undefined; });
  // 검증 훅(verify-studio): SINCLAIR_STUDIO_SCREENSHOT=<png> 면 그려진 뒤(작업 프로세스 준비까지) 창을 캡처해 저장하고 끝낸다
  const shot = process.env.SINCLAIR_STUDIO_SCREENSHOT;
  if (shot) {
    win.webContents.once('did-finish-load', () => {
      void worker.ready().catch(() => {}).then(() => new Promise((r) => setTimeout(r, Number(process.env.SINCLAIR_STUDIO_SCREENSHOT_DELAY_MS) || 1_500))).then(async () => {
        const img = await win!.webContents.capturePage();
        const { writeFile } = await import('node:fs/promises');
        await writeFile(shot, img.toPNG());
        app.quit();
      });
    });
  }
  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else void win.loadFile(path.join(import.meta.dirname, '../renderer/index.html'));
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
// 작업 프로세스를 정리하고 끝낸다(고아로 남아 기기를 잡고 있지 않게)
let quitting = false;
app.on('before-quit', (e) => {
  if (quitting) return;
  quitting = true;
  e.preventDefault();
  void worker.stop().finally(() => app.quit());
});
