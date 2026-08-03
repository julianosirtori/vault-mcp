import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import type { CreateDailyResult, DailyNoteInfo, Vault } from './types.js';
import { VaultError } from './errors.js';
import { resolveNotePath } from './paths.js';
import { createNote, readNote } from './io.js';

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
const TEMPLATE_TIME_TOKENS = [
  ...TOKENS,
  'HH',
  'H',
  'hh',
  'h',
  'mm',
  'm',
  'ss',
  's',
  'A',
  'a',
] as const;

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

function renderTemplateTimeToken(token: string, date: Date): string {
  const hours = date.getHours();
  switch (token) {
    case 'HH':
      return pad(hours, 2);
    case 'H':
      return String(hours);
    case 'hh':
      return pad(hours % 12 || 12, 2);
    case 'h':
      return String(hours % 12 || 12);
    case 'mm':
      return pad(date.getMinutes(), 2);
    case 'm':
      return String(date.getMinutes());
    case 'ss':
      return pad(date.getSeconds(), 2);
    case 's':
      return String(date.getSeconds());
    case 'A':
      return hours < 12 ? 'AM' : 'PM';
    case 'a':
      return hours < 12 ? 'am' : 'pm';
    default:
      return renderToken(token, date);
  }
}

function formatTokens(
  format: string,
  date: Date,
  tokens: readonly string[],
  render: (token: string, date: Date) => string,
): string {
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
    const token = tokens.find((candidate) => format.startsWith(candidate, i));
    if (token !== undefined) {
      out += render(token, date);
      i += token.length;
    } else {
      out += ch;
      i += 1;
    }
  }
  return out;
}

/**
 * Moment-subset formatter: YYYY YY MMMM MMM MM M DD D dddd ddd, with
 * [literal] bracket escapes. en-US names. Unknown characters pass through.
 */
export function formatDailyName(format: string, date: Date): string {
  return formatTokens(format, date, TOKENS, renderToken);
}

interface DailyNotesConfig {
  folder: string;
  format: string;
  /** Vault-relative template note path, possibly without .md. '' = none. */
  template: string;
}

const DEFAULT_CONFIG: DailyNotesConfig = { folder: '', format: 'YYYY-MM-DD', template: '' };

/** Trusted internal read of a JSON file under <root>/.obsidian. */
async function readJson(vault: Vault, ...segments: string[]): Promise<Record<string, unknown> | null> {
  let raw: string;
  try {
    raw = await fs.readFile(path.join(vault.root, '.obsidian', ...segments), 'utf8');
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  return parsed as Record<string, unknown>;
}

function configFrom(obj: Record<string, unknown>): DailyNotesConfig | null {
  const folder = typeof obj['folder'] === 'string' ? obj['folder'] : '';
  const format =
    typeof obj['format'] === 'string' && obj['format'].trim().length > 0
      ? obj['format']
      : '';
  const template = typeof obj['template'] === 'string' ? obj['template'] : '';
  if (folder === '' && format === '' && template === '') return null;
  return {
    folder,
    format: format === '' ? DEFAULT_CONFIG.format : format,
    template,
  };
}

/**
 * Resolve the daily-notes settings the way Obsidian does, deliberately not
 * routed through resolveNotePath. Two sources, in order:
 *
 *  1. core Daily Notes plugin: .obsidian/daily-notes.json
 *  2. Periodic Notes plugin:   .obsidian/plugins/periodic-notes/data.json
 *     (its `daily` section) — many vaults configure ONLY this one, and
 *     ignoring it resolved daily notes to the vault root with the default
 *     format instead of the user's journal folder.
 *
 * Missing or invalid everywhere → Obsidian defaults.
 */
async function readDailyConfig(vault: Vault): Promise<DailyNotesConfig> {
  const core = await readJson(vault, 'daily-notes.json');
  if (core !== null) {
    const config = configFrom(core);
    if (config !== null) return config;
  }

  const periodic = await readJson(vault, 'plugins', 'periodic-notes', 'data.json');
  if (periodic !== null) {
    const daily = periodic['daily'];
    if (typeof daily === 'object' && daily !== null && !Array.isArray(daily)) {
      const section = daily as Record<string, unknown>;
      if (section['enabled'] !== false) {
        const config = configFrom(section);
        if (config !== null) return config;
      }
    }
  }

  return DEFAULT_CONFIG;
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

/**
 * Render the {{...}} placeholders Obsidian's core templates use in daily
 * notes: {{title}}, {{date}}, {{time}} and {{date:FORMAT}} / {{time:FORMAT}}.
 * Formatted time additionally supports H/HH, h/hh, m/mm, s/ss and A/a.
 * Unknown placeholders are left untouched — better visible than silently eaten.
 */
export function renderDailyTemplate(template: string, day: Date, title: string): string {
  const now = new Date();
  const hhmm = `${pad(now.getHours(), 2)}:${pad(now.getMinutes(), 2)}`;
  return template.replace(
    /\{\{\s*(title|date|time)\s*(?::([^}]+))?\}\}/gi,
    (whole, name: string, format: string | undefined) => {
      switch (name.toLowerCase()) {
        case 'title':
          return title;
        case 'date':
          return format !== undefined ? formatDailyName(format, day) : isoDay(day);
        case 'time':
          return format !== undefined
            ? formatTokens(format.trim(), now, TEMPLATE_TIME_TOKENS, renderTemplateTimeToken)
            : hhmm;
        default:
          return whole as string;
      }
    },
  );
}

/**
 * Create the daily note for a date (default: today) at the configured
 * location, seeding it from the configured daily-notes template when there is
 * one. Idempotent: an existing note is left untouched and reported as such.
 */
export async function createDailyNote(
  vault: Vault,
  date?: string,
): Promise<CreateDailyResult> {
  const config = await readDailyConfig(vault);
  const info = await getDailyNote(vault, date);
  if (info.exists) {
    return { path: info.path, date: info.date, created: false, templateApplied: false };
  }

  let content = '';
  let templateApplied = false;
  const templateSetting = config.template.trim().replace(/^\/+/, '');
  if (templateSetting.length > 0) {
    const candidates = /\.md$/i.test(templateSetting)
      ? [templateSetting]
      : [`${templateSetting}.md`];
    for (const candidate of candidates) {
      try {
        const template = await readNote(vault, candidate);
        const day = resolveDate(date);
        const title = path.basename(info.path, '.md');
        content = renderDailyTemplate(template.content, day, title);
        templateApplied = true;
        break;
      } catch {
        // Missing or invalid template → create the note empty rather than
        // failing the capture; the result says the template was not applied.
      }
    }
  }

  const result = await createNote(vault, info.path, content);
  return { path: result.path, date: info.date, created: true, templateApplied };
}
