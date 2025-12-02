import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    testTimeout: 60_000,
    hookTimeout: 120_000,
    include: ['test/**/*.test.ts'],
    setupFiles: ['test/setup.ts'],
    // Run tests sequentially to share the container
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
  },
});
