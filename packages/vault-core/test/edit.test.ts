import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deleteNote, editNote, moveNote, readNote } from '@vault-mcp/core';
import { cleanup, expectVaultError, makeTempVault, writeFile } from './helpers.js';
import type { TempVault } from './helpers.js';

describe('editNote', () => {
  let tv: TempVault;

  beforeEach(async () => {
    tv = await makeTempVault();
  });

  afterEach(async () => {
    await cleanup(tv);
  });

  it('applies a single unique replacement', async () => {
    await writeFile(tv.dir, 'note.md', '- [ ] buy milk\n- [ ] call mom\n');
    const result = await editNote(tv.vault, 'note.md', [
      { oldString: '- [ ] buy milk', newString: '- [x] buy milk' },
    ]);
    expect(result.editsApplied).toBe(1);
    const raw = await fs.readFile(path.join(tv.dir, 'note.md'), 'utf8');
    expect(raw).toBe('- [x] buy milk\n- [ ] call mom\n');
  });

  it('applies several edits in order, each against the evolving content', async () => {
    await writeFile(tv.dir, 'note.md', 'alpha\nbeta\n');
    await editNote(tv.vault, 'note.md', [
      { oldString: 'alpha', newString: 'gamma' },
      { oldString: 'gamma\nbeta', newString: 'gamma\ndelta' },
    ]);
    const raw = await fs.readFile(path.join(tv.dir, 'note.md'), 'utf8');
    expect(raw).toBe('gamma\ndelta\n');
  });

  it('deletes text with an empty new string', async () => {
    await writeFile(tv.dir, 'note.md', 'keep\nremove me\nkeep too\n');
    await editNote(tv.vault, 'note.md', [{ oldString: 'remove me\n', newString: '' }]);
    const raw = await fs.readFile(path.join(tv.dir, 'note.md'), 'utf8');
    expect(raw).toBe('keep\nkeep too\n');
  });

  it('rejects an old string that does not occur', async () => {
    await writeFile(tv.dir, 'note.md', 'content\n');
    await expectVaultError(
      editNote(tv.vault, 'note.md', [{ oldString: 'absent', newString: 'x' }]),
      'NO_MATCH',
    );
  });

  it('rejects an ambiguous old string', async () => {
    await writeFile(tv.dir, 'note.md', 'dup\ndup\n');
    await expectVaultError(
      editNote(tv.vault, 'note.md', [{ oldString: 'dup', newString: 'x' }]),
      'AMBIGUOUS_MATCH',
    );
  });

  it('is all-or-nothing: a failing later edit leaves the file untouched', async () => {
    await writeFile(tv.dir, 'note.md', 'first\nsecond\n');
    await expectVaultError(
      editNote(tv.vault, 'note.md', [
        { oldString: 'first', newString: 'FIRST' },
        { oldString: 'missing', newString: 'x' },
      ]),
      'NO_MATCH',
    );
    const raw = await fs.readFile(path.join(tv.dir, 'note.md'), 'utf8');
    expect(raw).toBe('first\nsecond\n');
  });

  it('honors expectedHash and reports CONFLICT on a concurrent change', async () => {
    await writeFile(tv.dir, 'note.md', 'v1\n');
    const note = await readNote(tv.vault, 'note.md');
    // Simulate a change from another device between read and write.
    await fs.writeFile(path.join(tv.dir, 'note.md'), 'v2\n', 'utf8');
    await expectVaultError(
      editNote(tv.vault, 'note.md', [{ oldString: 'v2', newString: 'v3' }], {
        expectedHash: note.hash,
      }),
      'CONFLICT',
    );
    // With the fresh hash the same edit goes through.
    const fresh = await readNote(tv.vault, 'note.md');
    const result = await editNote(
      tv.vault,
      'note.md',
      [{ oldString: 'v2', newString: 'v3' }],
      { expectedHash: fresh.hash },
    );
    expect(result.hash).not.toBe(fresh.hash);
    expect(await fs.readFile(path.join(tv.dir, 'note.md'), 'utf8')).toBe('v3\n');
  });

  it('rejects identical old and new strings without writing', async () => {
    await writeFile(tv.dir, 'note.md', 'same\n');
    await expectVaultError(
      editNote(tv.vault, 'note.md', [{ oldString: 'same', newString: 'same' }]),
      'NO_MATCH',
    );
  });
});

