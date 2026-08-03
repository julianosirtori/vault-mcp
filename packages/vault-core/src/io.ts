import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import type { NoteContent, NoteEdit, Vault, WriteGuardOptions } from './types.js';
import { VaultError } from './errors.js';
import { isFsError, resolveNotePath, toVaultRelative } from './paths.js';

/**
 * Short content hash identifying a note version. 12 hex chars of SHA-256 is
 * plenty for "did this file change since I read it" — it is a freshness token,
 * not a security boundary.
 */
export function contentHash(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 12);
}

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

/**
 * Atomically replace `abs` with `content` (tmp file + rename + dir sync).
 *
 * When a version is supplied, validate it again after the potentially-slow
 * temp-file write/fsync and immediately before rename. Plain filesystem APIs
 * do not offer a portable compare-and-swap against unrelated writers, but this
 * keeps the unavoidable final race window as small as possible.
 */
async function replaceFile(
  abs: string,
  content: string,
  guard: { relPath: string; expectedHash?: string } | undefined = undefined,
): Promise<void> {
  const dir = path.dirname(abs);
  const tmp = tmpPathFor(abs);
  await writeTmpFile(tmp, content);
  try {
    if (guard?.expectedHash !== undefined) {
      const current = await readRaw(abs, guard.relPath);
      assertVersion(current, guard.relPath, guard.expectedHash);
    }
    await fs.rename(tmp, abs);
  } catch (err) {
    await fs.unlink(tmp).catch(() => {});
    throw err;
  }
  await syncDir(dir);
}

/** Read a note's raw bytes, mapping ENOENT to NOT_FOUND. */
async function readRaw(abs: string, relPath: string): Promise<Buffer> {
  try {
    return await fs.readFile(abs);
  } catch (err) {
    if (isFsError(err, 'ENOENT')) {
      throw new VaultError('NOT_FOUND', `note "${relPath}" not found`);
    }
    throw err;
  }
}

/**
 * Optimistic-concurrency check: the caller read the note at some version and
 * asks the write to land only on that same version. Best-effort against
 * unrelated external writers: callers check once before preparing content and
 * replaceFile checks again immediately before the atomic rename.
 */
function assertVersion(
  raw: Buffer,
  relPath: string,
  expectedHash: string | undefined,
): void {
  if (expectedHash === undefined) return;
  const current = contentHash(raw);
  if (current !== expectedHash) {
    throw new VaultError(
      'CONFLICT',
      `note "${relPath}" changed since it was read (expected version ${expectedHash}, ` +
        `found ${current}); re-read the note and retry`,
    );
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
    const maxReadBytes = Math.max(0, Math.floor(vault.maxReadBytes));
    const prefix = Buffer.alloc(maxReadBytes);
    const chunk = Buffer.allocUnsafe(64 * 1024);
    const hasher = createHash('sha256');
    let prefixBytes = 0;
    let sizeBytes = 0;

    for (;;) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, sizeBytes);
      if (bytesRead === 0) break;
      const bytes = chunk.subarray(0, bytesRead);
      hasher.update(bytes);
      if (prefixBytes < prefix.length) {
        const copied = Math.min(bytesRead, prefix.length - prefixBytes);
        bytes.copy(prefix, prefixBytes, 0, copied);
        prefixBytes += copied;
      }
      sizeBytes += bytesRead;
    }

    const truncated = sizeBytes > maxReadBytes;
    const visible = prefix.subarray(0, prefixBytes);
    const content = truncated
      ? // stream:true holds back an incomplete trailing multibyte sequence.
        new TextDecoder('utf-8').decode(visible, { stream: true })
      : visible.toString('utf8');

    return {
      path: toVaultRelative(vault, abs),
      content,
      truncated,
      sizeBytes,
      hash: hasher.digest('hex').slice(0, 12),
    };
  } finally {
    await handle.close();
  }
}

export async function createNote(
  vault: Vault,
  relPath: string,
  content: string,
): Promise<{ path: string; hash: string }> {
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

  return { path: toVaultRelative(vault, abs), hash: contentHash(content) };
}

export async function appendToNote(
  vault: Vault,
  relPath: string,
  content: string,
  opts: WriteGuardOptions = {},
): Promise<{ path: string; sizeBytes: number; hash: string }> {
  const abs = await resolveNotePath(vault, relPath);
  const raw = await readRaw(abs, relPath);
  assertVersion(raw, relPath, opts.expectedHash);
  const existing = raw.toString('utf8');

  let result = existing;
  if (result.length > 0 && !result.endsWith('\n')) {
    result += '\n';
  }
  result += content;
  if (!result.endsWith('\n')) {
    result += '\n';
  }

  await replaceFile(abs, result, { relPath, expectedHash: opts.expectedHash });

  return {
    path: toVaultRelative(vault, abs),
    sizeBytes: Buffer.byteLength(result, 'utf8'),
    hash: contentHash(result),
  };
}

/**
 * Internal to vault-core: resolve an existing note and atomically replace its
 * whole content. Callers are responsible for any version check beforehand.
 */
