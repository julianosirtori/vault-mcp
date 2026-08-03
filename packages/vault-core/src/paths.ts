import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import type { Vault } from './types.js';
import { VaultError } from './errors.js';

export interface ResolveNoteOptions {
  /** Resolve for a create: missing intermediate directories are allowed. */
  forCreate?: boolean;
}

/** Internal: narrow an unknown error to a Node fs error with a given code. */
export function isFsError(err: unknown, code: string): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as NodeJS.ErrnoException).code === code
  );
}

function isContained(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root + path.sep);
}

/** Convert an absolute path under the vault root to a forward-slash relative path. */
export function toVaultRelative(vault: Vault, absPath: string): string {
  return path.relative(vault.root, absPath).split(path.sep).join('/');
}

/**
 * Characters that are invisible (or line-structural) to a human reading a file
 * name but fully readable by a language model: C0/C1 controls and newlines,
 * zero-width and bidi controls, and the Unicode tag block — an invisible copy
 * of ASCII that can carry whole sentences.
 *
 * A note *name* carrying these is a prompt-injection channel that survives
 * every content sanitizer (ARCHITECTURE.md §5.3: the defense is channel
 * closure), so such paths are refused at the boundary instead of sanitized.
 *
 * Source of truth for this table: packages/vault-guards/src/invisible.ts.
 * It is duplicated here on purpose — vault-core depends on nothing but
 * `node:` builtins, so it cannot import @vault-mcp/guards. Keep the two in
 * sync.
 */
const INVISIBLE_PATH_CHAR_RE =
  // eslint-disable-next-line no-control-regex -- matching control characters is the point
  /[\u0000-\u001F\u007F-\u009F\u00AD\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF\u{E0000}-\u{E007F}]/u;

/** Reject dot-segments regardless of how the path was reached (string or symlink). */
function assertNoHiddenSegments(relPath: string, segments: string[]): void {
  for (const segment of segments) {
    if (segment.startsWith('.')) {
      throw new VaultError(
        'HIDDEN_PATH',
        `hidden segment "${segment}" is not accessible in "${relPath}"`,
      );
    }
  }
}

/**
 * Pure string validation, performed before any filesystem access.
 * Throws INVALID_PATH / NOT_MARKDOWN / HIDDEN_PATH.
 */
function validateRelPath(relPath: string): void {
  if (relPath.length === 0) {
    throw new VaultError('INVALID_PATH', 'path is empty');
  }
  if (relPath.includes('\0')) {
    throw new VaultError('INVALID_PATH', 'path contains a NUL byte');
  }
  if (relPath.includes('\\')) {
    throw new VaultError('INVALID_PATH', 'path contains a backslash');
  }
  if (relPath.startsWith('/') || path.isAbsolute(relPath)) {
    throw new VaultError('INVALID_PATH', 'path must be vault-relative, not absolute');
  }
  if (relPath.startsWith('~')) {
    throw new VaultError('INVALID_PATH', 'path must not start with "~"');
  }
  if (relPath.endsWith('/')) {
    throw new VaultError('INVALID_PATH', 'path must not end with "/"');
  }
  const segments = relPath.split('/');
  for (const segment of segments) {
    if (segment.length === 0) {
      throw new VaultError('INVALID_PATH', 'path contains an empty segment');
    }
    if (segment === '.' || segment === '..') {
      throw new VaultError('INVALID_PATH', `path contains a "${segment}" segment`);
    }
    if (INVISIBLE_PATH_CHAR_RE.test(segment)) {
      // Deliberately generic: echoing the offending segment back would carry
      // the hidden instructions straight into the model's context.
      throw new VaultError(
        'INVALID_PATH',
        'path contains an invisible or control character',
      );
    }
  }
  if (!/\.md$/i.test(relPath)) {
    throw new VaultError('NOT_MARKDOWN', 'only .md files are accessible');
  }
  assertNoHiddenSegments(relPath, segments);
}

/**
 * The single chokepoint for turning an untrusted vault-relative path into an
 * absolute filesystem path, with symlink-resolved containment checks.
 */
export async function resolveNotePath(
  vault: Vault,
  relPath: string,
  opts: ResolveNoteOptions = {},
): Promise<string> {
  validateRelPath(relPath);

  const target = path.join(vault.root, relPath);
  const parent = path.dirname(target);
  const basename = path.basename(target);

  let realParent: string;
  const missing: string[] = [];

  if (opts.forCreate === true) {
    // Walk up to the deepest existing ancestor; the missing tail will be
    // created later as real directories.
    let current = parent;
    for (;;) {
      try {
        realParent = await fs.realpath(current);
        break;
      } catch (err) {
        if (!isFsError(err, 'ENOENT') && !isFsError(err, 'ENOTDIR')) {
          throw err;
        }
        const up = path.dirname(current);
        if (up === current) {
          // Filesystem root reached without finding the vault: cannot happen
          // for a vault whose root exists, but fail closed.
          throw new VaultError('OUTSIDE_VAULT', `"${relPath}" resolves outside the vault`);
        }
        missing.unshift(path.basename(current));
        current = up;
      }
    }
    if (!isContained(vault.root, realParent)) {
      throw new VaultError('OUTSIDE_VAULT', `"${relPath}" resolves outside the vault`);
    }
    const ancestorStat = await fs.stat(realParent);
    if (!ancestorStat.isDirectory()) {
      throw new VaultError('NOT_A_FILE', `a path component of "${relPath}" is not a directory`);
    }
  } else {
    try {
      realParent = await fs.realpath(parent);
    } catch (err) {
      if (isFsError(err, 'ENOENT') || isFsError(err, 'ENOTDIR')) {
        throw new VaultError('NOT_FOUND', `note "${relPath}" not found`);
      }
      throw err;
    }
    if (!isContained(vault.root, realParent)) {
      throw new VaultError('OUTSIDE_VAULT', `"${relPath}" resolves outside the vault`);
    }
    const parentStat = await fs.stat(realParent);
    if (!parentStat.isDirectory()) {
      throw new VaultError('NOT_FOUND', `note "${relPath}" not found`);
    }
  }

  const resolved = path.join(realParent, ...missing, basename);

  // The string-level hidden-segment check only saw the path as it was typed.
  // A directory symlink inside the vault can point at .obsidian/.git/.trash
  // and still be "contained", so the rule is re-applied to where the path
  // actually landed.
  assertNoHiddenSegments(relPath, toVaultRelative(vault, resolved).split('/'));

  // The note itself must never be a symlink, and must not be a directory.
  try {
    const st = await fs.lstat(resolved);
    if (st.isSymbolicLink()) {
      throw new VaultError('OUTSIDE_VAULT', `"${relPath}" is a symlink`);
    }
    if (st.isDirectory()) {
      throw new VaultError('NOT_A_FILE', `"${relPath}" is a directory`);
    }
    if (!st.isFile()) {
      throw new VaultError('NOT_A_FILE', `"${relPath}" is not a regular file`);
    }
  } catch (err) {
    if (err instanceof VaultError) throw err;
    if (!isFsError(err, 'ENOENT') && !isFsError(err, 'ENOTDIR')) throw err;
    // Not existing yet is fine here; readers surface NOT_FOUND themselves.
  }

  return resolved;
}
