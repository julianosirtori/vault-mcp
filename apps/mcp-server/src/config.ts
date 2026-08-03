import path from 'node:path';

export interface ServerConfig {
  vaultPath: string;
  host: string;
  port: number;
  /** null only when allowInsecureLocal is on. */
  originSecret: string | null;
  allowInsecureLocal: boolean;
  lowTrustFolders: string[];
  maxReadBytes: number;
}

function isLoopback(host: string): boolean {
  return (
    host === 'localhost' ||
    host === '::1' ||
    host === '127.0.0.1' ||
    host.startsWith('127.')
  );
}

/**
 * All configuration comes from the environment, without exception — the
 * prerequisite for the code being publishable, and what lets the systemd
 * `start` script fail fast with a message that makes journalctl diagnosis
 * instant. Every problem is collected and reported at once.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const problems: string[] = [];

  const vaultPath = env.VAULT_PATH ?? '';
  if (!vaultPath) {
    problems.push('VAULT_PATH is required (absolute path to the vault directory)');
  } else if (!path.isAbsolute(vaultPath)) {
    problems.push(`VAULT_PATH must be absolute, got "${vaultPath}"`);
  }

  const host = env.MCP_HOST ?? '127.0.0.1';

  const portRaw = env.MCP_PORT ?? '9820';
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    problems.push(`MCP_PORT must be an integer between 1 and 65535, got "${portRaw}"`);
  }

  const allowInsecureLocal = env.MCP_ALLOW_INSECURE_LOCAL === '1';
  const originSecret = env.ORIGIN_SECRET ?? '';
  if (allowInsecureLocal) {
    if (!isLoopback(host)) {
      problems.push(
        `MCP_ALLOW_INSECURE_LOCAL=1 requires MCP_HOST to be a loopback address, got "${host}"`,
      );
    }
  } else if (!originSecret) {
    problems.push(
      'ORIGIN_SECRET is required (generate with: openssl rand -hex 32); ' +
        'set MCP_ALLOW_INSECURE_LOCAL=1 only for local development without the tunnel',
    );
  } else if (originSecret.length < 32) {
    problems.push('ORIGIN_SECRET must be at least 32 characters');
  }

  const lowTrustFolders = (env.LOW_TRUST_FOLDERS ?? '')
    .split(',')
    .map((f) => f.trim())
    .filter((f) => f.length > 0);

  const maxReadBytesRaw = env.MAX_READ_BYTES ?? '200000';
  const maxReadBytes = Number(maxReadBytesRaw);
  if (!Number.isInteger(maxReadBytes) || maxReadBytes < 1) {
    problems.push(`MAX_READ_BYTES must be a positive integer, got "${maxReadBytesRaw}"`);
  }

  if (problems.length > 0) {
    throw new Error(`invalid configuration:\n  - ${problems.join('\n  - ')}`);
  }

  return {
    vaultPath,
    host,
    port,
    originSecret: allowInsecureLocal ? originSecret || null : originSecret,
    allowInsecureLocal,
    lowTrustFolders,
    maxReadBytes,
  };
}
