import { promises as fs } from 'node:fs';
import type {
  ListTasksOptions,
  ListTasksResult,
  TaskItem,
  TaskPriority,
  Vault,
  WriteGuardOptions,
} from './types.js';
import { VaultError } from './errors.js';
import { contentHash, replaceNoteContent } from './io.js';
import { isFsError, resolveNotePath } from './paths.js';
import { walkMarkdownFiles } from './search.js';

const MAX_TASK_FILE_BYTES = 5_000_000;
const TASK_LIMIT_CAP = 100;

/** `- [ ] text` with -, *, + or `1.` bullets and any single status char. */
const TASK_LINE_RE = /^(\s*)((?:[-*+]|\d+[.)])\s+)\[(.)\]\s+(.*)$/;

const DUE_RE = /📅\s*(\d{4}-\d{2}-\d{2})/u;
const SCHEDULED_RE = /⏳\s*(\d{4}-\d{2}-\d{2})/u;
const START_RE = /🛫\s*(\d{4}-\d{2}-\d{2})/u;
const DONE_DATE_RE = /✅\s*(\d{4}-\d{2}-\d{2})/u;
const CREATED_RE = /➕\s*(\d{4}-\d{2}-\d{2})/u;
const CANCELLED_RE = /❌\s*(\d{4}-\d{2}-\d{2})/u;
/** Recurrence text runs until the next signifier emoji or end of line. */
const RECURRENCE_RE = /🔁\s*([^📅⏳🛫✅➕❌🔺⏫🔼🔽⏬🔁]*)/u;

const PRIORITY_SIGNIFIERS: ReadonlyArray<readonly [string, TaskPriority]> = [
  ['🔺', 'highest'],
  ['⏫', 'high'],
  ['🔼', 'medium'],
  ['🔽', 'low'],
  ['⏬', 'lowest'],
];

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function assertDay(value: string, label: string): void {
  if (!DAY_RE.test(value)) {
    throw new VaultError('INVALID_PATH', `${label} must be YYYY-MM-DD, got "${value}"`);
  }
}

interface ParsedTaskLine {
  indent: string;
  bullet: string;
  statusChar: string;
  /** Raw text after the checkbox, signifiers included. */
  rest: string;
}

export function parseTaskLine(line: string): ParsedTaskLine | null {
  const m = TASK_LINE_RE.exec(line);
  if (m === null) return null;
  return {
    indent: m[1] ?? '',
    bullet: m[2] ?? '- ',
    statusChar: m[3] ?? ' ',
    rest: m[4] ?? '',
  };
}

/** Parse Tasks-plugin signifiers out of a task's text. */
function parseSignifiers(rest: string): Omit<TaskItem, 'path' | 'line' | 'done' | 'hash'> {
  const due = DUE_RE.exec(rest)?.[1];
  const scheduled = SCHEDULED_RE.exec(rest)?.[1];
  const start = START_RE.exec(rest)?.[1];
  const doneDate = DONE_DATE_RE.exec(rest)?.[1];
  let priority: TaskPriority | undefined;
  for (const [emoji, name] of PRIORITY_SIGNIFIERS) {
    if (rest.includes(emoji)) {
      priority = name;
      break;
    }
  }
  const recurrence = RECURRENCE_RE.exec(rest)?.[1]?.trim() || undefined;

  let text = rest
    .replace(DUE_RE, '')
    .replace(SCHEDULED_RE, '')
    .replace(START_RE, '')
    .replace(DONE_DATE_RE, '')
    .replace(CREATED_RE, '')
    .replace(CANCELLED_RE, '')
    .replace(RECURRENCE_RE, '');
  for (const [emoji] of PRIORITY_SIGNIFIERS) {
    text = text.split(emoji).join('');
  }
  text = text.replace(/\s+/g, ' ').trim();

  return {
    text,
    ...(due !== undefined ? { due } : {}),
    ...(scheduled !== undefined ? { scheduled } : {}),
    ...(start !== undefined ? { start } : {}),
    ...(doneDate !== undefined ? { doneDate } : {}),
    ...(priority !== undefined ? { priority } : {}),
    ...(recurrence !== undefined ? { recurrence } : {}),
  };
}

