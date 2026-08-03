import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import type { DailyNoteInfo, Vault } from './types.js';
import { VaultError } from './errors.js';
import { resolveNotePath } from './paths.js';
import { readNote } from './io.js';

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

const WEEKDAYS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;

// Longest-first within each letter family so e.g. YYYY wins over YY.
const TOKENS = ['YYYY', 'YY', 'MMMM', 'MMM', 'MM', 'M', 'dddd', 'ddd', 'DD', 'D'] as const;

function pad(n: number, width: number): string {
  return String(n).padStart(width, '0');
}

function renderToken(token: string, date: Date): string {
  switch (token) {
    case 'YYYY':
      return pad(date.getFullYear(), 4);
    case 'YY':
      return pad(date.getFullYear() % 100, 2);
    case 'MMMM':
      return MONTHS[date.getMonth()] ?? '';
    case 'MMM':
      return (MONTHS[date.getMonth()] ?? '').slice(0, 3);
    case 'MM':
      return pad(date.getMonth() + 1, 2);
    case 'M':
      return String(date.getMonth() + 1);
    case 'DD':
      return pad(date.getDate(), 2);
    case 'D':
      return String(date.getDate());
    case 'dddd':
      return WEEKDAYS[date.getDay()] ?? '';
    case 'ddd':
      return (WEEKDAYS[date.getDay()] ?? '').slice(0, 3);
    default:
      return token;
  }
}

/**
 * Moment-subset formatter: YYYY YY MMMM MMM MM M DD D dddd ddd, with
 * [literal] bracket escapes. en-US names. Unknown characters pass through.
 */
export function formatDailyName(format: string, date: Date): string {
  let out = '';
  let i = 0;
  while (i < format.length) {
    const ch = format[i] ?? '';
    if (ch === '[') {
      const close = format.indexOf(']', i + 1);
      if (close === -1) {
        out += format.slice(i + 1);
        break;
      }
      out += format.slice(i + 1, close);
      i = close + 1;
      continue;
    }
    const token = TOKENS.find((t) => format.startsWith(t, i));
    if (token !== undefined) {
      out += renderToken(token, date);
      i += token.length;
    } else {
      out += ch;
      i += 1;
    }
  }
  return out;
}

interface DailyNotesConfig {
  folder: string;
  format: string;
}

const DEFAULT_CONFIG: DailyNotesConfig = { folder: '', format: 'YYYY-MM-DD' };

/**
 * Trusted internal read of <root>/.obsidian/daily-notes.json — deliberately
 * not routed through resolveNotePath. Missing or invalid → Obsidian defaults.
 */
async function readDailyConfig(vault: Vault): Promise<DailyNotesConfig> {
  let raw: string;
  try {
    raw = await fs.readFile(
      path.join(vault.root, '.obsidian', 'daily-notes.json'),
      'utf8',
    );
  } catch {
    return DEFAULT_CONFIG;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return DEFAULT_CONFIG;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return DEFAULT_CONFIG;
  }
  const obj = parsed as Record<string, unknown>;
  const folder = typeof obj['folder'] === 'string' ? obj['folder'] : DEFAULT_CONFIG.folder;
  const format =
    typeof obj['format'] === 'string' && obj['format'].trim().length > 0
      ? obj['format']
      : DEFAULT_CONFIG.format;
  return { folder, format };
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Parse YYYY-MM-DD (or default to today), constructing at local noon. */
function resolveDate(date: string | undefined): Date {
  if (date === undefined) {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12, 0, 0, 0);
  }
  const match = DATE_RE.exec(date);
  if (match === null) {
    throw new VaultError('INVALID_PATH', `invalid date "${date}": expected YYYY-MM-DD`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const d = new Date(year, month - 1, day, 12, 0, 0, 0);
  if (d.getFullYear() !== year || d.getMonth() !== month - 1 || d.getDate() !== day) {
    throw new VaultError('INVALID_PATH', `invalid date "${date}": not a real calendar date`);
  }
  return d;
}

/** The resolved day as YYYY-MM-DD, independent of the configured format. */
function isoDay(date: Date): string {
  return `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1, 2)}-${pad(
    date.getDate(),
    2,
  )}`;
}

export async function getDailyNote(vault: Vault, date?: string): Promise<DailyNoteInfo> {
  const config = await readDailyConfig(vault);
  const day = resolveDate(date);
  const resolvedDate = isoDay(day);

  const name = formatDailyName(config.format, day);
  const folder = config.folder.trim().replace(/^\/+/, '').replace(/\/+$/, '');
  const relPath = (folder.length > 0 ? `${folder}/` : '') + name + '.md';

  // forCreate resolution: validates containment (a hostile config surfaces as
  // a VaultError, never an escape) while tolerating missing intermediate
  // folders, so an absent daily note reports exists:false instead of throwing.
  // Nothing is ever created here.
  const abs = await resolveNotePath(vault, relPath, { forCreate: true });

  let exists = false;
  try {
    const st = await fs.stat(abs);
    exists = st.isFile();
  } catch {
    exists = false;
  }

  if (!exists) {
    return { path: relPath, date: resolvedDate, exists: false };
  }
  const note = await readNote(vault, relPath);
  return { path: relPath, date: resolvedDate, exists: true, note };
}
