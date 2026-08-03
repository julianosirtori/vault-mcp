#!/usr/bin/env node
import { openVault } from '@vault-mcp/core';
import { loadConfig } from './config.js';
import { createHttpServer } from './http.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const vault = await openVault({
    root: config.vaultPath,
    lowTrustFolders: config.lowTrustFolders,
    maxReadBytes: config.maxReadBytes,
  });

  const server = createHttpServer(config, vault);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, resolve);
  });

  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      event: 'startup',
      host: config.host,
      port: config.port,
      vault: vault.root,
      insecureLocal: config.allowInsecureLocal,
    }),
  );

  const shutdown = (signal: string) => {
    console.error(`[vault-mcp] ${signal} received, shutting down`);
    server.close(() => process.exit(0));
    // systemd sends SIGKILL after its own timeout; this is a fallback.
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err: unknown) => {
  console.error(`[vault-mcp] fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
