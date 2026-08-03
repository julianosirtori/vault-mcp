import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import { randomBytes } from 'node:crypto';
import type { NoteContent, Vault } from './types.js';
import { VaultError } from './errors.js';
import { isFsError, resolveNotePath, toVaultRelative } from './paths.js';

function tmpPathFor(target: string): string {
  const dir = path.dirname(target);
  const base = path.basename(target);
  return path.join(dir, `.${base}.${randomBytes(8).toString('hex')}.tmp`);
}

/**
 * Write content to a brand-new temp file and fsync it. If anything after the
 * exclusive open fails (ENOSPC/EDQUOT/EIO on write or fsync), the temp file is
 * removed before the error propagates: it is dot-prefixed, so a leaked one is
 * invisible to Obsidian, to the vault walk and to sync, and would only ever be
 * found by hand.
 */
async function writeTmpFile(tmp: string, content: string): Promise<void> {
  const handle = await fs.open(tmp, 'wx', 0o644);
  try {
    try {
      await handle.writeFile(content, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (err) {
    await fs.unlink(tmp).catch(() => {});
    throw err;
  }
}

/** Best-effort fsync of a directory so the entry itself is durable. */
async function syncDir(dir: string): Promise<void> {
  try {
    const handle = await fs.open(dir, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Best-effort only; some platforms/filesystems refuse directory fsync.
  }
}

export async function readNote(vault: Vault, relPath: string): Promise<NoteContent> {
  const abs = await resolveNotePath(vault, relPath);

  let handle;
  try {
    handle = await fs.open(abs, 'r');
  } catch (err) {
    if (isFsError(err, 'ENOENT')) {
      throw new VaultError('NOT_FOUND', `note "${relPath}" not found`);
    }
    throw err;
  }

  try {
    const st = await handle.stat();
    const sizeBytes = st.size;

    if (sizeBytes <= vault.maxReadBytes) {
      const buf = await handle.readFile();
      return {
        path: toVaultRelative(vault, abs),
        content: buf.toString('utf8'),
        truncated: false,
        sizeBytes,
      };
    }

    const buf = Buffer.alloc(vault.maxReadBytes);
    let offset = 0;
    while (offset < buf.length) {
      const { bytesRead } = await handle.read(buf, offset, buf.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    // stream: true makes TextDecoder hold back an incomplete trailing
    // multibyte sequence instead of emitting a replacement character.
    const content = new TextDecoder('utf-8').decode(buf.subarray(0, offset), {
      stream: true,
    });
    return {
      path: toVaultRelative(vault, abs),
      content,
      truncated: true,
      sizeBytes,
    };
  } finally {
    await handle.close();
  }
}

export async function createNote(
  vault: Vault,
  relPath: string,
  content: string,
): Promise<{ path: string }> {
  const abs = await resolveNotePath(vault, relPath, { forCreate: true });
  const dir = path.dirname(abs);
  await fs.mkdir(dir, { recursive: true });

  const tmp = tmpPathFor(abs);
  await writeTmpFile(tmp, content);
  try {
    // link() is atomic and fails if the target already exists, so an existing
    // note is never clobbered and the file appears fully written or not at all.
    await fs.link(tmp, abs);
  } catch (err) {
    if (isFsError(err, 'EEXIST')) {
      await fs.unlink(tmp).catch(() => {});
      throw new VaultError('ALREADY_EXISTS', `note "${relPath}" already exists`);
    }
    await fs.unlink(tmp).catch(() => {});
    throw err;
  }
  await fs.unlink(tmp).catch(() => {});
  await syncDir(dir);

  return { path: toVaultRelative(vault, abs) };
}

export async function appendToNote(
  vault: Vault,
  relPath: string,
  content: string,
): Promise<{ path: string; sizeBytes: number }> {
  const abs = await resolveNotePath(vault, relPath);

  let existing: string;
  try {
    existing = await fs.readFile(abs, 'utf8');
  } catch (err) {
    if (isFsError(err, 'ENOENT')) {
      throw new VaultError('NOT_FOUND', `note "${relPath}" not found`);
    }
    throw err;
  }

  let result = existing;
  if (result.length > 0 && !result.endsWith('\n')) {
    result += '\n';
  }
  result += content;
  if (!result.endsWith('\n')) {
    result += '\n';
  }

  const dir = path.dirname(abs);
  const tmp = tmpPathFor(abs);
  await writeTmpFile(tmp, result);
  try {
    await fs.rename(tmp, abs);
  } catch (err) {
    await fs.unlink(tmp).catch(() => {});
    throw err;
  }
  await syncDir(dir);

  return {
    path: toVaultRelative(vault, abs),
    sizeBytes: Buffer.byteLength(result, 'utf8'),
  };
}
