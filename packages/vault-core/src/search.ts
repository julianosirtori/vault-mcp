import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import type { SearchMatch, SearchOptions, Vault } from './types.js';

const MAX_SEARCH_FILE_BYTES = 5_000_000;
const SNIPPET_MAX_CHARS = 200;
const HARD_LIMIT_CAP = 50;

/** Internal: a markdown file discovered by the vault walk. */
export interface WalkedFile {
  /** Vault-relative path, forward slashes. */
  rel: string;
  abs: string;
  sizeBytes: number;
  mtimeMs: number;
}

/** Internal: clamp a user-supplied limit to [1, 50], falling back to a default. */
export function clampLimit(limit: number | undefined, defaultLimit: number): number {
  if (limit === undefined || !Number.isFinite(limit)) return defaultLimit;
  return Math.max(1, Math.min(HARD_LIMIT_CAP, Math.floor(limit)));
}

function isLowTrust(vault: Vault, rel: string): boolean {
  return vault.lowTrustFolders.some(
    (folder) => rel === folder || rel.startsWith(folder + '/'),
  );
}

async function walkDir(
  vault: Vault,
  absDir: string,
  relDir: string,
  excludeLowTrust: boolean,
  out: WalkedFile[],
): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(absDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    // Dot-directories and dot-files (including .obsidian, .git, .trash and
    // our own temp files) are never visible to the walk.
    if (entry.name.startsWith('.')) continue;
    // Never follow symlinks: neither directories nor files.
    if (entry.isSymbolicLink()) continue;
    const rel = relDir === '' ? entry.name : `${relDir}/${entry.name}`;
    const abs = path.join(absDir, entry.name);
    if (entry.isDirectory()) {
      if (excludeLowTrust && isLowTrust(vault, rel)) continue;
      await walkDir(vault, abs, rel, excludeLowTrust, out);
    } else if (entry.isFile() && /\.md$/i.test(entry.name)) {
      if (excludeLowTrust && isLowTrust(vault, rel)) continue;
      let st;
      try {
        st = await fs.stat(abs);
      } catch {
        continue;
      }
      out.push({ rel, abs, sizeBytes: st.size, mtimeMs: st.mtimeMs });
    }
  }
}

/** Internal: recursively list markdown files with the shared walk rules. */
export async function walkMarkdownFiles(
  vault: Vault,
  opts: { excludeLowTrust: boolean },
): Promise<WalkedFile[]> {
  const out: WalkedFile[] = [];
  await walkDir(vault, vault.root, '', opts.excludeLowTrust, out);
  return out;
}

function makeSnippet(line: string, needleLower: string): string {
  const trimmed = line.trim();
  if (trimmed.length <= SNIPPET_MAX_CHARS) return trimmed;
  const idx = trimmed.toLowerCase().indexOf(needleLower);
  if (idx < 0) return trimmed.slice(0, SNIPPET_MAX_CHARS);
  const center = idx + needleLower.length / 2;
  let start = Math.round(center - SNIPPET_MAX_CHARS / 2);
  if (start < 0) start = 0;
  if (start > trimmed.length - SNIPPET_MAX_CHARS) {
    start = trimmed.length - SNIPPET_MAX_CHARS;
  }
  return trimmed.slice(start, start + SNIPPET_MAX_CHARS);
}

export async function searchNotes(
  vault: Vault,
  query: string,
  opts: SearchOptions = {},
): Promise<SearchMatch[]> {
  const limit = clampLimit(opts.limit, 20);
  // Literal, case-insensitive substring match — the query is untrusted input
  // and is never interpreted as a regular expression.
  const needle = query.toLowerCase();

  const files = await walkMarkdownFiles(vault, {
    excludeLowTrust: opts.includeLowTrust !== true,
  });
  files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));

  const matches: SearchMatch[] = [];
  for (const file of files) {
    if (file.sizeBytes > MAX_SEARCH_FILE_BYTES) continue;
    let content: string;
    try {
      content = await fs.readFile(file.abs, 'utf8');
    } catch {
      continue;
    }
    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i] ?? '';
      if (!line.toLowerCase().includes(needle)) continue;
      matches.push({ path: file.rel, line: i + 1, snippet: makeSnippet(line, needle) });
      if (matches.length >= limit) return matches;
    }
  }
  return matches;
}
