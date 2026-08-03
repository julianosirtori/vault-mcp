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
    expect(lower.matches.map((m) => m.line)).toEqual([1, 3]);
    const upper = await searchNotes(tv.vault, 'HELLO');
    expect(upper.matches.map((m) => m.line)).toEqual([1, 3]);
  });

  it('treats the query as a literal substring, never a regex', async () => {
    tv = await makeTempVault();
    await writeFile(tv.dir, 'a.md', 'price is $10 (a.b) today\nplain aXb line');
    const literal = await searchNotes(tv.vault, '(a.b)');
    expect(literal.matches).toHaveLength(1);
    expect(literal.matches[0]?.line).toBe(1);
    // A regex would match 'aXb' via the '.' wildcard; a literal must not.
    const dotted = await searchNotes(tv.vault, 'a.b');
    expect(dotted.matches.map((m) => m.line)).toEqual([1]);
  });

  it('excludes low-trust folders by default and includes them on request', async () => {
    tv = await makeTempVault({ lowTrustFolders: ['imports'] });
    await writeFile(tv.dir, 'own.md', 'the secret word');
    await writeFile(tv.dir, 'imports/clip.md', 'the secret word imported');

    const trusted = await searchNotes(tv.vault, 'secret word');
    expect(trusted.matches.map((m) => m.path)).toEqual(['own.md']);

    const all = await searchNotes(tv.vault, 'secret word', { includeLowTrust: true });
    expect(all.matches.map((m) => m.path)).toEqual(['imports/clip.md', 'own.md']);
  });

  it('low-trust exclusion is a path-prefix match, not a substring match', async () => {
    tv = await makeTempVault({ lowTrustFolders: ['imports'] });
    await writeFile(tv.dir, 'imports-annex/x.md', 'findme');
    await writeFile(tv.dir, 'imports/y.md', 'findme');
    const result = await searchNotes(tv.vault, 'findme');
    expect(result.matches.map((m) => m.path)).toEqual(['imports-annex/x.md']);
  });

  it('never searches hidden directories or files', async () => {
    tv = await makeTempVault();
    await writeFile(tv.dir, '.obsidian/plug.md', 'findme');
    await writeFile(tv.dir, '.hidden.md', 'findme');
    await writeFile(tv.dir, 'sub/.trash/gone.md', 'findme');
    await writeFile(tv.dir, 'visible.md', 'findme');
    const result = await searchNotes(tv.vault, 'findme');
    expect(result.matches.map((m) => m.path)).toEqual(['visible.md']);
  });

  it('does not follow directory symlinks during the walk', async () => {
    tv = await makeTempVault();
    const outside = await makeOutsideDir(tv);
    await writeFile(outside, 'leak.md', 'findme outside');
    await fs.symlink(outside, path.join(tv.dir, 'linked'));
    await writeFile(tv.dir, 'inside.md', 'findme inside');
    const result = await searchNotes(tv.vault, 'findme');
    expect(result.matches.map((m) => m.path)).toEqual(['inside.md']);
  });

  it('only considers .md files (case-insensitive extension)', async () => {
    tv = await makeTempVault();
    await writeFile(tv.dir, 'note.md', 'findme');
    await writeFile(tv.dir, 'NOTE2.MD', 'findme');
    await writeFile(tv.dir, 'data.txt', 'findme');
    const result = await searchNotes(tv.vault, 'findme');
    expect(result.matches.map((m) => m.path)).toEqual(['NOTE2.MD', 'note.md']);
  });

  it('defaults the limit to 20 and hard-caps it at 50', async () => {
    tv = await makeTempVault();
    const lines = Array.from({ length: 60 }, (_, i) => `match line ${i}`).join('\n');
    await writeFile(tv.dir, 'many.md', lines);
    expect((await searchNotes(tv.vault, 'match line')).matches).toHaveLength(20);
    expect(
      (await searchNotes(tv.vault, 'match line', { limit: 100 })).matches,
    ).toHaveLength(50);
    expect(
      (await searchNotes(tv.vault, 'match line', { limit: 5 })).matches,
    ).toHaveLength(5);
  });

  it('orders matches deterministically: path ascending, then line number', async () => {
    tv = await makeTempVault();
    await writeFile(tv.dir, 'b.md', 'skip\nfindme');
    await writeFile(tv.dir, 'a.md', 'findme\nskip\nfindme');
    await writeFile(tv.dir, 'sub/c.md', 'findme');
    const result = await searchNotes(tv.vault, 'findme');
    expect(result.matches.map((m) => `${m.path}:${m.line}`)).toEqual([
      'a.md:1',
      'a.md:3',
      'b.md:2',
      'sub/c.md:1',
    ]);
  });

  it('returns the trimmed line as the snippet', async () => {
    tv = await makeTempVault();
    await writeFile(tv.dir, 'a.md', '   - findme in a list   ');
    const result = await searchNotes(tv.vault, 'findme');
    expect(result.matches[0]?.snippet).toBe('- findme in a list');
  });

  it('caps long snippets at 200 chars centered on the match', async () => {
    tv = await makeTempVault();
    const line = 'x'.repeat(300) + 'NEEDLE' + 'y'.repeat(300);
    await writeFile(tv.dir, 'long.md', line);
    const result = await searchNotes(tv.vault, 'needle');
    expect(result.matches).toHaveLength(1);
    const snippet = result.matches[0]?.snippet ?? '';
    expect(snippet.length).toBe(200);
    expect(snippet).toContain('NEEDLE');
  });

  it('reports 1-based line numbers', async () => {
    tv = await makeTempVault();
    await writeFile(tv.dir, 'a.md', 'first findme');
    const result = await searchNotes(tv.vault, 'findme');
    expect(result.matches[0]?.line).toBe(1);
  });

  it('skips files larger than 5MB', async () => {
    tv = await makeTempVault();
    await writeFile(tv.dir, 'huge.md', 'findme\n' + 'x'.repeat(5_000_001));
    await writeFile(tv.dir, 'small.md', 'findme');
    const result = await searchNotes(tv.vault, 'findme');
    expect(result.matches.map((m) => m.path)).toEqual(['small.md']);
  });

  it('paginates with offset and reports hasMore', async () => {
    tv = await makeTempVault();
    const lines = Array.from({ length: 7 }, (_, i) => `match line ${i}`).join('\n');
    await writeFile(tv.dir, 'many.md', lines);

    const first = await searchNotes(tv.vault, 'match line', { limit: 3 });
    expect(first.matches.map((m) => m.line)).toEqual([1, 2, 3]);
    expect(first.hasMore).toBe(true);

    const second = await searchNotes(tv.vault, 'match line', { limit: 3, offset: 3 });
    expect(second.matches.map((m) => m.line)).toEqual([4, 5, 6]);
    expect(second.hasMore).toBe(true);

    const last = await searchNotes(tv.vault, 'match line', { limit: 3, offset: 6 });
    expect(last.matches.map((m) => m.line)).toEqual([7]);
    expect(last.hasMore).toBe(false);
  });

  it('scopes the search with pathPrefix (prefix on folders, not substrings)', async () => {
    tv = await makeTempVault();
    await writeFile(tv.dir, '5-journal/2026-08-01.md', 'findme journal');
    await writeFile(tv.dir, '5-journal-old/x.md', 'findme old');
    await writeFile(tv.dir, 'other.md', 'findme other');
    const result = await searchNotes(tv.vault, 'findme', { pathPrefix: '5-journal' });
    expect(result.matches.map((m) => m.path)).toEqual(['5-journal/2026-08-01.md']);
  });

  it('visits newest notes first with sortBy mtime', async () => {
    tv = await makeTempVault();
    const oldFile = await writeFile(tv.dir, 'a-old.md', 'findme old');
    await writeFile(tv.dir, 'z-new.md', 'findme new');
    const past = new Date(Date.now() - 60_000);
    await fs.utimes(oldFile, past, past);
    const result = await searchNotes(tv.vault, 'findme', { sortBy: 'mtime', limit: 1 });
    expect(result.matches[0]?.path).toBe('z-new.md');
    expect(result.hasMore).toBe(true);
  });

  it('filters by inline tag and frontmatter tags', async () => {
    tv = await makeTempVault();
    await writeFile(tv.dir, 'inline.md', 'findme #work today');
    await writeFile(
      tv.dir,
      'front.md',
      '---\ntags: [work, deep]\n---\nfindme in frontmatter note',
    );
    await writeFile(
      tv.dir,
      'front-list.md',
      '---\ntags:\n  - work\n---\nfindme in list note',
    );
    await writeFile(tv.dir, 'untagged.md', 'findme untagged');
    await writeFile(tv.dir, 'partial.md', 'findme #workshop');

    const result = await searchNotes(tv.vault, 'findme', { tag: 'work' });
    expect(result.matches.map((m) => m.path).sort()).toEqual([
      'front-list.md',
      'front.md',
      'inline.md',
    ]);
  });
});
