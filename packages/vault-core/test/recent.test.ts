import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { listRecent } from '@vault-mcp/core';
import { cleanup, makeOutsideDir, makeTempVault, writeFile } from './helpers.js';
import type { TempVault } from './helpers.js';

async function setMtime(base: string, rel: string, when: Date): Promise<void> {
  await fs.utimes(path.join(base, ...rel.split('/')), when, when);
}

describe('listRecent', () => {
  let tv: TempVault;

  afterEach(async () => {
    await cleanup(tv);
  });

  it('orders notes by mtime descending with ISO 8601 timestamps', async () => {
    tv = await makeTempVault();
    await writeFile(tv.dir, 'old.md', 'a');
    await writeFile(tv.dir, 'mid.md', 'b');
    await writeFile(tv.dir, 'new.md', 'c');
    await setMtime(tv.dir, 'old.md', new Date('2026-01-01T00:00:00Z'));
    await setMtime(tv.dir, 'mid.md', new Date('2026-02-01T00:00:00Z'));
    await setMtime(tv.dir, 'new.md', new Date('2026-03-01T00:00:00Z'));

    const recent = await listRecent(tv.vault);
    expect(recent.map((n) => n.path)).toEqual(['new.md', 'mid.md', 'old.md']);
    expect(recent[0]?.modifiedAt).toBe('2026-03-01T00:00:00.000Z');
    expect(recent[2]?.modifiedAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('defaults the limit to 10 and caps it at 50', async () => {
    tv = await makeTempVault();
    for (let i = 0; i < 12; i += 1) {
      await writeFile(tv.dir, `n${String(i).padStart(2, '0')}.md`, 'x');
    }
    expect(await listRecent(tv.vault)).toHaveLength(10);
    expect(await listRecent(tv.vault, { limit: 3 })).toHaveLength(3);
    expect(await listRecent(tv.vault, { limit: 100 })).toHaveLength(12);
  });

  it('includes low-trust folders (paths only, no content is exposed)', async () => {
    tv = await makeTempVault({ lowTrustFolders: ['imports'] });
    await writeFile(tv.dir, 'own.md', 'a');
    await writeFile(tv.dir, 'imports/clip.md', 'b');
    const recent = await listRecent(tv.vault);
    expect(recent.map((n) => n.path).sort()).toEqual(['imports/clip.md', 'own.md']);
    for (const entry of recent) {
      expect(Object.keys(entry).sort()).toEqual(['modifiedAt', 'path']);
    }
  });

  it('skips hidden directories and does not follow symlinks', async () => {
    tv = await makeTempVault();
    const outside = await makeOutsideDir(tv);
    await writeFile(outside, 'leak.md', 'outside');
    await fs.symlink(outside, path.join(tv.dir, 'linked'));
    await writeFile(tv.dir, '.obsidian/workspace.md', 'hidden');
    await writeFile(tv.dir, 'visible.md', 'ok');
    const recent = await listRecent(tv.vault);
    expect(recent.map((n) => n.path)).toEqual(['visible.md']);
  });

  it('is deterministic when mtimes tie: path ascending', async () => {
    tv = await makeTempVault();
    await writeFile(tv.dir, 'b.md', 'x');
    await writeFile(tv.dir, 'a.md', 'x');
    const when = new Date('2026-05-05T05:05:05Z');
    await setMtime(tv.dir, 'a.md', when);
    await setMtime(tv.dir, 'b.md', when);
    const recent = await listRecent(tv.vault);
    expect(recent.map((n) => n.path)).toEqual(['a.md', 'b.md']);
  });
});
