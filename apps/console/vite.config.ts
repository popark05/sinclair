// Console 빌드: /console/ 아래에서 서빙(control-plane --console-dir). 개발 서버는 API 경로를 control-plane 으로 프록시한다.
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const api = process.env.SINCLAIR_CONSOLE_API ?? 'http://127.0.0.1:4780';

export default defineConfig({
  base: '/console/',
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true },
  server: { proxy: Object.fromEntries(['/cycles', '/runs', '/fleet', '/health'].map((p) => [p, api])) },
});