export async function replaceNoteContent(
  vault: Vault,
  relPath: string,
  content: string,
  opts: WriteGuardOptions = {},
): Promise<{ path: string; sizeBytes: number; hash: string }> {
  const abs = await resolveNotePath(vault, relPath);
  await replaceFile(abs, content, { relPath, expectedHash: opts.expectedHash });
  return {
    path: toVaultRelative(vault, abs),
    sizeBytes: Buffer.byteLength(content, 'utf8'),
    hash: contentHash(content),
  };
}

/**
 * Apply search-and-replace edits to a note, all-or-nothing. Each old string
 * must match the (evolving) content exactly once: zero matches or several
 * both fail the whole call, and nothing touches disk until every edit landed
 * in memory.
 */
export async function editNote(
  vault: Vault,
  relPath: string,
  edits: readonly NoteEdit[],
  opts: WriteGuardOptions = {},
): Promise<{ path: string; sizeBytes: number; hash: string; editsApplied: number }> {
  if (edits.length === 0) {
    throw new VaultError('NO_MATCH', 'no edits given');
  }
  const abs = await resolveNotePath(vault, relPath);
  const raw = await readRaw(abs, relPath);
  assertVersion(raw, relPath, opts.expectedHash);
  let content = raw.toString('utf8');

  for (let i = 0; i < edits.length; i += 1) {
    const edit = edits[i];
    if (edit === undefined) continue;
    const { oldString, newString } = edit;
    const label = `edit ${i + 1} of ${edits.length}`;
    if (oldString.length === 0) {
      throw new VaultError('NO_MATCH', `${label}: old_string is empty`);
    }
    if (oldString === newString) {
      throw new VaultError('NO_MATCH', `${label}: old_string and new_string are identical`);
    }
    const first = content.indexOf(oldString);
    if (first === -1) {
      throw new VaultError(
        'NO_MATCH',
        `${label}: old_string not found in "${relPath}" — no changes were applied`,
      );
    }
    if (content.indexOf(oldString, first + oldString.length) !== -1) {
      throw new VaultError(
        'AMBIGUOUS_MATCH',
        `${label}: old_string matches more than once in "${relPath}" — add surrounding ` +
          'context to make it unique; no changes were applied',
      );
    }
    content =
      content.slice(0, first) + newString + content.slice(first + oldString.length);
  }

  await replaceFile(abs, content, { relPath, expectedHash: opts.expectedHash });

  return {
    path: toVaultRelative(vault, abs),
    sizeBytes: Buffer.byteLength(content, 'utf8'),
    hash: contentHash(content),
    editsApplied: edits.length,
  };
}

/**
 * Move a note to the vault's `.trash/` folder — the same folder Obsidian's
 * "move to vault trash" uses — rather than unlinking it, so a wrong delete is
 * recoverable by hand or from Obsidian's UI.
 */
export async function deleteNote(
  vault: Vault,
  relPath: string,
): Promise<{ path: string; trashedTo: string }> {
  const abs = await resolveNotePath(vault, relPath);
  // Surface NOT_FOUND before touching .trash.
  await readRaw(abs, relPath);

  const trashDir = path.join(vault.root, '.trash');
  await fs.mkdir(trashDir, { recursive: true });

  const base = path.basename(abs);
  let target = path.join(trashDir, base);
  try {
    // link+unlink instead of rename: fails on EEXIST instead of overwriting
    // something already in the trash.
    await fs.link(abs, target);
  } catch (err) {
    if (!isFsError(err, 'EEXIST')) throw err;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    target = path.join(trashDir, base.replace(/\.md$/i, '') + `-${stamp}.md`);
    await fs.link(abs, target);
  }
  await fs.unlink(abs);
  await syncDir(path.dirname(abs));
  await syncDir(trashDir);

  return {
    path: toVaultRelative(vault, abs),
    trashedTo: toVaultRelative(vault, target),
  };
}

/**
 * Move or rename a note. The destination must not exist — this never
 * overwrites. Wiki-links pointing at the old name are NOT rewritten.
 */
export async function moveNote(
  vault: Vault,
  fromRel: string,
  toRel: string,
): Promise<{ from: string; to: string }> {
  const fromAbs = await resolveNotePath(vault, fromRel);
  const toAbs = await resolveNotePath(vault, toRel, { forCreate: true });
  if (fromAbs === toAbs) {
    throw new VaultError('INVALID_PATH', 'source and destination are the same note');
  }
  // Surface NOT_FOUND for the source before creating destination folders.
  try {
    const st = await fs.stat(fromAbs);
    if (!st.isFile()) throw new VaultError('NOT_FOUND', `note "${fromRel}" not found`);
  } catch (err) {
    if (err instanceof VaultError) throw err;
    if (isFsError(err, 'ENOENT')) {
      throw new VaultError('NOT_FOUND', `note "${fromRel}" not found`);
    }
    throw err;
  }
  await fs.mkdir(path.dirname(toAbs), { recursive: true });
  try {
    // link+unlink: atomic no-overwrite move within the vault filesystem.
    await fs.link(fromAbs, toAbs);
  } catch (err) {
    if (isFsError(err, 'EEXIST')) {
      throw new VaultError('ALREADY_EXISTS', `note "${toRel}" already exists`);
    }
    throw err;
  }
  await fs.unlink(fromAbs);
  await syncDir(path.dirname(fromAbs));
  await syncDir(path.dirname(toAbs));

  return { from: toVaultRelative(vault, fromAbs), to: toVaultRelative(vault, toAbs) };
}
