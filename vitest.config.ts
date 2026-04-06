import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['test/**/*.test.ts'],
    testTimeout: 15_000,
  },
  resolve: {
    alias: { '@shared': resolve(__dirname, 'src/shared') },
  },
});
