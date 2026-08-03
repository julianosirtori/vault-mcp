import type { Vault, VaultTreeFolder } from './types.js';
import { walkMarkdownFiles } from './search.js';

/**
 * Map of the vault's folder structure: every folder that contains at least
 * one markdown note (directly or in a subfolder), with direct note counts.
 * Gives the model the PARA/topic layout in one call instead of it being
 * discovered by accident through search results.
 */
export async function getVaultTree(vault: Vault): Promise<VaultTreeFolder[]> {
  // Low-trust folders are included on purpose: only structure is exposed,
  // never content — same rationale as list_recent.
  const files = await walkMarkdownFiles(vault, { excludeLowTrust: false });
  const counts = new Map<string, number>();
  for (const file of files) {
    const slash = file.rel.lastIndexOf('/');
    const dir = slash === -1 ? '' : file.rel.slice(0, slash);
    counts.set(dir, (counts.get(dir) ?? 0) + 1);
    // Ancestors with no direct notes still appear, with a count of 0.
    let parent = dir;
    while (parent !== '') {
      const up = parent.lastIndexOf('/');
      parent = up === -1 ? '' : parent.slice(0, up);
      if (!counts.has(parent)) counts.set(parent, 0);
    }
  }
  return [...counts.entries()]
    .map(([path, noteCount]) => ({ path, noteCount }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
