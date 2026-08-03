import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDailyNote, formatDailyName, getDailyNote } from '@vault-mcp/core';
import { cleanup, expectVaultError, makeTempVault, writeFile } from './helpers.js';
import type { TempVault } from './helpers.js';

async function writeDailyConfig(dir: string, config: unknown): Promise<void> {
  await fs.mkdir(path.join(dir, '.obsidian'), { recursive: true });
  await fs.writeFile(
    path.join(dir, '.obsidian', 'daily-notes.json'),
    typeof config === 'string' ? config : JSON.stringify(config),
    'utf8',
  );
}

async function writePeriodicConfig(dir: string, config: unknown): Promise<void> {
  const pluginDir = path.join(dir, '.obsidian', 'plugins', 'periodic-notes');
  await fs.mkdir(pluginDir, { recursive: true });
  await fs.writeFile(path.join(pluginDir, 'data.json'), JSON.stringify(config), 'utf8');
}

describe('formatDailyName', () => {
  const date = new Date(2026, 7, 2, 12, 0, 0); // Sunday, August 2nd 2026, local noon

  it('renders every supported token', () => {
    expect(formatDailyName('YYYY', date)).toBe('2026');
    expect(formatDailyName('YY', date)).toBe('26');
    expect(formatDailyName('MMMM', date)).toBe('August');
    expect(formatDailyName('MMM', date)).toBe('Aug');
    expect(formatDailyName('MM', date)).toBe('08');
    expect(formatDailyName('M', date)).toBe('8');
    expect(formatDailyName('DD', date)).toBe('02');
    expect(formatDailyName('D', date)).toBe('2');
    expect(formatDailyName('dddd', date)).toBe('Sunday');
    expect(formatDailyName('ddd', date)).toBe('Sun');
  });

  it('renders the default Obsidian format', () => {
    expect(formatDailyName('YYYY-MM-DD', date)).toBe('2026-08-02');
  });

  it('supports subfolder formats with slashes', () => {
    expect(formatDailyName('YYYY/MM/YYYY-MM-DD', date)).toBe('2026/08/2026-08-02');
  });

  it('treats [bracketed] text as a literal, even when it looks like tokens', () => {
    expect(formatDailyName('[day] DD', date)).toBe('day 02');
    expect(formatDailyName('[YYYY]-YYYY', date)).toBe('YYYY-2026');
  });

  it('passes unknown characters through unchanged', () => {
    expect(formatDailyName('YYYY_MM+DD!', date)).toBe('2026_08+02!');
  });

  it('pads single-digit fields', () => {
    const jan = new Date(2026, 0, 5, 12, 0, 0);
    expect(formatDailyName('YYYY-MM-DD', jan)).toBe('2026-01-05');
    expect(formatDailyName('M/D', jan)).toBe('1/5');
  });
});

