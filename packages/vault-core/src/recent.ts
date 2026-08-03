import type { RecentNote, Vault } from './types.js';
import { clampLimit, walkMarkdownFiles } from './search.js';

export interface ListRecentOptions {
  /** Max notes returned. Default 10, cap 50. */
  limit?: number;
}

export async function listRecent(
  vault: Vault,
  opts: ListRecentOptions = {},
): Promise<RecentNote[]> {
  const limit = clampLimit(opts.limit, 10);
  // Low-trust folders are included here on purpose: only paths are exposed,
  // never content.
  const files = await walkMarkdownFiles(vault, { excludeLowTrust: false });
  files.sort((a, b) => {
    if (b.mtimeMs !== a.mtimeMs) return b.mtimeMs - a.mtimeMs;
    return a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0;
  });
  return files.slice(0, limit).map((file) => ({
    path: file.rel,
    modifiedAt: new Date(file.mtimeMs).toISOString(),
  }));
}
