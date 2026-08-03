import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendToNote, createNote, readNote } from '@vault-mcp/core';
import {
  cleanup,
  expectVaultError,
  makeTempVault,
  writeFile,
} from './helpers.js';
import type { TempVault } from './helpers.js';

describe('readNote', () => {
  let tv: TempVault;

  afterEach(async () => {
    await cleanup(tv);
  });

  it('returns full content and size for a small note', async () => {
    tv = await makeTempVault();
    await writeFile(tv.dir, 'note.md', '# Hello\nworld\n');
    const note = await readNote(tv.vault, 'note.md');
    expect(note).toEqual({
      path: 'note.md',
      content: '# Hello\nworld\n',
      truncated: false,
      sizeBytes: Buffer.byteLength('# Hello\nworld\n'),
    });
  });

  it('throws NOT_FOUND for a missing note', async () => {
    tv = await makeTempVault();
    await expectVaultError(readNote(tv.vault, 'missing.md'), 'NOT_FOUND');
  });

  it('does not truncate when the size is exactly maxReadBytes', async () => {
    tv = await makeTempVault({ maxReadBytes: 3 });
    await writeFile(tv.dir, 'note.md', 'aé'); // 1 + 2 = 3 bytes
    const note = await readNote(tv.vault, 'note.md');
    expect(note.content).toBe('aé');
    expect(note.truncated).toBe(false);
    expect(note.sizeBytes).toBe(3);
  });

  it('truncates without a broken code point when the cut splits a 2-byte char', async () => {
    tv = await makeTempVault({ maxReadBytes: 4 });
    // 'a'(1) + 'é'(2) + '€'(3) = 6 bytes; byte 4 lands inside '€'.
    await writeFile(tv.dir, 'note.md', 'aé€');
    const note = await readNote(tv.vault, 'note.md');
    expect(note.content).toBe('aé');
    expect(note.truncated).toBe(true);
    expect(note.sizeBytes).toBe(6);
    expect(note.content).not.toContain('�');
  });

  it('truncates without a broken code point when the cut splits an emoji', async () => {
    tv = await makeTempVault({ maxReadBytes: 5 });
    // 'ab'(2) + '😀'(4) + 'xy'(2) = 8 bytes; byte 5 lands inside the emoji.
    await writeFile(tv.dir, 'note.md', 'ab😀xy');
    const note = await readNote(tv.vault, 'note.md');
    expect(note.content).toBe('ab');
    expect(note.truncated).toBe(true);
    expect(note.sizeBytes).toBe(8);
    expect(note.content).not.toContain('�');
  });

  it('keeps a multibyte char that ends exactly at the cut', async () => {
    tv = await makeTempVault({ maxReadBytes: 3 });
    // 'a'(1) + 'é'(2) + 'b'(1) = 4 bytes; the first 3 bytes are complete chars.
    await writeFile(tv.dir, 'note.md', 'aéb');
    const note = await readNote(tv.vault, 'note.md');
    expect(note.content).toBe('aé');
    expect(note.truncated).toBe(true);
    expect(note.sizeBytes).toBe(4);
  });

  it('reports the full on-disk size for large truncated notes', async () => {
    tv = await makeTempVault({ maxReadBytes: 10 });
    const big = 'x'.repeat(1000);
    await writeFile(tv.dir, 'big.md', big);
    const note = await readNote(tv.vault, 'big.md');
    expect(note.content).toBe('x'.repeat(10));
    expect(note.truncated).toBe(true);
    expect(note.sizeBytes).toBe(1000);
  });
});

describe('createNote', () => {
  let tv: TempVault;

  beforeEach(async () => {
    tv = await makeTempVault();
  });

  afterEach(async () => {
    await cleanup(tv);
  });

  it('creates a note with the full content and returns its relative path', async () => {
    const result = await createNote(tv.vault, 'new.md', '# Fresh\n');
    expect(result).toEqual({ path: 'new.md' });
    const raw = await fs.readFile(path.join(tv.dir, 'new.md'), 'utf8');
    expect(raw).toBe('# Fresh\n');
  });

  it('creates missing parent directories as real directories', async () => {
    await createNote(tv.vault, 'a/b/c/deep.md', 'deep');
    const st = await fs.lstat(path.join(tv.dir, 'a', 'b', 'c'));
    expect(st.isDirectory()).toBe(true);
    expect(st.isSymbolicLink()).toBe(false);
    const raw = await fs.readFile(path.join(tv.dir, 'a', 'b', 'c', 'deep.md'), 'utf8');
    expect(raw).toBe('deep');
  });

  it('leaves no temp files behind after a successful create', async () => {
    await createNote(tv.vault, 'clean.md', 'content');
    const entries = await fs.readdir(tv.dir);
    expect(entries.sort()).toEqual(['clean.md']);
  });

  it('throws ALREADY_EXISTS on second create and preserves the original', async () => {
    await createNote(tv.vault, 'once.md', 'original');
    await expectVaultError(createNote(tv.vault, 'once.md', 'clobber'), 'ALREADY_EXISTS');
    const raw = await fs.readFile(path.join(tv.dir, 'once.md'), 'utf8');
    expect(raw).toBe('original');
    // The failed attempt left no temp files either.
    expect(await fs.readdir(tv.dir)).toEqual(['once.md']);
  });

  it('never leaves a partially-written target: content appears fully or not at all', async () => {
    // The visible target must be born complete via link(2): after create the
    // full content is present; after a failed create nothing is present.
    const content = 'line\n'.repeat(10_000);
    await createNote(tv.vault, 'atomic.md', content);
    const raw = await fs.readFile(path.join(tv.dir, 'atomic.md'), 'utf8');
    expect(raw).toBe(content);

    await expectVaultError(createNote(tv.vault, '../escape.md', 'x'), 'INVALID_PATH');
    const entries = await fs.readdir(tv.dir);
    expect(entries.sort()).toEqual(['atomic.md']);
  });
});

