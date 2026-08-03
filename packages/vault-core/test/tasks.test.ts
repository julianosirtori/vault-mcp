import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { completeTask, listTasks, postponeTask, readNote } from '@vault-mcp/core';
import { cleanup, expectVaultError, makeTempVault, writeFile } from './helpers.js';
import type { TempVault } from './helpers.js';

describe('listTasks', () => {
  let tv: TempVault;

  beforeEach(async () => {
    tv = await makeTempVault();
  });

  afterEach(async () => {
    await cleanup(tv);
  });

  it('parses Tasks-plugin signifiers and strips them from the text', async () => {
    await writeFile(
      tv.dir,
      'p.md',
      '- [ ] pay rent 📅 2026-08-05 ⏫\n- [x] old thing ✅ 2026-07-30\n* [ ] tag along 🛫 2026-08-01 ⏳ 2026-08-02\n',
    );
    const { tasks } = await listTasks(tv.vault, { status: 'all' });
    expect(tasks).toHaveLength(3);
    const rent = tasks.find((t) => t.text === 'pay rent');
    expect(rent).toMatchObject({
      due: '2026-08-05',
      priority: 'high',
      done: false,
      line: 1,
    });
    const old = tasks.find((t) => t.text === 'old thing');
    expect(old).toMatchObject({ done: true, doneDate: '2026-07-30' });
    const along = tasks.find((t) => t.text === 'tag along');
    expect(along).toMatchObject({ start: '2026-08-01', scheduled: '2026-08-02' });
  });

  it('defaults to open tasks and filters by due date window', async () => {
    await writeFile(
      tv.dir,
      't.md',
      [
        '- [ ] overdue 📅 2026-07-01',
        '- [ ] today 📅 2026-08-03',
        '- [ ] later 📅 2026-09-01',
        '- [ ] no due date',
        '- [x] done 📅 2026-07-01 ✅ 2026-07-02',
      ].join('\n'),
    );
    const open = await listTasks(tv.vault);
    expect(open.tasks.map((t) => t.text)).toEqual([
      'overdue',
      'today',
      'later',
      'no due date',
    ]);

    const dueOrOverdue = await listTasks(tv.vault, { dueBefore: '2026-08-03' });
    expect(dueOrOverdue.tasks.map((t) => t.text)).toEqual(['overdue', 'today']);

    const upcoming = await listTasks(tv.vault, { dueAfter: '2026-08-04' });
    expect(upcoming.tasks.map((t) => t.text)).toEqual(['later']);

    const done = await listTasks(tv.vault, { status: 'done' });
    expect(done.tasks.map((t) => t.text)).toEqual(['done']);
  });

  it('sorts by due date with undated tasks last and paginates', async () => {
    await writeFile(tv.dir, 'a.md', '- [ ] second 📅 2026-08-10\n- [ ] undated\n');
    await writeFile(tv.dir, 'b.md', '- [ ] first 📅 2026-08-01\n');
    const page1 = await listTasks(tv.vault, { limit: 2 });
    expect(page1.tasks.map((t) => t.text)).toEqual(['first', 'second']);
    expect(page1.hasMore).toBe(true);
    const page2 = await listTasks(tv.vault, { limit: 2, offset: 2 });
    expect(page2.tasks.map((t) => t.text)).toEqual(['undated']);
    expect(page2.hasMore).toBe(false);
  });

  it('scopes by pathPrefix as a folder prefix', async () => {
    await writeFile(tv.dir, '1-projects/x.md', '- [ ] in scope\n');
    await writeFile(tv.dir, '1-projects-archive/y.md', '- [ ] out of scope\n');
    const { tasks } = await listTasks(tv.vault, { pathPrefix: '1-projects' });
    expect(tasks.map((t) => t.text)).toEqual(['in scope']);
  });

  it('reports the containing note version hash on every task', async () => {
    await writeFile(tv.dir, 'h.md', '- [ ] hashed\n');
    const { tasks } = await listTasks(tv.vault);
    const note = await readNote(tv.vault, 'h.md');
    expect(tasks[0]?.hash).toBe(note.hash);
  });

  it('ignores non-task checkboxes and custom statuses', async () => {
    await writeFile(
      tv.dir,
      'n.md',
      'plain line\n- not a task\n- [-] cancelled\n- [/] in progress\n- [ ] real\n',
    );
    const { tasks } = await listTasks(tv.vault, { status: 'all' });
    expect(tasks.map((t) => t.text)).toEqual(['real']);
  });
});

