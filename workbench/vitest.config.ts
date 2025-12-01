import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.bench.ts'],
    benchmark: {
      include: ['test/**/*.bench.ts'],
    },
  },
});