describe('appendToNote', () => {
  let tv: TempVault;

  beforeEach(async () => {
    tv = await makeTempVault();
  });

  afterEach(async () => {
    await cleanup(tv);
  });

  it('throws NOT_FOUND when the note does not exist (append never creates)', async () => {
    await expectVaultError(appendToNote(tv.vault, 'missing.md', 'x'), 'NOT_FOUND');
    await expect(fs.stat(path.join(tv.dir, 'missing.md'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('adds exactly one newline boundary when the file lacks a trailing newline', async () => {
    await writeFile(tv.dir, 'note.md', 'existing');
    await appendToNote(tv.vault, 'note.md', 'added');
    const raw = await fs.readFile(path.join(tv.dir, 'note.md'), 'utf8');
    expect(raw).toBe('existing\nadded\n');
  });

  it('does not double the newline when the file already ends with one', async () => {
    await writeFile(tv.dir, 'note.md', 'existing\n');
    await appendToNote(tv.vault, 'note.md', 'added');
    const raw = await fs.readFile(path.join(tv.dir, 'note.md'), 'utf8');
    expect(raw).toBe('existing\nadded\n');
  });

  it('appends to an empty file without a leading newline', async () => {
    await writeFile(tv.dir, 'note.md', '');
    await appendToNote(tv.vault, 'note.md', 'first');
    const raw = await fs.readFile(path.join(tv.dir, 'note.md'), 'utf8');
    expect(raw).toBe('first\n');
  });

  it('keeps a single trailing newline when the appended content brings its own', async () => {
    await writeFile(tv.dir, 'note.md', 'a\n');
    await appendToNote(tv.vault, 'note.md', 'b\n');
    const raw = await fs.readFile(path.join(tv.dir, 'note.md'), 'utf8');
    expect(raw).toBe('a\nb\n');
  });

  it('returns the relative path and the new full size in bytes', async () => {
    await writeFile(tv.dir, 'note.md', 'olá'); // 4 bytes, no newline
    const result = await appendToNote(tv.vault, 'note.md', 'aí'); // 3 bytes
    expect(result.path).toBe('note.md');
    // 'olá' + '\n' + 'aí' + '\n' = 4 + 1 + 3 + 1
    expect(result.sizeBytes).toBe(9);
    const st = await fs.stat(path.join(tv.dir, 'note.md'));
    expect(st.size).toBe(9);
  });

  it('leaves no temp files behind', async () => {
    await writeFile(tv.dir, 'note.md', 'a\n');
    await appendToNote(tv.vault, 'note.md', 'b');
    expect(await fs.readdir(tv.dir)).toEqual(['note.md']);
  });
});

describe('temp file cleanup when the temp write itself fails', () => {
  let tv: TempVault;

  beforeEach(async () => {
    tv = await makeTempVault();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanup(tv);
  });

  type OpenFn = typeof fs.open;

  /**
   * Let the exclusive `wx` open succeed (so the temp file really exists on
   * disk) and make the write that follows fail the way a full disk does.
   */
  function breakTempWrites(failing: 'writeFile' | 'sync'): void {
    const realOpen: OpenFn = fs.open.bind(fs) as OpenFn;
    vi.spyOn(fs, 'open').mockImplementation((async (
      file: Parameters<OpenFn>[0],
      flags?: Parameters<OpenFn>[1],
      mode?: Parameters<OpenFn>[2],
    ) => {
      const handle = await realOpen(file, flags, mode);
      if (flags === 'wx') {
        Object.defineProperty(handle, failing, {
          configurable: true,
          value: () =>
            Promise.reject(
              Object.assign(new Error('no space left on device'), { code: 'ENOSPC' }),
            ),
        });
      }
      return handle;
    }) as OpenFn);
  }

  it('removes the temp file when createNote fails mid-write (ENOSPC)', async () => {
    breakTempWrites('writeFile');
    await expect(createNote(tv.vault, 'new.md', 'content')).rejects.toMatchObject({
      code: 'ENOSPC',
    });
    // No note, and above all no hidden ".new.md.<rand>.tmp" left behind.
    expect(await fs.readdir(tv.dir)).toEqual([]);
  });

  it('removes the temp file when the fsync of a create fails', async () => {
    breakTempWrites('sync');
    await expect(createNote(tv.vault, 'new.md', 'content')).rejects.toMatchObject({
      code: 'ENOSPC',
    });
    expect(await fs.readdir(tv.dir)).toEqual([]);
  });

  it('removes the temp file when appendToNote fails mid-write, keeping the note intact', async () => {
    await writeFile(tv.dir, 'note.md', 'original\n');
    breakTempWrites('writeFile');
    await expect(appendToNote(tv.vault, 'note.md', 'more')).rejects.toMatchObject({
      code: 'ENOSPC',
    });
    expect(await fs.readdir(tv.dir)).toEqual(['note.md']);
    expect(await fs.readFile(path.join(tv.dir, 'note.md'), 'utf8')).toBe('original\n');
  });

  it('does not accumulate temp files across retries', async () => {
    breakTempWrites('writeFile');
    for (let i = 0; i < 5; i += 1) {
      await expect(createNote(tv.vault, 'retry.md', 'content')).rejects.toMatchObject({
        code: 'ENOSPC',
      });
    }
    expect(await fs.readdir(tv.dir)).toEqual([]);
  });
});
