// Studio 메인 프로세스: 창 하나와 작업 프로세스 하나(ADR 0005). 기기·러너·에이전트는 작업 프로세스가 맡고, 메인은 중계만 한다.
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { MAX_EXPORT_BYTES, parseStudioRequest, STUDIO_CHANNELS } from '../shared/studio-ipc.ts';
import { createWorkerHost, resolveWorkerNode } from './worker-host.ts';
import { createSettingsStore } from './settings-store.ts';
import { isConsoleUrl } from '../shared/console-link.ts';
import * as os from 'node:os';

let win: BrowserWindow | undefined;
const worker = createWorkerHost({
  node: resolveWorkerNode(process.env),
  script: path.join(import.meta.dirname, 'worker.js'),
  onStatus: (s) => win?.webContents.send(STUDIO_CHANNELS.workerStatusChanged, s),
  onEvent: (e) => win?.webContents.send(STUDIO_CHANNELS.event, e),
});

// 검증 훅(verify-studio): SINCLAIR_STUDIO_USER_DATA 면 userData 를 거기로(사용자의 설정 파일을 건드리지 않게)
if (process.env.SINCLAIR_STUDIO_USER_DATA) app.setPath('userData', process.env.SINCLAIR_STUDIO_USER_DATA);
// 설정(studio-console 03): userData/settings.json — 렌더러는 검증된 값만 쓸 수 있다
const settings = createSettingsStore(path.join(app.getPath('userData'), 'settings.json'), os.homedir());
ipcMain.handle(STUDIO_CHANNELS.getSettings, () => settings.get());
ipcMain.handle(STUDIO_CHANNELS.setSettings, (_e, raw: unknown) => settings.set(raw));
ipcMain.handle(STUDIO_CHANNELS.workerStatus, () => worker.status());
ipcMain.handle(STUDIO_CHANNELS.ping, () => worker.ping());
// 렌더러는 믿지 않는다: 닫힌 요청 집합만 작업 프로세스로
ipcMain.handle(STUDIO_CHANNELS.request, async (_e, raw: unknown) => {
  const req = parseStudioRequest(raw);
  if (!req) throw new Error('알 수 없는 요청');
  // Cycle 로 실행·상태: control-plane 주소·테스트 폴더는 설정에서(렌더러가 경로·주소를 정하지 못한다)
  if (req.kind === 'run-cycle' || req.kind === 'cycle-status' || req.kind === 'open-requests' || req.kind === 'open-ack') {
    const s = await settings.get();
    return worker.request({ ...req, controlPlane: s.controlPlane, ...(req.kind === 'run-cycle' ? { testsDir: s.testsDir } : {}) } as never);
  }
  return worker.request(req as never);
});
ipcMain.handle(STUDIO_CHANNELS.openConsole, async (_e, url: unknown) => {
  const s = await settings.get();
  if (typeof url !== 'string' || !isConsoleUrl(url, s.controlPlane)) throw new Error('설정의 control-plane Console 주소가 아님');
  await shell.openExternal(url);
});

// 내보낸 테스트 저장: 사용자가 저장 대화상자에서 고른 경로에만 쓴다(렌더러가 경로를 정하지 못한다)
ipcMain.handle(STUDIO_CHANNELS.saveTestFile, async (_e, suggested: unknown, content: unknown) => {
  if (typeof content !== 'string' || Buffer.byteLength(content) > MAX_EXPORT_BYTES) throw new Error('내보낼 코드가 올바르지 않음');
  const name = typeof suggested === 'string' && /^[\p{L}\p{N} ._-]{1,80}$/u.test(suggested) ? suggested : 'studio-test';
  const r = await dialog.showSaveDialog({ title: '테스트로 저장', defaultPath: `${name}.sinclair.ts`, filters: [{ name: 'Sinclair 테스트', extensions: ['ts'] }] });
  if (r.canceled || !r.filePath) return null;
  await writeFile(r.filePath, content, 'utf8');
  return r.filePath;
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
