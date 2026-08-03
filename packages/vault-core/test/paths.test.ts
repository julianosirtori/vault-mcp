import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createNote,
  readNote,
  resolveNotePath,
  toVaultRelative,
} from '@vault-mcp/core';
import type { VaultErrorCode } from '@vault-mcp/core';
import {
  cleanup,
  expectVaultError,
  makeOutsideDir,
  makeTempVault,
  writeFile,
} from './helpers.js';
import type { TempVault } from './helpers.js';

describe('resolveNotePath — path escape suite (M0 acceptance gate)', () => {
  let tv: TempVault;

  beforeEach(async () => {
    tv = await makeTempVault();
  });

  afterEach(async () => {
    await cleanup(tv);
  });

  const stringCases: Array<[label: string, relPath: string, code: VaultErrorCode]> = [
    ['../x.md (parent traversal)', '../x.md', 'INVALID_PATH'],
    ['a/../../x.md (nested traversal)', 'a/../../x.md', 'INVALID_PATH'],
    ['/etc/passwd.md (absolute path)', '/etc/passwd.md', 'INVALID_PATH'],
    ['~/x.md (home expansion)', '~/x.md', 'INVALID_PATH'],
    ['a/../b.md (.. segment even if contained)', 'a/../b.md', 'INVALID_PATH'],
    ['./x.md (. segment)', './x.md', 'INVALID_PATH'],
    ['x.md/ (trailing slash)', 'x.md/', 'INVALID_PATH'],
    ['a\\b.md (backslash)', 'a\\b.md', 'INVALID_PATH'],
    ['empty string', '', 'INVALID_PATH'],
    ['x\\0.md (NUL byte)', 'x\0.md', 'INVALID_PATH'],
    ['a//b.md (empty segment)', 'a//b.md', 'INVALID_PATH'],
    ['x.txt (not markdown)', 'x.txt', 'NOT_MARKDOWN'],
    ['no extension', 'x', 'NOT_MARKDOWN'],
    ['.obsidian/app.json (hidden + not markdown)', '.obsidian/app.json', 'NOT_MARKDOWN'],
    ['.obsidian/note.md (hidden dir)', '.obsidian/note.md', 'HIDDEN_PATH'],
    ['a/.hidden/x.md (nested hidden dir)', 'a/.hidden/x.md', 'HIDDEN_PATH'],
    ['.hidden.md (hidden file)', '.hidden.md', 'HIDDEN_PATH'],
  ];

  for (const [label, relPath, code] of stringCases) {
    it(`rejects ${label} with ${code} on read`, async () => {
      await expectVaultError(resolveNotePath(tv.vault, relPath), code);
    });

    it(`rejects ${label} with ${code} on create`, async () => {
      await expectVaultError(
        resolveNotePath(tv.vault, relPath, { forCreate: true }),
        code,
      );
    });
  }

  it('rejects a symlinked directory inside the vault pointing outside (read)', async () => {
    const outside = await makeOutsideDir(tv);
    await fs.mkdir(path.join(outside, 'target'));
    await writeFile(outside, 'target/x.md', 'outside content');
    await fs.symlink(path.join(outside, 'target'), path.join(tv.dir, 'link'));

    await expectVaultError(resolveNotePath(tv.vault, 'link/x.md'), 'OUTSIDE_VAULT');
    await expectVaultError(readNote(tv.vault, 'link/x.md'), 'OUTSIDE_VAULT');
    // The outside file was never touched.
    const raw = await fs.readFile(path.join(outside, 'target', 'x.md'), 'utf8');
    expect(raw).toBe('outside content');
  });

  it('rejects a symlinked directory inside the vault pointing outside (create)', async () => {
    const outside = await makeOutsideDir(tv);
    await fs.mkdir(path.join(outside, 'target'));
    await fs.symlink(path.join(outside, 'target'), path.join(tv.dir, 'link'));

    await expectVaultError(
      resolveNotePath(tv.vault, 'link/new.md', { forCreate: true }),
      'OUTSIDE_VAULT',
    );
    await expectVaultError(createNote(tv.vault, 'link/new.md', 'evil'), 'OUTSIDE_VAULT');
    // Deeper paths under the symlink are also rejected (walk-up resolution).
    await expectVaultError(
      resolveNotePath(tv.vault, 'link/deep/deeper/new.md', { forCreate: true }),
      'OUTSIDE_VAULT',
    );
    // Nothing was created outside the vault.
    expect(await fs.readdir(path.join(outside, 'target'))).toEqual([]);
  });

  it('rejects a symlinked file pointing outside', async () => {
    const outside = await makeOutsideDir(tv);
    const secret = await writeFile(outside, 'secret.md', 'secret content');
    await fs.symlink(secret, path.join(tv.dir, 'alias.md'));

    await expectVaultError(resolveNotePath(tv.vault, 'alias.md'), 'OUTSIDE_VAULT');
    await expectVaultError(readNote(tv.vault, 'alias.md'), 'OUTSIDE_VAULT');
    await expectVaultError(
      resolveNotePath(tv.vault, 'alias.md', { forCreate: true }),
      'OUTSIDE_VAULT',
    );
  });

  it('rejects a symlinked file even when it points inside the vault', async () => {
    await writeFile(tv.dir, 'real.md', 'inside');
    await fs.symlink(path.join(tv.dir, 'real.md'), path.join(tv.dir, 'linked.md'));
    await expectVaultError(resolveNotePath(tv.vault, 'linked.md'), 'OUTSIDE_VAULT');
  });

  it('rejects a directory named x.md with NOT_A_FILE', async () => {
    await fs.mkdir(path.join(tv.dir, 'x.md'));
    await expectVaultError(resolveNotePath(tv.vault, 'x.md'), 'NOT_A_FILE');
    await expectVaultError(
      resolveNotePath(tv.vault, 'x.md', { forCreate: true }),
      'NOT_A_FILE',
    );
    await expectVaultError(readNote(tv.vault, 'x.md'), 'NOT_A_FILE');
  });

  it('resolves a valid top-level note to an absolute path inside the vault', async () => {
    await writeFile(tv.dir, 'note.md', 'hello');
    const abs = await resolveNotePath(tv.vault, 'note.md');
    expect(path.isAbsolute(abs)).toBe(true);
    expect(abs).toBe(path.join(tv.vault.root, 'note.md'));
  });

  it('resolves a valid nested note and accepts .MD case-insensitively', async () => {
    await writeFile(tv.dir, 'a/b/UPPER.MD', 'hello');
    const abs = await resolveNotePath(tv.vault, 'a/b/UPPER.MD');
    expect(abs).toBe(path.join(tv.vault.root, 'a', 'b', 'UPPER.MD'));
  });

  it('resolves forCreate paths whose intermediate directories do not exist yet', async () => {
    const abs = await resolveNotePath(tv.vault, 'brand/new/dir/note.md', {
      forCreate: true,
    });
    expect(abs).toBe(path.join(tv.vault.root, 'brand', 'new', 'dir', 'note.md'));
    // Nothing was created by resolution alone.
    await expect(fs.stat(path.join(tv.dir, 'brand'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('throws NOT_FOUND on read when the parent directory does not exist', async () => {
    await expectVaultError(resolveNotePath(tv.vault, 'missing-dir/x.md'), 'NOT_FOUND');
  });
});

describe('resolveNotePath — hidden folders reached through a symlink', () => {
  let tv: TempVault;

  beforeEach(async () => {
    tv = await makeTempVault();
  });

  afterEach(async () => {
    await cleanup(tv);
  });

  it('rejects a directory symlink inside the vault pointing at a dot-directory', async () => {
    await writeFile(tv.dir, '.obsidian/secret.md', 'private config note');
    await fs.symlink(path.join(tv.dir, '.obsidian'), path.join(tv.dir, 'cfg'));

    await expectVaultError(resolveNotePath(tv.vault, 'cfg/secret.md'), 'HIDDEN_PATH');
    await expectVaultError(readNote(tv.vault, 'cfg/secret.md'), 'HIDDEN_PATH');
    await expectVaultError(
      resolveNotePath(tv.vault, 'cfg/evil.md', { forCreate: true }),
      'HIDDEN_PATH',
    );
    await expectVaultError(createNote(tv.vault, 'cfg/evil.md', 'x'), 'HIDDEN_PATH');
    // Nothing was written into the hidden directory.
    expect(await fs.readdir(path.join(tv.dir, '.obsidian'))).toEqual(['secret.md']);
  });

  it('rejects a nested symlink hop into .trash', async () => {
    await writeFile(tv.dir, '.trash/deleted.md', 'deleted note');
    await fs.mkdir(path.join(tv.dir, 'a'), { recursive: true });
    await fs.symlink(path.join(tv.dir, '.trash'), path.join(tv.dir, 'a', 'bin'));

    await expectVaultError(resolveNotePath(tv.vault, 'a/bin/deleted.md'), 'HIDDEN_PATH');
    await expectVaultError(readNote(tv.vault, 'a/bin/deleted.md'), 'HIDDEN_PATH');
  });

  it('still allows a symlink to a normal directory inside the vault', async () => {
    await writeFile(tv.dir, 'real/note.md', 'ok');
    await fs.symlink(path.join(tv.dir, 'real'), path.join(tv.dir, 'alias'));
    const abs = await resolveNotePath(tv.vault, 'alias/note.md');
    expect(abs).toBe(path.join(tv.vault.root, 'real', 'note.md'));
    expect((await readNote(tv.vault, 'alias/note.md')).content).toBe('ok');
  });
});

describe('resolveNotePath — invisible characters in paths', () => {
  let tv: TempVault;

  beforeEach(async () => {
    tv = await makeTempVault();
  });

  afterEach(async () => {
    await cleanup(tv);
  });

  const TAG = String.fromCodePoint(0xe0041, 0xe0042);

  const invisibleCases: Array<[label: string, relPath: string]> = [
    ['Unicode tag block in the basename', `notes/x${TAG}.md`],
    ['Unicode tag block in a folder name', `dir${TAG}/x.md`],
    ['zero-width space (U+200B)', 'notes/a\u200Bb.md'],
    ['left-to-right mark (U+200E)', 'notes/a\u200Eb.md'],
    ['right-to-left override (U+202E)', 'notes/a\u202Eb.md'],
    ['word joiner (U+2060)', 'notes/a\u2060b.md'],
    ['BOM / zero-width no-break space (U+FEFF)', 'notes/a\uFEFFb.md'],
    ['soft hyphen (U+00AD)', 'notes/a\u00ADb.md'],
    ['newline', 'notes/a\nb.md'],
    ['carriage return', 'notes/a\rb.md'],
    ['tab', 'notes/a\tb.md'],
    ['escape control character', 'notes/a\u001Bb.md'],
    ['DEL control character', 'notes/a\u007Fb.md'],
  ];

  for (const [label, relPath] of invisibleCases) {
    it(`rejects ${label} with INVALID_PATH on read and create`, async () => {
      await expectVaultError(resolveNotePath(tv.vault, relPath), 'INVALID_PATH');
      await expectVaultError(
        resolveNotePath(tv.vault, relPath, { forCreate: true }),
        'INVALID_PATH',
      );
      await expectVaultError(createNote(tv.vault, relPath, 'payload'), 'INVALID_PATH');
    });
  }

  it('never echoes the invisible characters back in the error message', async () => {
    let message = '';
    try {
      await resolveNotePath(tv.vault, `notes/x${TAG}\u200B.md`);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).not.toBe('');
    expect(message).not.toContain(TAG);
    expect(message).not.toContain('\u200B');
  });

  it('still accepts ordinary non-ASCII names', async () => {
    await writeFile(tv.dir, 'notas/reunião — café 🎉.md', 'ok');
    const abs = await resolveNotePath(tv.vault, 'notas/reunião — café 🎉.md');
    expect(abs).toBe(path.join(tv.vault.root, 'notas', 'reunião — café 🎉.md'));
  });
});

describe('toVaultRelative', () => {
  let tv: TempVault;

  beforeEach(async () => {
    tv = await makeTempVault();
  });

  afterEach(async () => {
    await cleanup(tv);
  });

  it('returns forward-slash relative paths', () => {
    const abs = path.join(tv.vault.root, 'a', 'b', 'c.md');
    expect(toVaultRelative(tv.vault, abs)).toBe('a/b/c.md');
  });

  it('round-trips with resolveNotePath', async () => {
    await writeFile(tv.dir, 'sub/note.md', 'x');
    const abs = await resolveNotePath(tv.vault, 'sub/note.md');
    expect(toVaultRelative(tv.vault, abs)).toBe('sub/note.md');
  });
});
