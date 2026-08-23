import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    include: ['src/tests/**/*.test.ts'],
    exclude: ['node_modules', 'build'],
    testTimeout: 30_000,
    hookTimeout: 15_000,
    env: {
      NODE_ENV: 'test',
      LOG_LEVEL: 'error',
    },
    setupFiles: ['src/tests/setup.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: [
        'src/tests/**',
        'src/chrome-extension/**',
        'src/api/getRefreshToken.ts',
      ],
      reporter: ['text', 'json', 'html'],
      thresholds: {
        lines: 50,
        functions: 50,
        branches: 40,
        statements: 50,
      },
    },
    pool: 'forks',
    sequence: {
      shuffle: false,
    },
  },
});
