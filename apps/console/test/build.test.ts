// @vitest-environment node
// Vite 빌드가 되고, 산출물이 /console/ 아래에서 서빙되도록 경로가 잡혀 있다(control-plane 의 --console-dir 로 그대로 쓴다).
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { build } from 'vite';

describe('Console 빌드', () => {
  it('index.html 과 /console/assets/ 자산이 나온다', async () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sinclair-console-build-'));
    await build({ root: path.resolve(import.meta.dirname, '..'), logLevel: 'silent', build: { outDir, emptyOutDir: true } });
    const html = fs.readFileSync(path.join(outDir, 'index.html'), 'utf8');
    expect(html).toMatch(/src="\/console\/assets\/[^"]+\.js"/);
    expect(fs.readdirSync(path.join(outDir, 'assets')).some((f) => f.endsWith('.js'))).toBe(true);
  }, 60_000);
});