/**
 * Statuses beyond open/done (cancelled `-`, in-progress `/`, custom) are
 * skipped: they are neither actionable nor "done" in the filtering sense.
 */
function taskFromLine(
  path: string,
  lineNo: number,
  line: string,
  hash: string,
): TaskItem | null {
  const parsed = parseTaskLine(line);
  if (parsed === null) return null;
  const open = parsed.statusChar === ' ';
  const done = parsed.statusChar === 'x' || parsed.statusChar === 'X';
  if (!open && !done) return null;
  return { path, line: lineNo, hash, done, ...parseSignifiers(parsed.rest) };
}

export async function listTasks(
  vault: Vault,
  opts: ListTasksOptions = {},
): Promise<ListTasksResult> {
  const status = opts.status ?? 'open';
  const limit = Math.max(1, Math.min(TASK_LIMIT_CAP, Math.floor(opts.limit ?? 50)));
  const offset = Math.max(0, Math.floor(opts.offset ?? 0));
  if (opts.dueBefore !== undefined) assertDay(opts.dueBefore, 'due_before');
  if (opts.dueAfter !== undefined) assertDay(opts.dueAfter, 'due_after');
  const prefix = opts.pathPrefix?.replace(/^\/+/, '').replace(/\/+$/, '');

  const files = await walkMarkdownFiles(vault, {
    excludeLowTrust: opts.includeLowTrust !== true,
  });
  const selected = files.filter(
    (f) =>
      prefix === undefined ||
      prefix === '' ||
      f.rel === prefix ||
      f.rel.startsWith(prefix + '/'),
  );

  const all: TaskItem[] = [];
  for (const file of selected) {
    if (file.sizeBytes > MAX_TASK_FILE_BYTES) continue;
    let content: string;
    try {
      content = await fs.readFile(file.abs, 'utf8');
    } catch {
      continue;
    }
    const hash = contentHash(content);
    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      const task = taskFromLine(file.rel, i + 1, lines[i] ?? '', hash);
      if (task === null) continue;
      if (status === 'open' && task.done) continue;
      if (status === 'done' && !task.done) continue;
      if (opts.dueBefore !== undefined && (task.due === undefined || task.due > opts.dueBefore)) {
        continue;
      }
      if (opts.dueAfter !== undefined && (task.due === undefined || task.due < opts.dueAfter)) {
        continue;
      }
      all.push(task);
    }
  }

  // Earliest due first; tasks without a due date last; then stable by note.
  all.sort((a, b) => {
    const ad = a.due ?? '9999-99-99';
    const bd = b.due ?? '9999-99-99';
    if (ad !== bd) return ad < bd ? -1 : 1;
    if (a.path !== b.path) return a.path < b.path ? -1 : 1;
    return a.line - b.line;
  });

  return {
    tasks: all.slice(offset, offset + limit),
    hasMore: all.length > offset + limit,
  };
}

interface TaskWriteTarget {
  lines: string[];
  parsed: ParsedTaskLine;
  raw: Buffer;
}

async function loadTaskLine(
  vault: Vault,
  relPath: string,
  lineNo: number,
  expectedHash: string | undefined,
): Promise<TaskWriteTarget> {
  const abs = await resolveNotePath(vault, relPath);
  let raw: Buffer;
  try {
    raw = await fs.readFile(abs);
  } catch (err) {
    if (isFsError(err, 'ENOENT')) {
      throw new VaultError('NOT_FOUND', `note "${relPath}" not found`);
    }
    throw err;
  }
  if (expectedHash !== undefined && contentHash(raw) !== expectedHash) {
    throw new VaultError(
      'CONFLICT',
      `note "${relPath}" changed since it was read; re-read (or re-list tasks) and retry`,
    );
  }
  const lines = raw.toString('utf8').split('\n');
  if (!Number.isInteger(lineNo) || lineNo < 1 || lineNo > lines.length) {
    throw new VaultError(
      'NOT_A_TASK',
      `line ${lineNo} is out of range for "${relPath}" (${lines.length} lines)`,
    );
  }
  const parsed = parseTaskLine(lines[lineNo - 1] ?? '');
  if (parsed === null) {
    throw new VaultError(
      'NOT_A_TASK',
      `line ${lineNo} of "${relPath}" is not a task checkbox; ` +
        'list_tasks reports exact line numbers — the note may have changed',
    );
  }
  return { lines, parsed, raw };
}

