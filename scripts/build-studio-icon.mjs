/**
 * Studio 앱 아이콘(studio-update 01): apps/studio/build/icon.svg → icon.png(1024) → icon.icns.
 * SVG 는 Electron(Chromium) 화면 밖 창으로 그린다 — 리포에 이미 있는 렌더러라 새 의존이 없다. 크기별 PNG 는 sips, icns 는 iconutil(mac 전용).
 * 산출물(icon.png·icon.icns)은 커밋한다. dist:studio 는 그것을 쓰고 이 스크립트를 부르지 않는다. SVG 를 바꿨을 때만 다시 돌린다.
 * 사용: node scripts/build-studio-icon.mjs
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const buildDir = path.join(root, 'apps', 'studio', 'build');
const svg = path.join(buildDir, 'icon.svg');
const png = path.join(buildDir, 'icon.png');
const electron = createRequire(path.join(root, 'apps', 'studio', 'package.json'))('electron');

const tmp = mkdtempSync(path.join(os.tmpdir(), 'studio-icon-'));
const main = path.join(tmp, 'render.cjs');
writeFileSync(main, `
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const w = new BrowserWindow({ width: 1024, height: 1024, show: false, frame: false, transparent: true, useContentSize: true, webPreferences: { offscreen: true } });
  w.webContents.setFrameRate(1);
  await w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<html><body style="margin:0;background:transparent"><img src="' + 'data:image/svg+xml;base64,' + fs.readFileSync(${JSON.stringify(svg)}).toString('base64') + '" width="1024" height="1024"></body></html>'));
  await new Promise((r) => setTimeout(r, 500));
  const img = (await w.webContents.capturePage()).resize({ width: 1024, height: 1024, quality: 'best' });
  fs.writeFileSync(${JSON.stringify(png)}, img.toPNG());
  app.quit();
});
`);
execFileSync(electron, [main], { stdio: 'inherit' });

const iconset = path.join(tmp, 'icon.iconset');
mkdirSync(iconset);
for (const size of [16, 32, 128, 256, 512]) {
  execFileSync('sips', ['-z', String(size), String(size), png, '--out', path.join(iconset, `icon_${size}x${size}.png`)], { stdio: 'ignore' });
  execFileSync('sips', ['-z', String(size * 2), String(size * 2), png, '--out', path.join(iconset, `icon_${size}x${size}@2x.png`)], { stdio: 'ignore' });
}
execFileSync('iconutil', ['-c', 'icns', iconset, '-o', path.join(buildDir, 'icon.icns')]);
rmSync(tmp, { recursive: true, force: true });
console.log('[icon] apps/studio/build/icon.png, icon.icns');
