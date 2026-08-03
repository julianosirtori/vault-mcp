import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { openVault } from '@vault-mcp/core';
import { expectVaultError } from './helpers.js';

describe('openVault', () => {
  const cleanups: string[] = [];

  afterEach(async () => {
    await Promise.all(
      cleanups.splice(0).map((p) => fs.rm(p, { recursive: true, force: true })),
    );
  });

  async function tmpDir(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vault-open-test-'));
    cleanups.push(dir);
    return dir;
  }

  it('rejects a relative root with INVALID_PATH', async () => {
    await expectVaultError(openVault({ root: 'relative/path' }), 'INVALID_PATH');
  });

  it('rejects an empty root with INVALID_PATH', async () => {
    await expectVaultError(openVault({ root: '' }), 'INVALID_PATH');
  });

  it('rejects a nonexistent root with NOT_FOUND', async () => {
    const dir = await tmpDir();
    await expectVaultError(
      openVault({ root: path.join(dir, 'does-not-exist') }),
      'NOT_FOUND',
    );
  });

  it('rejects a root that is a file with INVALID_PATH', async () => {
    const dir = await tmpDir();
    const file = path.join(dir, 'file.txt');
    await fs.writeFile(file, 'x', 'utf8');
    await expectVaultError(openVault({ root: file }), 'INVALID_PATH');
  });

  it('resolves the root with realpath (symlinked root)', async () => {
    const dir = await tmpDir();
    const real = path.join(dir, 'real-vault');
    const link = path.join(dir, 'link-vault');
    await fs.mkdir(real);
    await fs.symlink(real, link);
    const vault = await openVault({ root: link });
    expect(vault.root).toBe(await fs.realpath(real));
  });

  it('defaults maxReadBytes to 200_000', async () => {
    const dir = await tmpDir();
    const vault = await openVault({ root: dir });
    expect(vault.maxReadBytes).toBe(200_000);
  });

  it('honors an explicit maxReadBytes', async () => {
    const dir = await tmpDir();
    const vault = await openVault({ root: dir, maxReadBytes: 64 });
    expect(vault.maxReadBytes).toBe(64);
  });

  it('normalizes lowTrustFolders: trim, strip slashes, drop empties', async () => {
    const dir = await tmpDir();
    const vault = await openVault({
      root: dir,
      lowTrustFolders: [' /imports/ ', 'clips/', '/a/b', '', '   ', '///'],
    });
    expect([...vault.lowTrustFolders]).toEqual(['imports', 'clips', 'a/b']);
  });

  it('defaults lowTrustFolders to an empty list', async () => {
    const dir = await tmpDir();
    const vault = await openVault({ root: dir });
    expect([...vault.lowTrustFolders]).toEqual([]);
  });
});
