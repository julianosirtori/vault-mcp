import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import type { Vault, VaultOptions } from './types.js';
import { VaultError } from './errors.js';
import { isFsError } from './paths.js';

const DEFAULT_MAX_READ_BYTES = 200_000;

function normalizeLowTrustFolder(folder: string): string {
  return folder.trim().replace(/^\/+/, '').replace(/\/+$/, '');
}

export async function openVault(opts: VaultOptions): Promise<Vault> {
  const { root } = opts;
  if (typeof root !== 'string' || root.length === 0 || !path.isAbsolute(root)) {
    throw new VaultError('INVALID_PATH', 'vault root must be an absolute path');
  }

  let rootStat;
  try {
    rootStat = await fs.stat(root);
  } catch (err) {
    if (isFsError(err, 'ENOENT') || isFsError(err, 'ENOTDIR')) {
      throw new VaultError('NOT_FOUND', `vault root "${root}" does not exist`);
    }
    throw err;
  }
  if (!rootStat.isDirectory()) {
    throw new VaultError('INVALID_PATH', `vault root "${root}" is not a directory`);
  }

  const realRoot = await fs.realpath(root);
  const lowTrustFolders = Object.freeze(
    (opts.lowTrustFolders ?? [])
      .map(normalizeLowTrustFolder)
      .filter((folder) => folder.length > 0),
  );

  return Object.freeze({
    root: realRoot,
    lowTrustFolders,
    maxReadBytes: opts.maxReadBytes ?? DEFAULT_MAX_READ_BYTES,
  });
}
