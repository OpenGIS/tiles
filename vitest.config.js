import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.js'],
    exclude: ['node_modules/**', 'test/build/**'],
    testTimeout: 15_000,
  },
});
