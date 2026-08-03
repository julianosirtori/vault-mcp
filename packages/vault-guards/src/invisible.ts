/**
 * Shared character tables for content that is invisible to a human reader
 * but fully visible to a language model.
 *
 * Threat model (ARCHITECTURE.md §5.3): vault content is untrusted input and
 * the dominant threat is prompt injection hidden from the human. The defense
 * is channel closure, not detection — so both the read-path and write-path
 * sanitizers strip these characters unconditionally.
 */

/** Result report shared by both sanitizers. */
export interface SanitizationReport {
  /** Human-readable notes, e.g. "removed 2 HTML comments". Empty = clean. */
  removed: string[];
}

/** Sanitized output shared by both sanitizers. */
export interface SanitizedContent {
  content: string;
  report: SanitizationReport;
}

/**
 * Zero-width and control characters usable to hide or reorder text:
 * - U+00AD  soft hyphen
 * - U+200B–U+200F  zero-width space/non-joiner/joiner, LRM, RLM
 * - U+202A–U+202E  bidi embedding and override controls (incl. RLO)
 * - U+2060–U+2064  word joiner, invisible operators
 * - U+FEFF  zero-width no-break space / BOM
 */
export const INVISIBLE_CHAR_RE =
  /[\u00AD\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/gu;

/**
 * The Unicode tag block (U+E0000–U+E007F): a complete invisible copy of
 * ASCII. This is the "invisible instructions" alphabet — whole sentences can
 * be encoded here, render as nothing, and still be read by a model.
 */
export const TAG_BLOCK_RE = /[\u{E0000}-\u{E007F}]/gu;

export interface StripResult {
  content: string;
  /** Number of code points removed. */
  count: number;
}

function stripAll(text: string, re: RegExp): StripResult {
  let count = 0;
  const content = text.replace(re, () => {
    count += 1;
    return '';
  });
  return { content, count };
}

/** Remove every character from the invisible-character table. */
export function stripInvisibleChars(text: string): StripResult {
  return stripAll(text, INVISIBLE_CHAR_RE);
}

/** Remove every character from the Unicode tag block. */
export function stripTagBlockChars(text: string): StripResult {
  return stripAll(text, TAG_BLOCK_RE);
}

/** Pluralization helper for report messages. */
export function plural(n: number, singular: string, pluralForm?: string): string {
  return n === 1 ? singular : (pluralForm ?? `${singular}s`);
}
