import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendToSection, getVaultTree } from '@vault-mcp/core';
import { cleanup, expectVaultError, makeTempVault, writeFile } from './helpers.js';
import type { TempVault } from './helpers.js';

describe('appendToSection', () => {
  let tv: TempVault;

  beforeEach(async () => {
    tv = await makeTempVault();
  });

  afterEach(async () => {
    await cleanup(tv);
  });

  it('inserts at the end of the section, before the next heading', async () => {
    await writeFile(
      tv.dir,
      'daily.md',
      '# Day\n\n## 📥 Inbox Rápido\n- existing item\n\n## 🎯 Foco do Dia\n- focus\n',
    );
    await appendToSection(tv.vault, 'daily.md', '📥 Inbox Rápido', '- captured');
    const raw = await fs.readFile(path.join(tv.dir, 'daily.md'), 'utf8');
    expect(raw).toBe(
      '# Day\n\n## 📥 Inbox Rápido\n- existing item\n- captured\n\n## 🎯 Foco do Dia\n- focus\n',
    );
  });

  it('matches the heading case-insensitively and with leading #s', async () => {
    await writeFile(tv.dir, 'n.md', '## Ideas\n- one\n');
    await appendToSection(tv.vault, 'n.md', '## ideas', '- two');
    const raw = await fs.readFile(path.join(tv.dir, 'n.md'), 'utf8');
    expect(raw).toBe('## Ideas\n- one\n- two\n');
  });

  it('a deeper subheading stays inside the section; a same-level one ends it', async () => {
    await writeFile(
      tv.dir,
      'n.md',
      '## Projects\n### Sub\ndetail\n\n## Next\nother\n',
    );
    await appendToSection(tv.vault, 'n.md', 'Projects', '- appended');
    const raw = await fs.readFile(path.join(tv.dir, 'n.md'), 'utf8');
    expect(raw).toBe('## Projects\n### Sub\ndetail\n- appended\n\n## Next\nother\n');
  });

  it('ignores # lines inside code fences when finding headings and boundaries', async () => {
    await writeFile(
      tv.dir,
      'n.md',
      '## Log\nentry\n```dataviewjs\n## not a heading\nconst x = 1\n```\n',
    );
    await appendToSection(tv.vault, 'n.md', 'Log', '- new entry');
    const raw = await fs.readFile(path.join(tv.dir, 'n.md'), 'utf8');
    expect(raw).toBe(
      '## Log\nentry\n```dataviewjs\n## not a heading\nconst x = 1\n```\n- new entry\n',
    );
  });

  it('reports SECTION_NOT_FOUND with the available headings', async () => {
    await writeFile(tv.dir, 'n.md', '## Alpha\n## Beta\n');
    let message = '';
    try {
      await appendToSection(tv.vault, 'n.md', 'Gamma', 'x');
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('Gamma');
    expect(message).toContain('## Alpha');
    expect(message).toContain('## Beta');
  });

  it('honors expectedHash', async () => {
    await writeFile(tv.dir, 'n.md', '## A\n');
    await expectVaultError(
      appendToSection(tv.vault, 'n.md', 'A', 'x', { expectedHash: 'deadbeef0000' }),
      'CONFLICT',
    );
  });

  it('reports the 1-based line where content landed', async () => {
    await writeFile(tv.dir, 'n.md', '## A\nline2\n\n## B\n');
    const result = await appendToSection(tv.vault, 'n.md', 'A', '- x');
    expect(result.insertedAtLine).toBe(3);
  });
});

describe('getVaultTree', () => {
  let tv: TempVault;

  beforeEach(async () => {
    tv = await makeTempVault();
  });

  afterEach(async () => {
    await cleanup(tv);
  });

  it('lists folders with direct note counts, including empty ancestors', async () => {
    await writeFile(tv.dir, 'root-note.md', 'x');
    await writeFile(tv.dir, '1-projects/vault/notes.md', 'x');
    await writeFile(tv.dir, '1-projects/vault/spec.md', 'x');
    await writeFile(tv.dir, '5-journal/2026-08-01.md', 'x');
    const tree = await getVaultTree(tv.vault);
    expect(tree).toEqual([
      { path: '', noteCount: 1 },
      { path: '1-projects', noteCount: 0 },
      { path: '1-projects/vault', noteCount: 2 },
      { path: '5-journal', noteCount: 1 },
    ]);
  });
});