describe('getDailyNote', () => {
  let tv: TempVault;

  afterEach(async () => {
    vi.useRealTimers();
    await cleanup(tv);
  });

  it('uses Obsidian defaults when the config file is missing', async () => {
    tv = await makeTempVault();
    const info = await getDailyNote(tv.vault, '2026-08-02');
    expect(info).toEqual({ path: '2026-08-02.md', date: '2026-08-02', exists: false });
  });

  it('uses Obsidian defaults when the config file is invalid JSON', async () => {
    tv = await makeTempVault();
    await writeDailyConfig(tv.dir, '{not json');
    const info = await getDailyNote(tv.vault, '2026-08-02');
    expect(info).toEqual({ path: '2026-08-02.md', date: '2026-08-02', exists: false });
  });

  it('reports the resolved date even when the format does not contain it', async () => {
    tv = await makeTempVault();
    await writeDailyConfig(tv.dir, { folder: 'log', format: 'dddd' });
    const info = await getDailyNote(tv.vault, '2026-08-02');
    expect(info.path).toBe('log/Sunday.md');
    expect(info.date).toBe('2026-08-02');
  });

  it('reports the resolved date for an existing note too', async () => {
    tv = await makeTempVault();
    await writeFile(tv.dir, '2026-08-02.md', '# Today\n');
    const info = await getDailyNote(tv.vault, '2026-08-02');
    expect(info.exists).toBe(true);
    expect(info.date).toBe('2026-08-02');
  });

  it('reports today as YYYY-MM-DD when no date is given', async () => {
    tv = await makeTempVault();
    const now = new Date();
    const expected = `${String(now.getFullYear()).padStart(4, '0')}-${String(
      now.getMonth() + 1,
    ).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const info = await getDailyNote(tv.vault);
    expect(info.date).toBe(expected);
    expect(info.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('honors a custom folder and a subfolder format', async () => {
    tv = await makeTempVault();
    await writeDailyConfig(tv.dir, {
      folder: 'journal',
      format: 'YYYY/MM/YYYY-MM-DD',
    });
    const info = await getDailyNote(tv.vault, '2026-08-02');
    expect(info.path).toBe('journal/2026/08/2026-08-02.md');
    expect(info.exists).toBe(false);
  });

  it('honors bracket literals in the format', async () => {
    tv = await makeTempVault();
    await writeDailyConfig(tv.dir, { folder: 'log', format: '[day] DD' });
    const info = await getDailyNote(tv.vault, '2026-08-02');
    expect(info.path).toBe('log/day 02.md');
    expect(info.exists).toBe(false);
  });

  it('returns the note content when the daily note exists', async () => {
    tv = await makeTempVault();
    await writeDailyConfig(tv.dir, { folder: 'journal', format: 'YYYY-MM-DD' });
    await writeFile(tv.dir, 'journal/2026-08-02.md', '# Today\n');
    const info = await getDailyNote(tv.vault, '2026-08-02');
    expect(info.exists).toBe(true);
    expect(info.path).toBe('journal/2026-08-02.md');
    expect(info.note).toEqual({
      path: 'journal/2026-08-02.md',
      content: '# Today\n',
      truncated: false,
      sizeBytes: 8,
      hash: expect.stringMatching(/^[0-9a-f]{12}$/) as unknown,
    });
  });

  it('never creates the file when it is absent', async () => {
    tv = await makeTempVault();
    await writeDailyConfig(tv.dir, { folder: 'journal', format: 'YYYY-MM-DD' });
    const info = await getDailyNote(tv.vault, '2026-08-02');
    expect(info.exists).toBe(false);
    expect(info.note).toBeUndefined();
    // Neither the note nor its folder was created as a side effect.
    await expect(fs.stat(path.join(tv.dir, 'journal'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('defaults to today in server-local time', async () => {
    tv = await makeTempVault();
    const now = new Date();
    const expected = `${String(now.getFullYear()).padStart(4, '0')}-${String(
      now.getMonth() + 1,
    ).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}.md`;
    const info = await getDailyNote(tv.vault);
    expect(info.path).toBe(expected);
  });

  it('rejects malformed dates', async () => {
    tv = await makeTempVault();
    await expectVaultError(getDailyNote(tv.vault, 'not-a-date'), 'INVALID_PATH');
    await expectVaultError(getDailyNote(tv.vault, '2026-8-2'), 'INVALID_PATH');
    await expectVaultError(getDailyNote(tv.vault, '02-08-2026'), 'INVALID_PATH');
  });

  it('rejects impossible calendar dates', async () => {
    tv = await makeTempVault();
    await expectVaultError(getDailyNote(tv.vault, '2026-02-30'), 'INVALID_PATH');
    await expectVaultError(getDailyNote(tv.vault, '2026-13-01'), 'INVALID_PATH');
    await expectVaultError(getDailyNote(tv.vault, '2026-00-10'), 'INVALID_PATH');
  });

  it('surfaces a hostile config as a VaultError, never an escape', async () => {
    tv = await makeTempVault();
    await writeDailyConfig(tv.dir, { folder: '../evil', format: 'YYYY-MM-DD' });
    await expectVaultError(getDailyNote(tv.vault, '2026-08-02'), 'INVALID_PATH');

    await writeDailyConfig(tv.dir, { folder: '.obsidian', format: 'YYYY-MM-DD' });
    await expectVaultError(getDailyNote(tv.vault, '2026-08-02'), 'HIDDEN_PATH');
  });

  it('falls back to the Periodic Notes plugin config when the core one is absent', async () => {
    tv = await makeTempVault();
    await writePeriodicConfig(tv.dir, {
      daily: { enabled: true, folder: '5-journal', format: 'YYYY-MM-DD' },
    });
    const info = await getDailyNote(tv.vault, '2026-08-03');
    expect(info.path).toBe('5-journal/2026-08-03.md');
  });

  it('prefers the core config over Periodic Notes when both exist', async () => {
    tv = await makeTempVault();
    await writeDailyConfig(tv.dir, { folder: 'core-journal', format: 'YYYY-MM-DD' });
    await writePeriodicConfig(tv.dir, {
      daily: { enabled: true, folder: '5-journal', format: 'YYYY-MM-DD' },
    });
    const info = await getDailyNote(tv.vault, '2026-08-03');
    expect(info.path).toBe('core-journal/2026-08-03.md');
  });

  it('ignores a disabled Periodic Notes daily section', async () => {
    tv = await makeTempVault();
    await writePeriodicConfig(tv.dir, {
      daily: { enabled: false, folder: '5-journal', format: 'YYYY-MM-DD' },
    });
    const info = await getDailyNote(tv.vault, '2026-08-03');
    expect(info.path).toBe('2026-08-03.md');
  });
});

describe('createDailyNote', () => {
  let tv: TempVault;

  afterEach(async () => {
    await cleanup(tv);
  });

  it('creates the note at the configured location, empty without a template', async () => {
    tv = await makeTempVault();
    await writeDailyConfig(tv.dir, { folder: 'journal', format: 'YYYY-MM-DD' });
    const result = await createDailyNote(tv.vault, '2026-08-03');
    expect(result).toEqual({
      path: 'journal/2026-08-03.md',
      date: '2026-08-03',
      created: true,
      templateApplied: false,
    });
    expect(await fs.readFile(path.join(tv.dir, 'journal/2026-08-03.md'), 'utf8')).toBe('');
  });

  it('seeds the note from the configured template with placeholders rendered', async () => {
    tv = await makeTempVault();
    await writeDailyConfig(tv.dir, {
      folder: 'journal',
      format: 'YYYY-MM-DD',
      template: 'templates/daily',
    });
    await writeFile(
      tv.dir,
      'templates/daily.md',
      '# {{title}}\n\nDate: {{date}} ({{date:dddd}})\n\n## 📥 Inbox Rápido\n\n## 🎯 Foco do Dia\n',
    );
    const result = await createDailyNote(tv.vault, '2026-08-02');
    expect(result.created).toBe(true);
    expect(result.templateApplied).toBe(true);
    const raw = await fs.readFile(path.join(tv.dir, 'journal/2026-08-02.md'), 'utf8');
    expect(raw).toBe(
      '# 2026-08-02\n\nDate: 2026-08-02 (Sunday)\n\n## 📥 Inbox Rápido\n\n## 🎯 Foco do Dia\n',
    );
  });

  it('renders formatted time placeholders with Moment-style time tokens', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 3, 17, 4, 9));
    tv = await makeTempVault();
    await writeDailyConfig(tv.dir, {
      folder: 'journal',
      format: 'YYYY-MM-DD',
      template: 'templates/time',
    });
    await writeFile(
      tv.dir,
      'templates/time.md',
      '{{time:HH:mm:ss}} / {{time:h:mm A}} / {{time}}\n',
    );

    await createDailyNote(tv.vault, '2026-08-03');

    expect(await fs.readFile(path.join(tv.dir, 'journal/2026-08-03.md'), 'utf8')).toBe(
      '17:04:09 / 5:04 PM / 17:04\n',
    );
  });

  it('is idempotent: an existing note is left untouched', async () => {
    tv = await makeTempVault();
    await writeDailyConfig(tv.dir, { folder: 'journal', format: 'YYYY-MM-DD' });
    await writeFile(tv.dir, 'journal/2026-08-03.md', 'already here\n');
    const result = await createDailyNote(tv.vault, '2026-08-03');
    expect(result.created).toBe(false);
    expect(await fs.readFile(path.join(tv.dir, 'journal/2026-08-03.md'), 'utf8')).toBe(
      'already here\n',
    );
  });

  it('creates an empty note when the template is missing, and reports it', async () => {
    tv = await makeTempVault();
    await writeDailyConfig(tv.dir, {
      folder: 'journal',
      format: 'YYYY-MM-DD',
      template: 'templates/nope',
    });
    const result = await createDailyNote(tv.vault, '2026-08-03');
    expect(result.created).toBe(true);
    expect(result.templateApplied).toBe(false);
  });

  it('reads the template from the Periodic Notes config too', async () => {
    tv = await makeTempVault();
    await writePeriodicConfig(tv.dir, {
      daily: {
        enabled: true,
        folder: '5-journal',
        format: 'YYYY-MM-DD',
        template: 'templates/daily.md',
      },
    });
    await writeFile(tv.dir, 'templates/daily.md', 'from periodic {{date}}\n');
    const result = await createDailyNote(tv.vault, '2026-08-03');
    expect(result.templateApplied).toBe(true);
    const raw = await fs.readFile(path.join(tv.dir, '5-journal/2026-08-03.md'), 'utf8');
    expect(raw).toBe('from periodic 2026-08-03\n');
  });
});