function localToday(): string {
  const now = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * Mark a task done the way the Tasks plugin does: flip `[ ]` to `[x]` and
 * append `✅ YYYY-MM-DD`. Recurring tasks (🔁) are completed but the next
 * occurrence is NOT generated; the returned recurrence lets the caller say so.
 */
export async function completeTask(
  vault: Vault,
  relPath: string,
  lineNo: number,
  doneDate?: string,
  opts: WriteGuardOptions = {},
): Promise<{
  path: string;
  line: number;
  taskLine: string;
  hash: string;
  alreadyDone: boolean;
  recurrence?: string;
}> {
  if (doneDate !== undefined) assertDay(doneDate, 'done_date');
  const { lines, parsed, raw } = await loadTaskLine(
    vault,
    relPath,
    lineNo,
    opts.expectedHash,
  );

  const meta = parseSignifiers(parsed.rest);
  if (parsed.statusChar === 'x' || parsed.statusChar === 'X') {
    return {
      path: relPath,
      line: lineNo,
      taskLine: lines[lineNo - 1] ?? '',
      hash: contentHash(raw),
      alreadyDone: true,
      ...(meta.recurrence !== undefined ? { recurrence: meta.recurrence } : {}),
    };
  }
  if (parsed.statusChar !== ' ') {
    throw new VaultError(
      'NOT_A_TASK',
      `line ${lineNo} of "${relPath}" has status "[${parsed.statusChar}]", not an open task`,
    );
  }

  let rest = parsed.rest.trimEnd();
  if (!DONE_DATE_RE.test(rest)) {
    rest += ` ✅ ${doneDate ?? localToday()}`;
  }
  const updated = `${parsed.indent}${parsed.bullet}[x] ${rest}`;
  lines[lineNo - 1] = updated;
  const written = await replaceNoteContent(vault, relPath, lines.join('\n'));

  return {
    path: written.path,
    line: lineNo,
    taskLine: updated,
    hash: written.hash,
    alreadyDone: false,
    ...(meta.recurrence !== undefined ? { recurrence: meta.recurrence } : {}),
  };
}

/**
 * Change (or set) a task's 📅 due date, writing the signifier in the exact
 * format the Tasks plugin expects.
 */
export async function postponeTask(
  vault: Vault,
  relPath: string,
  lineNo: number,
  newDate: string,
  opts: WriteGuardOptions = {},
): Promise<{
  path: string;
  line: number;
  taskLine: string;
  hash: string;
  previousDue?: string;
}> {
  assertDay(newDate, 'new_date');
  const { lines, parsed } = await loadTaskLine(vault, relPath, lineNo, opts.expectedHash);

  const previousDue = DUE_RE.exec(parsed.rest)?.[1];
  let rest: string;
  if (previousDue !== undefined) {
    rest = parsed.rest.replace(DUE_RE, `📅 ${newDate}`);
  } else {
    rest = `${parsed.rest.trimEnd()} 📅 ${newDate}`;
  }
  const updated = `${parsed.indent}${parsed.bullet}[${parsed.statusChar}] ${rest}`;
  lines[lineNo - 1] = updated;
  const written = await replaceNoteContent(vault, relPath, lines.join('\n'));

  return {
    path: written.path,
    line: lineNo,
    taskLine: updated,
    hash: written.hash,
    ...(previousDue !== undefined ? { previousDue } : {}),
  };
}
