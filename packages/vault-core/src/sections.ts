import { promises as fs } from 'node:fs';
import type { Vault, WriteGuardOptions } from './types.js';
import { VaultError } from './errors.js';
import { contentHash, replaceNoteContent } from './io.js';
import { isFsError, resolveNotePath } from './paths.js';

interface Heading {
  /** 0-based line index. */
  line: number;
  level: number;
  /** Heading text without the leading #'s, trimmed. */
  text: string;
}

const FENCE_RE = /^(\s{0,3})(`{3,}|~{3,})/;
const HEADING_RE = /^(#{1,6})\s+(.*?)\s*#*\s*$/;

/**
 * Scan markdown for ATX headings, ignoring lines inside ``` / ~~~ fences —
 * a `# comment` inside a dataviewjs block is not a heading.
 */
export function scanHeadings(lines: readonly string[]): Heading[] {
  const headings: Heading[] = [];
  let fence: string | null = null;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    const fenceMatch = FENCE_RE.exec(line);
    if (fenceMatch !== null) {
      const marker = (fenceMatch[2] ?? '')[0] ?? '`';
      if (fence === null) {
        fence = marker;
      } else if (marker === fence) {
        fence = null;
      }
      continue;
    }
    if (fence !== null) continue;
    const m = HEADING_RE.exec(line);
    if (m !== null) {
      headings.push({ line: i, level: (m[1] ?? '#').length, text: (m[2] ?? '').trim() });
    }
  }
  return headings;
}

/** Case-insensitive heading comparison, tolerant of leading #'s in the query. */
function headingMatches(headingText: string, query: string): boolean {
  const q = query.replace(/^#+\s*/, '').trim().toLowerCase();
  return headingText.toLowerCase() === q;
}

/**
 * Insert content at the END of a heading's section — after the section's last
 * non-blank line, before the next heading of the same or higher level. This is
 * what makes "capture into ## Inbox" land inside the section instead of after
 * the dataviewjs block at the bottom of the file.
 */
export async function appendToSection(
  vault: Vault,
  relPath: string,
  heading: string,
  content: string,
  opts: WriteGuardOptions = {},
): Promise<{ path: string; sizeBytes: number; hash: string; insertedAtLine: number }> {
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
  if (opts.expectedHash !== undefined && contentHash(raw) !== opts.expectedHash) {
    throw new VaultError(
      'CONFLICT',
      `note "${relPath}" changed since it was read; re-read the note and retry`,
    );
  }

  const lines = raw.toString('utf8').split('\n');
  const headings = scanHeadings(lines);

  const target = headings.find((h) => headingMatches(h.text, heading));
  if (target === undefined) {
    const available = headings.map((h) => `${'#'.repeat(h.level)} ${h.text}`);
    throw new VaultError(
      'SECTION_NOT_FOUND',
      `heading "${heading}" not found in "${relPath}"` +
        (available.length > 0 ? `; available: ${available.join(' | ')}` : ''),
    );
  }

  const next = headings.find((h) => h.line > target.line && h.level <= target.level);
  // Insertion point: just after the last non-blank line of the section.
  let end = next !== undefined ? next.line : lines.length;
  while (end > target.line + 1 && (lines[end - 1] ?? '').trim() === '') {
    end -= 1;
  }

  const inserted = content.replace(/\n$/, '').split('\n');
  const updated = [...lines.slice(0, end), ...inserted, ...lines.slice(end)];
  let result = updated.join('\n');
  if (!result.endsWith('\n')) result += '\n';

  const written = await replaceNoteContent(vault, relPath, result);
  return { ...written, insertedAtLine: end + 1 };
}
