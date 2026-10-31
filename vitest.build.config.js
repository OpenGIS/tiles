import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/build/**/*.test.js'],
    testTimeout: 600000,
    hookTimeout: 600000,
    fileParallelism: false,
  },
});
