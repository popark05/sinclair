// Studio 메인 프로세스: 창 하나와 작업 프로세스 하나(ADR 0005). 기기·러너·에이전트는 작업 프로세스가 맡고, 메인은 중계만 한다.
import { app, BrowserWindow, dialog, ipcMain, net, shell } from 'electron';
import { execFile, spawn } from 'node:child_process';
import { existsSync, openSync, readdirSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { MAX_EXPORT_BYTES, parseStudioRequest, STUDIO_CHANNELS } from '../shared/studio-ipc.ts';
import { createWorkerHost } from './worker-host.ts';
import { workerLaunch } from './worker-launch.ts';
import { ENV_FILE_DEFAULT, workerEnv } from './env-file.ts';
import { createSettingsStore } from './settings-store.ts';
import { isConsoleUrl } from '../shared/console-link.ts';
import { parseStudioLink, STUDIO_URL_SCHEME } from '../shared/studio-link.ts';
import * as os from 'node:os';
import { appBundleOf, createUpdater, UPDATE_CHECK_INTERVAL_MS, UPDATE_FIRST_CHECK_MS } from './updater.ts';

let win: BrowserWindow | undefined;
// 작업 프로세스(studio-packaging 01): 리포는 시스템 node + TS 원본, 설치본은 동봉 Node + 단일 번들. 환경은 ~/.config/sinclair/env 의 허용한 이름 위에 프로세스 환경
const envFile = process.env.SINCLAIR_ENV_FILE || ENV_FILE_DEFAULT(os.homedir());
const helperDir = path.join(process.resourcesPath ?? '', 'helper');
const bundledApk = app.isPackaged && existsSync(helperDir) ? readdirSync(helperDir).find((f) => f.endsWith('.apk')) : undefined;
const launch = workerLaunch({ packaged: app.isPackaged, mainDir: import.meta.dirname, resourcesPath: process.resourcesPath ?? '', env: process.env, ...(bundledApk ? { helperApk: bundledApk } : {}) });
const worker = createWorkerHost({
  node: launch.node,
  script: launch.script,
  execArgv: launch.execArgv,
  env: { ...workerEnv(process.env, existsSync(envFile) ? readFileSync(envFile, 'utf8') : undefined), ...launch.env },
  onStatus: (s) => win?.webContents.send(STUDIO_CHANNELS.workerStatusChanged, s),
  onEvent: (e) => win?.webContents.send(STUDIO_CHANNELS.event, e),
});

// 검증 훅(verify-studio): SINCLAIR_STUDIO_USER_DATA 면 userData 를 거기로(사용자의 설정 파일을 건드리지 않게)
if (process.env.SINCLAIR_STUDIO_USER_DATA) app.setPath('userData', process.env.SINCLAIR_STUDIO_USER_DATA);
// 설정(studio-console 03): userData/settings.json — 렌더러는 검증된 값만 쓸 수 있다
const settings = createSettingsStore(path.join(app.getPath('userData'), 'settings.json'), os.homedir());
ipcMain.handle(STUDIO_CHANNELS.getSettings, () => settings.get());

// 자동 업데이트(studio-update 03): 설정의 control-plane 배포를 확인하고, 사람이 누르면 받아 바꿔 끼운 뒤 다시 띄운다. 맥 설치본에서만
const appBundle = app.isPackaged && process.platform === 'darwin' ? appBundleOf(process.execPath) : undefined;
const relaunchEnv = Object.fromEntries(['SINCLAIR_STUDIO_USER_DATA', 'SINCLAIR_ENV_FILE'].filter((k) => process.env[k]).map((k) => [k, process.env[k]!]));
const updater = createUpdater({
  current: app.getVersion(), arch: process.arch,
  ...(appBundle ? { app: appBundle } : {}), unsupportedReason: app.isPackaged ? '맥 설치본(.app)에서만 업데이트한다' : '개발 모드',
  bundleId: 'dev.sinclair.studio', workDir: path.join(app.getPath('userData'), 'updates'), pid: process.pid,
  controlPlane: async () => (await settings.get()).controlPlane,
  // 사내망 CA: Electron net 은 시스템 인증서 저장소를 쓴다(Node fetch 는 NODE_EXTRA_CA_CERTS 없이 사내 CA 를 모른다)
  fetch: (u, init) => net.fetch(u, init),
  run: (cmd, args) => new Promise((res, rej) => { execFile(cmd, args, { encoding: 'utf8' }, (err, out, errOut) => (err ? rej(new Error(`${cmd} 실패: ${(errOut || err.message).trim()}`)) : res(out))); }),
  spawnDetached: (script, log) => { const fd = openSync(log, 'w'); spawn('/bin/sh', [script], { detached: true, stdio: ['ignore', fd, fd] }).unref(); },
  quit: () => app.quit(),
  ...(Object.keys(relaunchEnv).length ? { relaunchEnv } : {}),
  onChange: (s) => win?.webContents.send(STUDIO_CHANNELS.updateStatusChanged, s),
});
ipcMain.handle(STUDIO_CHANNELS.updateStatus, () => updater.status());
ipcMain.handle(STUDIO_CHANNELS.updateCheck, () => updater.check(true));
ipcMain.handle(STUDIO_CHANNELS.updateInstall, () => updater.install());
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

// URL 스킴(studio-packaging 03): sinclair://open?request=<id>. mac 은 open-url(앱이 꺼져 있었으면 ready 전에 온다), 그 밖은 두 번째 인스턴스의 argv.
// 창을 앞으로 가져오고 렌더러에 요청 id 를 알린다(렌더러가 곧바로 열기 요청을 받는다). 창이 아직 없거나 그리는 중이면 그린 뒤에 보낸다
let pendingLink: string | undefined;
let rendererReady = false;
const deliverLink = (raw: string): void => {
  const link = parseStudioLink(raw);
  if (!link) return;
  pendingLink = link.requestId;
  if (!app.isReady()) return;
  if (!win) createWindow();
  if (win!.isMinimized()) win!.restore();
  win!.show();
  win!.focus();
  app.focus({ steal: true });
  if (rendererReady) { win!.webContents.send(STUDIO_CHANNELS.openLink, pendingLink); pendingLink = undefined; }
};
app.on('open-url', (e, url) => { e.preventDefault(); deliverLink(url); });
// 검증(verify)은 여러 Studio 를 동시에 띄우므로 잠금은 설치본에서만
if (app.isPackaged && !process.env.SINCLAIR_STUDIO_USER_DATA) {
  if (!app.requestSingleInstanceLock()) app.quit();
  app.on('second-instance', (_e, argv) => { const url = argv.find((a) => a.startsWith(`${STUDIO_URL_SCHEME}://`)); if (url) deliverLink(url); else win?.focus(); });
}
if (app.isPackaged) app.setAsDefaultProtocolClient(STUDIO_URL_SCHEME);

function createWindow(): void {
  win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 960, minHeight: 600, title: 'Sinclair Studio',
    webPreferences: { preload: path.join(import.meta.dirname, '../preload/index.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  win.on('closed', () => { win = undefined; rendererReady = false; });
  rendererReady = false;
  win.webContents.on('did-finish-load', () => {
    rendererReady = true;
    if (pendingLink) { win?.webContents.send(STUDIO_CHANNELS.openLink, pendingLink); pendingLink = undefined; }
  });
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
  // 설치본은 Info.plist 의 icon.icns, 개발 모드는 Dock 에 같은 그림(apps/studio/build/icon.png)
  if (!app.isPackaged && process.platform === 'darwin') { const icon = path.join(import.meta.dirname, '../../build/icon.png'); if (existsSync(icon)) app.dock?.setIcon(icon); }
  createWindow();
  setTimeout(() => { void updater.check(); setInterval(() => { void updater.check(); }, UPDATE_CHECK_INTERVAL_MS).unref(); }, UPDATE_FIRST_CHECK_MS).unref();
  if (pendingLink) deliverLink(`${STUDIO_URL_SCHEME}://open?request=${pendingLink}`);
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
