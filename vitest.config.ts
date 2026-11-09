import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.{ts,tsx}', 'apps/*/test/**/*.test.{ts,tsx}'],
    environment: 'node',
  },
  // Console(React) 컴포넌트 테스트: JSX 를 React 17+ 자동 런타임으로
  esbuild: { jsx: 'automatic' },
});