describe('deleteNote', () => {
  let tv: TempVault;

  beforeEach(async () => {
    tv = await makeTempVault();
  });

  afterEach(async () => {
    await cleanup(tv);
  });

  it('moves the note into .trash instead of unlinking it', async () => {
    await writeFile(tv.dir, 'sub/gone.md', 'precious\n');
    const result = await deleteNote(tv.vault, 'sub/gone.md');
    expect(result.trashedTo).toBe('.trash/gone.md');
    await expectVaultError(readNote(tv.vault, 'sub/gone.md'), 'NOT_FOUND');
    const rescued = await fs.readFile(path.join(tv.dir, '.trash/gone.md'), 'utf8');
    expect(rescued).toBe('precious\n');
  });

  it('never overwrites an equally-named file already in the trash', async () => {
    await writeFile(tv.dir, 'a/x.md', 'first\n');
    await writeFile(tv.dir, 'b/x.md', 'second\n');
    await deleteNote(tv.vault, 'a/x.md');
    const result = await deleteNote(tv.vault, 'b/x.md');
    expect(result.trashedTo).not.toBe('.trash/x.md');
    expect(await fs.readFile(path.join(tv.dir, '.trash/x.md'), 'utf8')).toBe('first\n');
    const entries = await fs.readdir(path.join(tv.dir, '.trash'));
    expect(entries).toHaveLength(2);
  });

  it('reports NOT_FOUND for a missing note', async () => {
    await expectVaultError(deleteNote(tv.vault, 'nope.md'), 'NOT_FOUND');
  });
});

describe('moveNote', () => {
  let tv: TempVault;

  beforeEach(async () => {
    tv = await makeTempVault();
  });

  afterEach(async () => {
    await cleanup(tv);
  });

  it('moves a note, creating destination folders', async () => {
    await writeFile(tv.dir, '0-inbox/idea.md', 'the idea\n');
    const result = await moveNote(tv.vault, '0-inbox/idea.md', '1-projects/idea.md');
    expect(result).toEqual({ from: '0-inbox/idea.md', to: '1-projects/idea.md' });
    await expectVaultError(readNote(tv.vault, '0-inbox/idea.md'), 'NOT_FOUND');
    const moved = await readNote(tv.vault, '1-projects/idea.md');
    expect(moved.content).toBe('the idea\n');
  });

  it('renames in place', async () => {
    await writeFile(tv.dir, 'journal/2026-08-01.md', 'wrong date\n');
    await moveNote(tv.vault, 'journal/2026-08-01.md', 'journal/2026-08-02.md');
    const renamed = await readNote(tv.vault, 'journal/2026-08-02.md');
    expect(renamed.content).toBe('wrong date\n');
  });

  it('refuses to overwrite an existing destination', async () => {
    await writeFile(tv.dir, 'a.md', 'A\n');
    await writeFile(tv.dir, 'b.md', 'B\n');
    await expectVaultError(moveNote(tv.vault, 'a.md', 'b.md'), 'ALREADY_EXISTS');
    expect(await fs.readFile(path.join(tv.dir, 'b.md'), 'utf8')).toBe('B\n');
    expect(await fs.readFile(path.join(tv.dir, 'a.md'), 'utf8')).toBe('A\n');
  });

  it('reports NOT_FOUND for a missing source', async () => {
    await expectVaultError(moveNote(tv.vault, 'nope.md', 'dest.md'), 'NOT_FOUND');
  });

  it('rejects moving a note onto itself', async () => {
    await writeFile(tv.dir, 'same.md', 'x\n');
    await expectVaultError(moveNote(tv.vault, 'same.md', 'same.md'), 'INVALID_PATH');
  });
});
