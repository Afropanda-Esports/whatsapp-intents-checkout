import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    passWithNoTests: true,
    projects: [
      {
        test: {
          name: 'unit',
          include: ['unit_test/**/*.test.ts'],
          exclude: ['**/*.live.test.ts'],
        },
      },
      { test: { name: 'functional', include: ['functional_test/**/*.test.ts'] } },
      { test: { name: 'adversarial', include: ['adversarial_test/**/*.test.ts'] } },
    ],
  },
});
