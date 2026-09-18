import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // A deliberately invalid key: any test that reaches the network fails loudly
    // instead of quietly spending money.
    env: { TYPESAFE_API_KEY: 'test-key-not-valid' },
  },
});
