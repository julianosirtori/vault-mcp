import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import { expect } from 'vitest';
import { VaultError, openVault } from '@vault-mcp/core';
import type { Vault, VaultErrorCode, VaultOptions } from '@vault-mcp/core';

export interface TempVault {
  dir: string;
  vault: Vault;
  cleanupPaths: string[];
}

/** Create a real temp directory and open it as a vault. */
export async function makeTempVault(
  opts: Partial<Omit<VaultOptions, 'root'>> = {},
): Promise<TempVault> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vault-core-test-'));
  const vault = await openVault({ root: dir, ...opts });
  return { dir, vault, cleanupPaths: [dir] };
}

/** Create a second temp directory OUTSIDE the vault (for symlink targets). */
export async function makeOutsideDir(tv: TempVault): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vault-core-outside-'));
  tv.cleanupPaths.push(dir);
  return dir;
}

export async function cleanup(tv: TempVault): Promise<void> {
  await Promise.all(
    tv.cleanupPaths.map((p) => fs.rm(p, { recursive: true, force: true })),
  );
}

/** Write a file inside a directory, creating parents as needed. */
export async function writeFile(base: string, rel: string, content: string): Promise<string> {
  const abs = path.join(base, ...rel.split('/'));
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, 'utf8');
  return abs;
}

/** Assert that a promise rejects with a VaultError carrying the given code. */
export async function expectVaultError(
  promise: Promise<unknown>,
  code: VaultErrorCode,
): Promise<void> {
  let error: unknown;
  try {
    await promise;
  } catch (err) {
    error = err;
  }
  expect(error, `expected VaultError(${code}) to be thrown`).toBeInstanceOf(VaultError);
  expect((error as VaultError).code).toBe(code);
}
