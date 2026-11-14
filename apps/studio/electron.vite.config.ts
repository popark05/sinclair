// Studio 빌드(electron-vite): main(+ 작업 프로세스 진입 worker), preload(CJS — package.json type module 아래라 .cjs), renderer(React + astryx).
import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        // worker 는 plain Node 로 따로 실행된다(ADR 0005). 지금은 의존성이 없다 — 작업 프로세스가 패키지를 쓰기 시작하면(02~) 단일 파일 번들로 바꾼다
        input: { index: resolve('src/main/index.ts'), worker: resolve('src/worker/index.ts') },
      },
    },
  },
  preload: {
    build: {
      rollupOptions: {
        input: { index: resolve('src/preload/index.ts') },
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  renderer: {
    root: 'src/renderer',
    plugins: [react()],
    build: { rollupOptions: { input: resolve('src/renderer/index.html') } },
  },
});