describe('completeTask', () => {
  let tv: TempVault;

  beforeEach(async () => {
    tv = await makeTempVault();
  });

  afterEach(async () => {
    await cleanup(tv);
  });

  it('flips the checkbox and appends the done date', async () => {
    await writeFile(tv.dir, 't.md', '- [ ] ship it 📅 2026-08-03\n');
    const result = await completeTask(tv.vault, 't.md', 1, '2026-08-03');
    expect(result.alreadyDone).toBe(false);
    expect(result.taskLine).toBe('- [x] ship it 📅 2026-08-03 ✅ 2026-08-03');
    const raw = await fs.readFile(path.join(tv.dir, 't.md'), 'utf8');
    expect(raw).toBe('- [x] ship it 📅 2026-08-03 ✅ 2026-08-03\n');
  });

  it('preserves indentation and bullet style', async () => {
    await writeFile(tv.dir, 't.md', 'intro\n  * [ ] nested\n');
    const result = await completeTask(tv.vault, 't.md', 2, '2026-08-03');
    expect(result.taskLine).toBe('  * [x] nested ✅ 2026-08-03');
  });

  it('is a no-op on an already-done task', async () => {
    await writeFile(tv.dir, 't.md', '- [x] done ✅ 2026-08-01\n');
    const before = await fs.readFile(path.join(tv.dir, 't.md'), 'utf8');
    const result = await completeTask(tv.vault, 't.md', 1);
    expect(result.alreadyDone).toBe(true);
    expect(await fs.readFile(path.join(tv.dir, 't.md'), 'utf8')).toBe(before);
  });

  it('surfaces the recurrence so the caller can warn', async () => {
    await writeFile(tv.dir, 't.md', '- [ ] water plants 🔁 every week 📅 2026-08-03\n');
    const result = await completeTask(tv.vault, 't.md', 1, '2026-08-03');
    expect(result.recurrence).toBe('every week');
  });

  it('rejects a line that is not a task and an out-of-range line', async () => {
    await writeFile(tv.dir, 't.md', 'not a task\n- [ ] task\n');
    await expectVaultError(completeTask(tv.vault, 't.md', 1), 'NOT_A_TASK');
    await expectVaultError(completeTask(tv.vault, 't.md', 99), 'NOT_A_TASK');
  });

  it('honors expectedHash', async () => {
    await writeFile(tv.dir, 't.md', '- [ ] guard\n');
    await expectVaultError(
      completeTask(tv.vault, 't.md', 1, undefined, { expectedHash: 'deadbeef0000' }),
      'CONFLICT',
    );
  });
});

describe('postponeTask', () => {
  let tv: TempVault;

  beforeEach(async () => {
    tv = await makeTempVault();
  });

  afterEach(async () => {
    await cleanup(tv);
  });

  it('replaces an existing due date', async () => {
    await writeFile(tv.dir, 't.md', '- [ ] report 📅 2026-08-03 ⏫\n');
    const result = await postponeTask(tv.vault, 't.md', 1, '2026-08-10');
    expect(result.previousDue).toBe('2026-08-03');
    expect(result.taskLine).toBe('- [ ] report 📅 2026-08-10 ⏫');
  });

  it('adds a due date to a task without one', async () => {
    await writeFile(tv.dir, 't.md', '- [ ] someday\n');
    const result = await postponeTask(tv.vault, 't.md', 1, '2026-08-10');
    expect(result.previousDue).toBeUndefined();
    expect(result.taskLine).toBe('- [ ] someday 📅 2026-08-10');
  });

  it('rejects a malformed date', async () => {
    await writeFile(tv.dir, 't.md', '- [ ] x\n');
    await expectVaultError(postponeTask(tv.vault, 't.md', 1, '10/08/2026'), 'INVALID_PATH');
  });

  it('rejects impossible calendar dates', async () => {
    await writeFile(tv.dir, 't.md', '- [ ] x\n');
    await expectVaultError(postponeTask(tv.vault, 't.md', 1, '2026-02-30'), 'INVALID_PATH');
    await expectVaultError(completeTask(tv.vault, 't.md', 1, '2026-13-01'), 'INVALID_PATH');
    await expectVaultError(
      listTasks(tv.vault, { dueBefore: '2025-02-29' }),
      'INVALID_PATH',
    );
  });
});
