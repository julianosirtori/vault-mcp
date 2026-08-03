import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { searchNotes } from '@vault-mcp/core';
import { cleanup, makeOutsideDir, makeTempVault, writeFile } from './helpers.js';
import type { TempVault } from './helpers.js';

describe('searchNotes', () => {
  let tv: TempVault;

  afterEach(async () => {
    await cleanup(tv);
  });

  it('matches case-insensitively in both directions', async () => {
    tv = await makeTempVault();
    await writeFile(tv.dir, 'a.md', 'Hello World\nnothing here\nHELLO again');
    const lower = await searchNotes(tv.vault, 'hello');
    expect(lower.map((m) => m.line)).toEqual([1, 3]);
    const upper = await searchNotes(tv.vault, 'HELLO');
    expect(upper.map((m) => m.line)).toEqual([1, 3]);
  });

  it('treats the query as a literal substring, never a regex', async () => {
    tv = await makeTempVault();
    await writeFile(tv.dir, 'a.md', 'price is $10 (a.b) today\nplain aXb line');
    const literal = await searchNotes(tv.vault, '(a.b)');
    expect(literal).toHaveLength(1);
    expect(literal[0]?.line).toBe(1);
    // A regex would match 'aXb' via the '.' wildcard; a literal must not.
    const dotted = await searchNotes(tv.vault, 'a.b');
    expect(dotted.map((m) => m.line)).toEqual([1]);
  });

  it('excludes low-trust folders by default and includes them on request', async () => {
    tv = await makeTempVault({ lowTrustFolders: ['imports'] });
    await writeFile(tv.dir, 'own.md', 'the secret word');
    await writeFile(tv.dir, 'imports/clip.md', 'the secret word imported');

    const trusted = await searchNotes(tv.vault, 'secret word');
    expect(trusted.map((m) => m.path)).toEqual(['own.md']);

    const all = await searchNotes(tv.vault, 'secret word', { includeLowTrust: true });
    expect(all.map((m) => m.path)).toEqual(['imports/clip.md', 'own.md']);
  });

  it('low-trust exclusion is a path-prefix match, not a substring match', async () => {
    tv = await makeTempVault({ lowTrustFolders: ['imports'] });
    await writeFile(tv.dir, 'imports-annex/x.md', 'findme');
    await writeFile(tv.dir, 'imports/y.md', 'findme');
    const matches = await searchNotes(tv.vault, 'findme');
    expect(matches.map((m) => m.path)).toEqual(['imports-annex/x.md']);
  });

  it('never searches hidden directories or files', async () => {
    tv = await makeTempVault();
    await writeFile(tv.dir, '.obsidian/plug.md', 'findme');
    await writeFile(tv.dir, '.hidden.md', 'findme');
    await writeFile(tv.dir, 'sub/.trash/gone.md', 'findme');
    await writeFile(tv.dir, 'visible.md', 'findme');
    const matches = await searchNotes(tv.vault, 'findme');
    expect(matches.map((m) => m.path)).toEqual(['visible.md']);
  });

  it('does not follow directory symlinks during the walk', async () => {
    tv = await makeTempVault();
    const outside = await makeOutsideDir(tv);
    await writeFile(outside, 'leak.md', 'findme outside');
    await fs.symlink(outside, path.join(tv.dir, 'linked'));
    await writeFile(tv.dir, 'inside.md', 'findme inside');
    const matches = await searchNotes(tv.vault, 'findme');
    expect(matches.map((m) => m.path)).toEqual(['inside.md']);
  });

  it('only considers .md files (case-insensitive extension)', async () => {
    tv = await makeTempVault();
    await writeFile(tv.dir, 'note.md', 'findme');
    await writeFile(tv.dir, 'NOTE2.MD', 'findme');
    await writeFile(tv.dir, 'data.txt', 'findme');
    const matches = await searchNotes(tv.vault, 'findme');
    expect(matches.map((m) => m.path)).toEqual(['NOTE2.MD', 'note.md']);
  });

  it('defaults the limit to 20 and hard-caps it at 50', async () => {
    tv = await makeTempVault();
    const lines = Array.from({ length: 60 }, (_, i) => `match line ${i}`).join('\n');
    await writeFile(tv.dir, 'many.md', lines);
    expect(await searchNotes(tv.vault, 'match line')).toHaveLength(20);
    expect(await searchNotes(tv.vault, 'match line', { limit: 100 })).toHaveLength(50);
    expect(await searchNotes(tv.vault, 'match line', { limit: 5 })).toHaveLength(5);
  });

  it('orders matches deterministically: path ascending, then line number', async () => {
    tv = await makeTempVault();
    await writeFile(tv.dir, 'b.md', 'skip\nfindme');
    await writeFile(tv.dir, 'a.md', 'findme\nskip\nfindme');
    await writeFile(tv.dir, 'sub/c.md', 'findme');
    const matches = await searchNotes(tv.vault, 'findme');
    expect(matches.map((m) => `${m.path}:${m.line}`)).toEqual([
      'a.md:1',
      'a.md:3',
      'b.md:2',
      'sub/c.md:1',
    ]);
  });

  it('returns the trimmed line as the snippet', async () => {
    tv = await makeTempVault();
    await writeFile(tv.dir, 'a.md', '   - findme in a list   ');
    const matches = await searchNotes(tv.vault, 'findme');
    expect(matches[0]?.snippet).toBe('- findme in a list');
  });

  it('caps long snippets at 200 chars centered on the match', async () => {
    tv = await makeTempVault();
    const line = 'x'.repeat(300) + 'NEEDLE' + 'y'.repeat(300);
    await writeFile(tv.dir, 'long.md', line);
    const matches = await searchNotes(tv.vault, 'needle');
    expect(matches).toHaveLength(1);
    const snippet = matches[0]?.snippet ?? '';
    expect(snippet.length).toBe(200);
    expect(snippet).toContain('NEEDLE');
  });

  it('reports 1-based line numbers', async () => {
    tv = await makeTempVault();
    await writeFile(tv.dir, 'a.md', 'first findme');
    const matches = await searchNotes(tv.vault, 'findme');
    expect(matches[0]?.line).toBe(1);
  });

  it('skips files larger than 5MB', async () => {
    tv = await makeTempVault();
    await writeFile(tv.dir, 'huge.md', 'findme\n' + 'x'.repeat(5_000_001));
    await writeFile(tv.dir, 'small.md', 'findme');
    const matches = await searchNotes(tv.vault, 'findme');
    expect(matches.map((m) => m.path)).toEqual(['small.md']);
  });
});
