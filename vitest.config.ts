import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@vault-mcp/core': r('./packages/vault-core/src/index.ts'),
      '@vault-mcp/guards': r('./packages/vault-guards/src/index.ts'),
      '@vault-mcp/tool-contract': r('./packages/tool-contract/src/index.ts'),
    },
  },
  test: {
    include: [
      'packages/*/test/**/*.test.ts',
      'apps/mcp-server/test/**/*.test.ts',
    ],
    testTimeout: 20000,
  },
});
